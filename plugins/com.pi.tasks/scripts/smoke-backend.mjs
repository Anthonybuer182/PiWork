#!/usr/bin/env node
/**
 * Drive the built backend with a fake host port — no Electron, no app.
 *
 * This runs `dist/main.mjs`, the artifact that actually ships, against a stub
 * that answers the same `call` messages the host does. It is the cheapest way to
 * catch the failures that make a plugin look dead in the UI: a bundle that
 * throws on import, an `init` that never renders, a tool that returns nothing.
 *
 * Usage: node scripts/smoke-backend.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ── a stand-in for the host ──
const store = {};
const notifications = [];
const sentToChat = [];
const badges = [];
/** Every message the backend posted, for asserting on the handshake itself. */
const hostSaw = [];
let hostListener = null;

const port = {
  postMessage(msg) {
    // A message the backend sends *to* the host arrives here.
    queueMicrotask(() => handleFromBackend(msg));
  },
  on(_event, listener) {
    hostListener = listener;
  },
};

function sendToBackend(msg, ports) {
  hostListener?.({ data: msg, ports });
}

function handleFromBackend(msg) {
  hostSaw.push(msg);
  switch (msg.type) {
    case 'ready':
      sendToBackend({ type: 'init', pluginId: 'com.pi.tasks', apiVersion: 2, dataDir: '/tmp/pi-tasks-smoke' });
      break;
    case 'log':
      if (msg.level === 'error') console.log(`  [backend error] ${msg.message}`);
      break;
    case 'call':
      respondToCall(msg);
      break;
    case 'tool-result':
      current?.resolve(msg);
      break;
    default:
      break;
  }
}

function respondToCall(msg) {
  const { id, method, params } = msg;
  let result;
  let error;
  try {
    switch (method) {
      case 'storage.get':
        result = store[params.key];
        break;
      case 'storage.set':
        store[params.key] = params.value;
        result = { ok: true };
        break;
      case 'notify.show':
        notifications.push(params);
        result = { ok: true };
        break;
      case 'chat.send':
        sentToChat.push(params.text);
        result = { ok: true };
        break;
      case 'panel.open':
        result = { ok: true };
        break;
      case 'panel.setStatus':
        badges.push(params);
        result = { ok: true };
        break;
      default:
        result = { ok: true };
    }
  } catch (err) {
    error = String(err);
  }
  sendToBackend({ type: 'call-result', id, result, error });
}

/**
 * Call a tool and wait for its result.
 *
 * `call` is the context main attaches: `{ sessionId, workspaceId }`. Omitting
 * it is exactly what a direct/test invocation looks like, and it must behave
 * the same as an agent call from a session the host could not place.
 */
let current = null;
let seq = 0;
function callTool(name, params, call) {
  return new Promise((resolve, reject) => {
    const id = 't' + ++seq;
    current = { resolve, reject };
    sendToBackend({ type: 'tool-call', id, name, params, ...(call ?? {}) });
    setTimeout(() => reject(new Error(`tool ${name} timed out`)), 5000);
  });
}

/** Ask the backend a panel request over the data-plane port. */
function uiRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'u' + ++seq;
    pendingUi.set(id, { resolve, reject });
    uiSend({ kind: 'request', id, method, params });
    setTimeout(() => reject(new Error(`ui request ${method} timed out`)), 5000);
  });
}

const pendingUi = new Map();
let uiSend = () => {};

// The backend only accepts a UI port once it has one; wire both ends together.
const { port1, port2 } = (() => {
  // A minimal entangled pair: postMessage on one side reaches the other.
  const a = { listeners: [], postMessage: (m) => queueMicrotask(() => b.listeners.forEach((l) => l({ data: m }))), on: (_e, l) => a.listeners.push(l), start() {} };
  const b = { listeners: [], postMessage: (m) => queueMicrotask(() => a.listeners.forEach((l) => l({ data: m }))), on: (_e, l) => b.listeners.push(l), start() {} };
  return { port1: a, port2: b };
})();

function attachUi() {
  uiSend = (payload) => port2.postMessage(payload);
  port2.on('message', (ev) => {
    const p = ev.data;
    if (p?.kind === 'response') {
      const entry = pendingUi.get(p.id);
      if (entry) {
        pendingUi.delete(p.id);
        p.error ? entry.reject(new Error(p.error)) : entry.resolve(p.result);
      }
    }
  });
  sendToBackend({ type: 'ui-port' }, [port1]);
}

// ── run ──

console.log('━━━ smoke: dist/main.mjs against a fake host\n');

// The SDK takes the host port at import time and throws without one, so the
// fake has to be in place *before* the module loads. This is the same shape the
// SDK's own smoke test uses — the backend has no `main()` to call any more.
process.parentPort = port;
await import(pathToFileURL(join(ROOT, 'dist/main.mjs')).href);

await new Promise((r) => setTimeout(r, 50));
check('the backend announced readiness on load', hostSaw.some((m) => m.type === 'ready'));

attachUi();
await new Promise((r) => setTimeout(r, 200));
check('the backend loaded its stored state on init', store.tasks !== undefined);

// ── tools ──

const add = await callTool('item_add', { title: '交周报', when: '2026-09-30 14:00' });
const addText = add.content?.[0]?.text ?? '';
check('item_add stored the item', Array.isArray(store.tasks?.items) && store.tasks.items.length === 1, addText);
check('item_add echoed the parsed time', /14:00/.test(addText), addText);
check('item_add returned a declarative card', add.card?.component === 'Card');

const vague = await callTool('item_add', { title: '随便', when: '看情况' }).catch((e) => ({ error: e.message }));
check('an unreadable time is refused, not stored as text', Boolean(vague.error), JSON.stringify(vague));

const rel = await callTool('item_add', { title: '后天的事', when: '后天下午3点' });
check('free-text 后天 resolves to a real instant', /15:00/.test(rel.content?.[0]?.text ?? ''), rel.content?.[0]?.text);

const recurring = await callTool('item_add', {
  title: '每日站会',
  when: '2026-09-28 09:00',
  repeat: 'daily',
  remindBefore: 15,
});
check('a repeat rule is stored as an RRULE body', store.tasks.items.at(-1).rrule === 'FREQ=DAILY');
check('remindBefore became a trigger', store.tasks.items.at(-1).triggers?.length === 1);
check('the repeat is described back', /每天/.test(recurring.content?.[0]?.text ?? ''));

const agentTask = await callTool('item_add', { title: '每日汇报', when: '2026-09-28 09:05', repeat: 'daily', onDue: '总结昨天的提交' });
check('onDue became an agent trigger', store.tasks.items.at(-1).triggers?.[0]?.action?.kind === 'agent');

const noTime = await callTool('item_add', { title: '读书', when: '' });
check('an item with no time is allowed', store.tasks.items.at(-1).start === undefined);
check('an undated item carries no triggers or repeat', store.tasks.items.at(-1).triggers.length === 0);

const badRepeat = await callTool('item_add', { title: 'x', repeat: 'every other tuesday' }).catch((e) => ({ error: e.message }));
check('an unknown repeat is refused with guidance', /daily/.test(badRepeat.error ?? ''), badRepeat.error);

const list = await callTool('item_list', { range: 'all' });
check('item_list returns the items', /交周报/.test(list.content?.[0]?.text ?? ''));

const done = await callTool('item_update', { title: '交周报', done: true });
check('item_update marks done', store.tasks.items.find((i) => i.title === '交周报').completions.length === 1, done.content?.[0]?.text);

const removed = await callTool('item_remove', { title: '读书' });
check('item_remove deletes', !store.tasks.items.some((i) => i.title === '读书'), removed.content?.[0]?.text);

const missing = await callTool('item_remove', { title: '不存在的' }).catch((e) => ({ error: e.message }));
check('a missing item errors rather than silently doing nothing', /没找到/.test(missing.error ?? ''), missing.error);

// ── the panel interface ──

const state = await uiRequest('state.get');
check('state.get returns a view', Array.isArray(state?.items) && state.items.length > 0);
const row = state.items.find((i) => i.title === '每日站会');
check('the view carries a next firing time', Boolean(row?.nextFireAt), JSON.stringify(row));
check('the view describes the repeat', row?.repeatLabel === '每天', row?.repeatLabel);

const month = await uiRequest('month.get', { year: 2026, month: 8 });
check('month.get expands recurring items into days', Object.keys(month.byDay ?? {}).length > 0);

const week = await uiRequest('range.get', { from: '2026-09-27', to: '2026-10-03' });
check('range.get answers a week that straddles two months', Object.keys(week.byDay ?? {}).length > 0, JSON.stringify(week));
check(
  'range.get keeps each day under its own local date',
  Object.keys(week.byDay ?? {}).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  Object.keys(week.byDay ?? {}).join(','),
);
const badRange = await uiRequest('range.get', { from: '2026-10-03', to: '2026-09-27' }).catch((e) => ({ error: e.message }));
check('range.get refuses a range that runs backwards', Boolean(badRange.error));

await uiRequest('item.save', { title: '面板建的', start: '2026-10-01T10:00:00', allDay: false, triggers: [] });
check('item.save writes through the panel path', store.tasks.items.some((i) => i.title === '面板建的'));

// ── the daily note (回顾) ──

const wrote = await callTool('day_write', { day: '2026-09-30', text: '今天写了第一句。' });
check('day_write stores the day note', /今天写了第一句/.test(wrote.content?.[0]?.text ?? ''));

const appended = await callTool('day_write', { day: '2026-09-30', text: '又补了一句。' });
const afterAppend = appended.content?.[0]?.text ?? '';
check(
  'a second write APPENDS rather than clobbering the user’s words',
  /今天写了第一句/.test(afterAppend) && /又补了一句/.test(afterAppend),
  afterAppend,
);

const replaced = await callTool('day_write', { day: '2026-09-30', text: '全部重写。', mode: 'replace' });
const afterReplace = replaced.content?.[0]?.text ?? '';
check('mode=replace is honoured when explicitly asked for', /全部重写/.test(afterReplace) && !/第一句/.test(afterReplace), afterReplace);

const badDay = await callTool('day_write', { day: '下周三', text: 'x' }).catch((e) => ({ error: e.message }));
check('a malformed day is refused', /2026-09-30/.test(badDay.error ?? ''), badDay.error);

const emptyText = await callTool('day_write', { text: '   ' }).catch((e) => ({ error: e.message }));
check('an empty note is refused rather than silently clearing the day', Boolean(emptyText.error), JSON.stringify(emptyText));

// An undated to-do completed today must show up on the day it was finished.
const undated = await callTool('item_add', { title: '随手做完的小事' });
await callTool('item_update', { title: '随手做完的小事', done: true });

const today = await uiRequest('day.get', { day: new Date().toISOString().slice(0, 10) });
check(
  'an undated item completed today appears on today',
  today.done.some((e) => e.title === '随手做完的小事'),
  JSON.stringify(today.done),
);
check(
  'the day page also lists what is still open',
  Array.isArray(today.planned) && today.planned.length > 0,
  JSON.stringify(today.planned),
);

const read = await callTool('day_read', { day: '2026-09-30' });
check('day_read returns the note it was given', /全部重写/.test(read.content?.[0]?.text ?? ''));

const readRange = await callTool('day_read', { from: '2026-09-28', to: '2026-09-30' });
check('day_read accepts a range in one call', /2026-09-30/.test(readRange.content?.[0]?.text ?? ''));

const readBad = await callTool('day_read', { from: '2026-09-30', to: '2026-09-01' }).catch((e) => ({ error: e.message }));
check('a backwards range is refused', Boolean(readBad.error), JSON.stringify(readBad));

const readHuge = await callTool('day_read', { from: '2020-01-01', to: '2026-09-30' }).catch((e) => ({ error: e.message }));
check('an unbounded range is refused instead of dumping years of text', /90/.test(readHuge.error ?? ''), readHuge.error);

// ── workspace attribution ──

const WS_A = '/tmp/smoke-A';
const WS_B = '/tmp/smoke-B';

await callTool('item_add', { title: 'A 项目的站会', when: '2026-10-01 09:00' }, { workspaceId: WS_A });
await callTool('item_add', { title: 'B 项目的站会', when: '2026-10-01 09:00' }, { workspaceId: WS_B });
await callTool('item_add', { title: '交房租', scope: 'global' }, { workspaceId: WS_A });

const storedA = store.tasks.items.find((i) => i.title === 'A 项目的站会');
const storedGlobal = store.tasks.items.find((i) => i.title === '交房租');
check('an item defaults to the calling conversation’s workspace', storedA?.workspaceId === WS_A, JSON.stringify(storedA));
check(
  'scope: global keeps it out of every project',
  Boolean(storedGlobal) && storedGlobal.workspaceId === undefined,
  JSON.stringify(storedGlobal),
);

const listA = await callTool('item_list', { range: 'all' }, { workspaceId: WS_A });
const listAText = listA.content?.[0]?.text ?? '';
check('item_list shows its own project and the global items', listAText.includes('A 项目的站会') && listAText.includes('交房租'));
check('item_list hides another project’s items', !listAText.includes('B 项目的站会'), listAText);

const listAll = await callTool('item_list', { range: 'all', scope: 'all' }, { workspaceId: WS_A });
check('scope: all sees every project', (listAll.content?.[0]?.text ?? '').includes('B 项目的站会'));

const updateForeign = await callTool(
  'item_update',
  { title: 'B 项目的站会', done: true },
  { workspaceId: WS_A },
).catch((e) => ({ error: e.message }));
check('editing another project’s item is refused by default', Boolean(updateForeign.error), JSON.stringify(updateForeign));

// A host that cannot place the session must not guess: the write lands global.
await callTool('item_add', { title: '没有工作区时记的事' });
const unplaced = store.tasks.items.find((i) => i.title === '没有工作区时记的事');
check('an unplaced call writes a global item, never a guessed project', unplaced?.workspaceId === undefined, JSON.stringify(unplaced));

// ── the persisted shape ──

check('lastTickAt is persisted for the next boot to reconcile from', typeof store.tasks.lastTickAt === 'string');
check('the storage shape is what the backend reads back', Array.isArray(store.tasks.items) && Array.isArray(store.tasks.runs));
check('notes persist alongside the items', typeof store.tasks.notes === 'object' && Boolean(store.tasks.notes['2026-09-30']));
check('completion timestamps persist', typeof store.tasks.completedAt === 'object');

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
