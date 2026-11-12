#!/usr/bin/env node
/**
 * Drive the built backend with a fake host — no Electron, no app.
 *
 * This plugin's backend has no Electron dependency of its own, so this is the
 * only way to check it short of asking the agent to drive a real browser: it
 * runs `dist/main.mjs`, the artifact that actually ships, against a stub that
 * answers the same `call` messages the host does, and asserts each tool's
 * result and the capability it reached for.
 *
 * Usage: node scripts/smoke-backend.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Storage keys the backend persists under — asserted at the bottom.
const HISTORY_KEY = 'history.entries';
const FAVORITES_KEY = 'favorites.items';
const CLIPS_KEY = 'clips.items';

/** What chat.send said — the agent half of the selection-popup round trip. */
const sentChats = [];
const voiceCalls = [];

/**
 * The fake page's selection-popup globals. `browser.evaluate` is the plugin's
 * ONLY channel into the page, so the fake reads the expression to tell which
 * injected global it touches, and answers the way the real page would.
 */
const fakePage = { installed: false, action: null, notes: [], toasts: [], clips: [], disabled: 0 };

function fakeEvaluate(expression) {
  // Order matters: the inject source also mentions __piSelDisable (it defines
  // it), so the install/disable checks must be anchored on their own shapes.
  if (expression.includes('data-pi-sel-host')) {
    const was = fakePage.installed;
    fakePage.installed = true;
    return was ? 'already' : 'installed';
  }
  if (/__piSelDisable \?/.test(expression)) {
    fakePage.installed = false;
    fakePage.disabled++;
    return true;
  }
  if (expression.includes('__piNoteShow')) {
    const m = expression.match(/__piNoteShow\((\{.*\})\)/s);
    fakePage.notes.push(m ? JSON.parse(m[1]) : { state: 'unparsed' });
    return true;
  }
  if (expression.includes('__piRenderClips')) {
    // Two JSON arguments: the list, and the id of the clip just kept.
    const m = expression.match(/__piRenderClips\((\[.*?\]), (null|"[^"]*")\)/s);
    fakePage.clips.push(m ? { list: JSON.parse(m[1]), newestId: JSON.parse(m[2]) } : { unparsed: expression.slice(0, 80) });
    return true;
  }
  if (expression.includes('__piToast')) {
    const m = expression.match(/__piToast\((\".*\")\)/s);
    fakePage.toasts.push(m ? JSON.parse(m[1]) : '');
    return true;
  }
  if (expression.includes('__piSelAction')) {
    // The poll expression: hand over a pending click (and clear it), or
    // report whether the popup is still installed.
    if (fakePage.action) {
      const a = JSON.stringify(fakePage.action);
      fakePage.action = null;
      return a;
    }
    return fakePage.installed ? '' : 'REINSTALL';
  }
  if (expression.includes('document.title')) {
    return { h1: currentTitle };
  }
  return { result: 'smoke-default' };
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ── A stand-in for the host ──
const calls = [];
let hostListener = null;

const port = {
  postMessage(msg) {
    queueMicrotask(() => handleFromBackend(msg));
  },
  on(_event, listener) {
    hostListener = listener;
  },
};

function sendToBackend(msg) {
  hostListener?.({ data: msg });
}

/** What the fake browser reports back. */
let currentUrl = 'about:blank';
let currentTitle = '';
let snapshotText = '[button] "登录" ref=[1]\n[input] "搜索" ref=[2]';

/** The fake multi-tab engine: one live tab, per the smoke flow's needs. */
const smokeTab = { id: 't1', url: 'about:blank', title: '', active: true, focused: true };
let smokeTabSeq = 1;

/** The fake storage.* store, shared by all keys. */
const store = {};

function handleFromBackend(msg) {
  switch (msg.type) {
    case 'ready':
      sendToBackend({ type: 'init', pluginId: 'com.pi.browser', apiVersion: 2, dataDir: '/tmp/x' });
      break;
    case 'tool-result':
      current?.resolve(msg);
      break;
    case 'call':
      calls.push(msg);
      switch (msg.method) {
        case 'browser.tabList':
          sendToBackend({ type: 'call-result', id: msg.id, result: [{ ...smokeTab, url: currentUrl, title: currentTitle }] });
          break;
        case 'browser.newTab': {
          const tabId = `t${++smokeTabSeq}`;
          smokeTab.id = tabId;
          smokeTab.url = msg.params.url ?? 'about:blank';
          sendToBackend({ type: 'call-result', id: msg.id, result: { tabId, url: smokeTab.url } });
          break;
        }
        case 'browser.navigate':
          currentUrl = msg.params.url;
          currentTitle = 'Example Domain';
          smokeTab.url = currentUrl;
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle } });
          break;
        case 'browser.getUrl':
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle } });
          break;
        case 'browser.getState':
          sendToBackend({ type: 'call-result', id: msg.id, result: { url: currentUrl, title: currentTitle, snapshot: snapshotText } });
          break;
        case 'browser.find':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: /没有这个/.test(msg.params.query)
              ? []
              : [{ score: 92, role: 'button', text: '登录', section: 'header' }],
          });
          break;
        case 'browser.click':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: msg.params.selector === '[99]'
              ? { selector: '[99]', clicked: false, error: 'Element not found: "[99]". Did you mean one of these?\n[1] 登录' }
              : { selector: msg.params.selector, clicked: true },
          });
          break;
        case 'browser.fill':
          sendToBackend({ type: 'call-result', id: msg.id, result: { selector: msg.params.selector, value: msg.params.value } });
          break;
        case 'browser.hover':
          sendToBackend({ type: 'call-result', id: msg.id, result: { hovered: true } });
          break;
        case 'browser.select':
          sendToBackend({ type: 'call-result', id: msg.id, result: { selected: true } });
          break;
        case 'browser.scroll':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: { direction: msg.params.direction === 'up' ? 'up' : 'down', amount: msg.params.amount ?? 500 },
          });
          break;
        case 'browser.evaluate':
          sendToBackend({ type: 'call-result', id: msg.id, result: { result: fakeEvaluate(msg.params.expression) } });
          break;
        case 'chat.send':
          // The composed instruction is `agentText`; `text` is only the
          // user-facing question shown on the card.
          sentChats.push(String(msg.params.agentText ?? msg.params.text ?? ''));
          sendToBackend({ type: 'call-result', id: msg.id, result: { ok: true } });
          break;
        case 'voice.speak':
          voiceCalls.push(msg.params);
          sendToBackend({ type: 'call-result', id: msg.id, result: { ok: true } });
          break;
        case 'browser.walk':
          sendToBackend({
            type: 'call-result',
            id: msg.id,
            result: {
              goal: msg.params.goal,
              url: currentUrl,
              title: currentTitle,
              reached: true,
              steps: [{ text: '设置' }, { text: '个人资料' }],
            },
          });
          break;
        case 'browser.screenshot':
          sendToBackend({ type: 'call-result', id: msg.id, result: { base64: 'aGVsbG8=' } });
          break;
        case 'storage.get':
          sendToBackend({ type: 'call-result', id: msg.id, result: store[msg.params.key] });
          break;
        case 'storage.set':
          store[msg.params.key] = msg.params.value;
          sendToBackend({ type: 'call-result', id: msg.id, result: { ok: true } });
          break;
        default:
          sendToBackend({ type: 'call-result', id: msg.id, error: `no such capability: ${msg.method}` });
      }
      break;
    case 'log':
      if (msg.level === 'error' || msg.level === 'warn') console.log(`  [${msg.level}] ${msg.message}`);
      break;
    default:
      break;
  }
}

let seq = 0;
let current = null;
function callTool(name, params) {
  return new Promise((resolve, reject) => {
    const id = 't' + ++seq;
    current = { resolve, reject };
    sendToBackend({ type: 'tool-call', id, name, params });
    setTimeout(() => reject(new Error(`tool ${name} timed out`)), 5000);
  });
}

// The SDK takes the host port at import time, so the fake must exist first.
process.parentPort = port;

// ── run ──

console.log('━━━ smoke: com.pi.browser dist/main.mjs against a fake host\n');

const seen = [];
const originalPost = port.postMessage.bind(port);
port.postMessage = (msg) => {
  seen.push(msg);
  return originalPost(msg);
};

await import(pathToFileURL(join(ROOT, 'dist/main.mjs')).href);
await new Promise((r) => setTimeout(r, 120));

check('the backend announced readiness on load', seen.some((m) => m.type === 'ready'));

// ── tools ──

const nav = await callTool('browser_navigate', { url: 'example.com' });
check(
  'browser_navigate normalizes a bare host to https',
  /已打开 https:\/\/example\.com/.test(nav.content?.[0]?.text ?? ''),
  nav.content?.[0]?.text,
);
check('browser_navigate reached for browser.navigate', calls.some((c) => c.method === 'browser.navigate'));

const state = await callTool('browser_get_state', {});
check(
  'browser_get_state reports the current page',
  /example\.com/.test(state.content?.[0]?.text ?? '') && /Example Domain/.test(state.content?.[0]?.text ?? ''),
  state.content?.[0]?.text,
);
check(
  'browser_get_state carries the interactive snapshot with a ref hint',
  /可交互元素/.test(state.content?.[0]?.text ?? '') && /browser_click/.test(state.content?.[0]?.text ?? ''),
  state.content?.[0]?.text,
);

const found = await callTool('browser_find', { query: '登录' });
check(
  'browser_find formats matches with role, text and score',
  /\[button\] "登录" \(header, 匹配度 92\)/.test(found.content?.[0]?.text ?? ''),
  found.content?.[0]?.text,
);
const notFound = await callTool('browser_find', { query: '页面上没有这个' });
check(
  'browser_find reports an empty result instead of nothing',
  /没有匹配/.test(notFound.content?.[0]?.text ?? ''),
  notFound.content?.[0]?.text,
);

const click = await callTool('browser_click', { selector: '[1]' });
check('browser_click succeeds on a live selector', /点击 "\[1\]"成功/.test(click.content?.[0]?.text ?? ''), click.content?.[0]?.text);
const clickMiss = await callTool('browser_click', { selector: '[99]' });
check(
  'browser_click surfaces the engine error and its suggestions',
  /点击 "\[99\]"失败/.test(clickMiss.content?.[0]?.text ?? '') && /Did you mean/.test(clickMiss.content?.[0]?.text ?? ''),
  clickMiss.content?.[0]?.text,
);

const fill = await callTool('browser_fill', { selector: '[2]', value: 'hello' });
check('browser_fill forwards selector and value', /填写 "\[2\]"成功/.test(fill.content?.[0]?.text ?? ''), fill.content?.[0]?.text);

const hover = await callTool('browser_hover', { selector: '[1]' });
check('browser_hover succeeds', /悬停 "\[1\]"成功/.test(hover.content?.[0]?.text ?? ''), hover.content?.[0]?.text);

const select = await callTool('browser_select', { selector: '[2]', value: 'option-a' });
check('browser_select forwards the option value', /选中 "option-a"/.test(select.content?.[0]?.text ?? ''), select.content?.[0]?.text);

const scroll = await callTool('browser_scroll', { direction: 'up', amount: 300 });
check('browser_scroll reports direction and amount', /向上滚动 300px/.test(scroll.content?.[0]?.text ?? ''), scroll.content?.[0]?.text);

const evaluated = await callTool('browser_evaluate', { expression: '({h1: document.title})' });
check(
  'browser_evaluate returns the JSON value',
  /"h1":\s*"Example Domain"/.test(evaluated.content?.[0]?.text ?? ''),
  evaluated.content?.[0]?.text,
);

const walk = await callTool('browser_walk', { goal: '进入个人设置页' });
check(
  'browser_walk reports the path and final page',
  /已到达目标 "进入个人设置页"/.test(walk.content?.[0]?.text ?? '') && /2\. 点击 "个人资料"/.test(walk.content?.[0]?.text ?? ''),
  walk.content?.[0]?.text,
);

// Truncation: a huge snapshot must be cut with a pointer at browser_find.
snapshotText = 'x'.repeat(9001);
const truncated = await callTool('browser_get_state', {});
snapshotText = '[button] "登录" ref=[1]\n[input] "搜索" ref=[2]';
check(
  'an oversized snapshot is truncated with a browser_find pointer',
  /快照已截断/.test(truncated.content?.[0]?.text ?? '') && /browser_find/.test(truncated.content?.[0]?.text ?? ''),
  truncated.content?.[0]?.text?.slice(-80),
);

const shot = await callTool('browser_screenshot', {});
check('browser_screenshot returns an image block', shot.content?.[1]?.type === 'image');
check('browser_screenshot carries a png mime type', shot.content?.[1]?.mimeType === 'image/png');
check(
  'browser_screenshot sizes the image in its text',
  /KB PNG/.test(shot.content?.[0]?.text ?? ''),
  shot.content?.[0]?.text,
);

const missing = await callTool('browser_something_else', {}).catch((e) => ({ error: e.message }));
check(
  'an unknown tool errors instead of returning nothing',
  /unknown tool/.test(missing.error ?? ''),
  JSON.stringify(missing),
);

// ── panel (data plane): the address-bar page ──
// The real flow: ui-port lands → page frames flow over it. The fake port
// records what the backend pushes and lets us play page frames back in.

const panelSent = [];
let panelListener = null;
const panelPort = {
  postMessage(msg) { panelSent.push(msg); },
  on(event, listener) { if (event === 'message') panelListener = listener; },
  start() {},
};
// The `ui-port` message carries the port in event.ports, not data.
hostListener?.({ data: { type: 'ui-port' }, ports: [panelPort] });

function panelRequest(id, method, params) {
  panelListener?.({ data: { kind: 'request', id, panelId: 'browser', tabId: 'host1', method, params } });
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const hit = panelSent.find((m) => m.kind === 'response' && m.id === id);
      if (hit) { clearInterval(timer); resolve(hit); }
    }, 5);
    setTimeout(() => { clearInterval(timer); resolve(null); }, 2000);
  });
}

// panel.mounted is a lifecycle frame the host raises; the backend should
// register the host tab, bind it to the engine tab the host opened it for,
// and push that page's URL. A mount without params is a favorites tab now.
panelListener?.({
  data: {
    kind: 'event',
    panelId: 'browser',
    // The preload stamps the host tab on every message; the page's own
    // panel.mounted data repeats it for replay after a reload.
    tabId: 'host1',
    event: 'panel.mounted',
    data: { tabId: 'host1', params: { engineTabId: smokeTab.id } },
  },
});
await new Promise((r) => setTimeout(r, 60));
check(
  'panel.mounted pushes the current URL to the panel',
  panelSent.some((m) => m.kind === 'event' && m.event === 'ui.urlChanged' && /example\.com/.test(m.data?.url ?? '')),
  JSON.stringify(panelSent),
);

const navReq = await panelRequest('q1', 'nav.open', { url: 'example.org' });
check(
  'panel nav.open reaches browser.navigate and answers ok',
  calls.some((c) => c.method === 'browser.navigate' && c.params.url === 'https://example.org') &&
    navReq?.ok === true && navReq?.result?.url === 'https://example.org',
  JSON.stringify(navReq),
);

await panelRequest('q2', 'nav.back');
await panelRequest('q3', 'nav.forward');
await panelRequest('q4', 'nav.reload');
check(
  'panel back/forward/reload reach their capabilities',
  ['browser.back', 'browser.forward', 'browser.reload'].every((m) => calls.some((c) => c.method === m)),
  calls.map((c) => c.method).join(','),
);

const stateReq = await panelRequest('q5', 'state.get');
check(
  'panel state.get uses the lightweight browser.getUrl (no full snapshot)',
  calls.some((c) => c.method === 'browser.getUrl') && stateReq?.ok === true && 'url' in (stateReq?.result ?? {}),
  JSON.stringify(stateReq),
);

const unknownReq = await panelRequest('q6', 'does.not.exist', {});
check(
  'an unknown panel method is rejected with the known list',
  unknownReq?.ok === false && /unknown panel method/.test(unknownReq?.error ?? ''),
  JSON.stringify(unknownReq),
);

// host-event: agent navigated somewhere → the address bar must hear about it.
panelSent.length = 0;
sendToBackend({ type: 'host-event', event: 'browser.urlChanged', data: { tabId: smokeTab.id, url: 'https://agent-opened.example' } });
await new Promise((r) => setTimeout(r, 60));
check(
  'browser.urlChanged host event is relayed to the mounted panel',
  panelSent.some((m) => m.kind === 'event' && m.event === 'ui.urlChanged' && m.data?.url === 'https://agent-opened.example'),
  JSON.stringify(panelSent),
);

// ── omnibox: history, favorites, private mode ──
// lastUrl is https://agent-opened.example at this point (the host event above),
// which is what a star click with no explicit url means.

const fav = await panelRequest('f1', 'favorites.toggle', {});
check(
  'favorites.toggle with no url favorites the current page',
  fav?.ok === true && fav?.result?.favorited === true && fav?.result?.url === 'https://agent-opened.example',
  JSON.stringify(fav),
);
check(
  'toggling a favorite is announced to the panel (star + list follow)',
  panelSent.some((m) => m.event === 'ui.favoritesChanged') &&
    panelSent.some((m) => m.event === 'ui.urlChanged' && m.data?.favorited === true),
  JSON.stringify(panelSent.filter((m) => m.kind === 'event').map((m) => m.event)),
);

const omni = await panelRequest('f2', 'omnibox.search', { query: '' });
check(
  'omnibox.search with an empty query returns the favorite',
  omni?.ok === true && omni.result.favorites.length === 1 && omni.result.favorites[0].url === 'https://agent-opened.example',
  JSON.stringify(omni),
);
const omniMiss = await panelRequest('f3', 'omnibox.search', { query: '没有这个站点' });
check(
  'omnibox.search filters by every word of the query',
  omniMiss?.ok === true && omniMiss.result.favorites.length === 0 && omniMiss.result.history.length === 0,
  JSON.stringify(omniMiss),
);

const favList = await callTool('browser_favorites_list', {});
check(
  'browser_favorites_list names the starred page',
  /agent-opened\.example/.test(favList.content?.[0]?.text ?? ''),
  favList.content?.[0]?.text,
);

const historyTool = await callTool('browser_history_search', { query: 'agent-opened' });
check(
  'browser_history_search finds a visit recorded from the host event',
  /agent-opened\.example/.test(historyTool.content?.[0]?.text ?? '') && /访问 1 次/.test(historyTool.content?.[0]?.text ?? ''),
  historyTool.content?.[0]?.text,
);

// Same page, different anchor: did-navigate-in-page fires for these, and none
// of them is a new visit.
sendToBackend({ type: 'host-event', event: 'browser.urlChanged', data: { tabId: smokeTab.id, url: 'https://agent-opened.example#section' } });
await new Promise((r) => setTimeout(r, 60));
const dedup = await callTool('browser_history_search', { query: 'agent-opened' });
check(
  'an anchor jump on the same page is not counted as another visit',
  /访问 1 次/.test(dedup.content?.[0]?.text ?? ''),
  dedup.content?.[0]?.text,
);

// The title arrives after did-navigate; the backend asks the engine again and
// backfills it instead of leaving every visit untitled.
currentUrl = 'https://second.example/page';
sendToBackend({ type: 'host-event', event: 'browser.urlChanged', data: { tabId: smokeTab.id, url: currentUrl } });
await new Promise((r) => setTimeout(r, 60));
currentTitle = '第二页';
await new Promise((r) => setTimeout(r, 1500));
const titled = await callTool('browser_history_search', { query: 'second.example' });
check(
  'a visit learns its page title a beat after the navigation',
  /第二页/.test(titled.content?.[0]?.text ?? ''),
  titled.content?.[0]?.text,
);

const private_on = await panelRequest('f4', 'settings.setPrivate', { private: true });
await new Promise((r) => setTimeout(r, 20));
panelSent.length = 0;
sendToBackend({ type: 'host-event', event: 'browser.urlChanged', data: { tabId: smokeTab.id, url: 'https://secret.example/x' } });
await new Promise((r) => setTimeout(r, 60));
const secret = await callTool('browser_history_search', { query: 'secret.example' });
check(
  'private mode stops recording visits',
  private_on?.result?.private === true && /没有匹配/.test(secret.content?.[0]?.text ?? ''),
  secret.content?.[0]?.text,
);
check(
  'private mode still pushes the page to the panel (it is a state, not a blackout)',
  panelSent.some((m) => m.event === 'ui.urlChanged' && m.data?.private === true),
  JSON.stringify(panelSent.filter((m) => m.kind === 'event').map((m) => m.event)),
);
await panelRequest('f5', 'settings.setPrivate', { private: false });

const stateReq2 = await panelRequest('f6', 'state.get');
check(
  'state.get reports the star state and private flag alongside the url',
  stateReq2?.ok === true && stateReq2.result.favorited === false && stateReq2.result.private === false,
  JSON.stringify(stateReq2),
);

const cleared = await panelRequest('f7', 'history.clear');
const afterClear = await callTool('browser_history_search', {});
check(
  'history.clear empties the history the agent reads',
  cleared?.ok === true && /历史记录是空的/.test(afterClear.content?.[0]?.text ?? ''),
  afterClear.content?.[0]?.text,
);
check(
  'clearing history leaves favorites alone (they are explicit, not incidental)',
  store[FAVORITES_KEY]?.length === 1 && store[HISTORY_KEY]?.length === 0,
  JSON.stringify(store),
);

const removed = await panelRequest('f8', 'favorites.remove', { url: 'https://agent-opened.example' });
const favList2 = await callTool('browser_favorites_list', {});
check(
  'favorites.remove drops it from the list',
  removed?.ok === true && /还没有收藏/.test(favList2.content?.[0]?.text ?? ''),
  favList2.content?.[0]?.text,
);

// A fresh backend must read all of it back — persistence, not just memory.
const persisted = await panelRequest('f9', 'favorites.toggle', { url: 'https://persisted.example', title: '持久化' });
check(
  'favorites are written through to storage',
  persisted?.result?.favorited === true &&
    Array.isArray(store[FAVORITES_KEY]) &&
    store[FAVORITES_KEY][0].title === '持久化' &&
    store[FAVORITES_KEY][0].url === 'https://persisted.example',
  JSON.stringify(store[FAVORITES_KEY]),
);

// ── selection popup: inject → click → poll → act → show ──

await panelRequest('s1', 'settings.setSelPopup', { on: true });
await new Promise((r) => setTimeout(r, 900)); // let an injection attempt land
check('the popup is installed into the page', fakePage.installed === true, JSON.stringify(fakePage));

// The user clicks 收藏 on the popup — the list comes back into the popup.
fakePage.action = { action: '收藏', text: '选中的这段话', url: 'https://example.com/', title: 'Example Domain' };
await new Promise((r) => setTimeout(r, 900)); // one poll tick carries it back
check(
  'a 收藏 click reaches the backend through the poll and is stored as a clip',
  Array.isArray(store[CLIPS_KEY]) && store[CLIPS_KEY][0]?.text === '选中的这段话',
  JSON.stringify(store[CLIPS_KEY]),
);
check(
  'the popup gets the clips list back, with the new one marked as newest',
  fakePage.clips.length === 1 && fakePage.clips[0].list[0]?.text === '选中的这段话' &&
    fakePage.clips[0].newestId === fakePage.clips[0].list[0].id,
  JSON.stringify(fakePage.clips),
);

// Deleting from that list is the only clip-management path there is.
const doomedId = store[CLIPS_KEY][0].id;
fakePage.action = { action: 'removeClip', id: doomedId };
await new Promise((r) => setTimeout(r, 900));
check(
  'the ✕ in the list deletes the clip and redraws the list',
  store[CLIPS_KEY].length === 0 && fakePage.clips.length === 2 && fakePage.clips[1].list.length === 0,
  JSON.stringify({ clips: store[CLIPS_KEY], rendered: fakePage.clips }),
);

// 发送 (the question field, Enter or the button) carries the chip's quote separately.
sentChats.length = 0;
fakePage.action = { action: 'chat', text: '这段话的第二句是什么意思?', quote: '引用的原始段落。', url: 'https://example.com/' };
await new Promise((r) => setTimeout(r, 900));
check(
  '发送 puts the question and the chip quote into the conversation, with its source',
  sentChats.length === 1 &&
    /第二句是什么意思/.test(sentChats[0]) &&
    /「引用」引用的原始段落。/.test(sentChats[0]) &&
    /https:\/\/example\.com/.test(sentChats[0]),
  JSON.stringify(sentChats),
);
sentChats.length = 0;
fakePage.action = { action: 'chat', text: '', quote: '只发引用不打问题', url: 'https://example.com/' };
await new Promise((r) => setTimeout(r, 900));
check(
  '发送 with the chip alone is a quote-only opener',
  sentChats.length === 1 && /「引用」只发引用不打问题/.test(sentChats[0]) && !/undefined/.test(sentChats[0]),
  JSON.stringify(sentChats),
);

// 翻译: the click must reach the agent — and the popup must say it is working.
fakePage.notes.length = 0;
sentChats.length = 0;
fakePage.action = { action: '翻译', text: 'Hello world', url: 'https://example.com/', title: 'Example Domain' };
await new Promise((r) => setTimeout(r, 900));
check(
  '翻译 asks the agent, naming browser_show as the way to answer',
  sentChats.some((t) => /Hello world/.test(t) && /browser_show/.test(t)),
  JSON.stringify(sentChats),
);
check(
  'the popup card shows a pending state while the agent works',
  fakePage.notes.some((n) => n.state === 'pending' && n.kind === 'translate'),
  JSON.stringify(fakePage.notes),
);

// 朗读: selection text goes to the host voice capability, not to the agent.
voiceCalls.length = 0;
sentChats.length = 0;
fakePage.action = { action: '朗读', text: 'Read this sentence aloud.', url: 'https://example.com/', title: 'Example Domain' };
await new Promise((r) => setTimeout(r, 900));
check(
  '朗读 calls voice.speak with the selected text and toggle',
  voiceCalls.length === 1 &&
    voiceCalls[0].text === 'Read this sentence aloud.' &&
    voiceCalls[0].toggle === true &&
    sentChats.length === 0,
  JSON.stringify({ voiceCalls, sentChats }),
);

// 朗读结果: the translated/explained answer can be read from the result card.
voiceCalls.length = 0;
fakePage.action = { action: '朗读结果', text: '这是卡片里的译文内容。', url: 'https://example.com/', title: 'Example Domain' };
await new Promise((r) => setTimeout(r, 900));
check(
  '朗读结果 reads the translated/explained text through voice.speak',
  voiceCalls.length === 1 &&
    voiceCalls[0].text === '这是卡片里的译文内容。' &&
    voiceCalls[0].toggle === true,
  JSON.stringify(voiceCalls),
);

const shown = await callTool('browser_show', { text: '你好,世界', kind: 'translate' });
check(
  'browser_show renders the agent result in the page card',
  /已展示/.test(shown.content?.[0]?.text ?? '') && fakePage.notes.some((n) => n.state === 'done' && n.text === '你好,世界'),
  JSON.stringify({ result: shown.content?.[0]?.text, notes: fakePage.notes }),
);

// A pending 翻译 that outlives 10s tells the user about the permission gate —
// from the popup, "翻译中… forever" is exactly how a gated call reads as dead.
// (The hint TEXT lives in the injected script; here we assert the state fires.)
fakePage.notes.length = 0;
fakePage.action = { action: '翻译', text: 'Hello again', url: 'https://example.com/' };
await new Promise((r) => setTimeout(r, 900)); // pendingNote set
const realNow = Date.now;
Date.now = () => realNow() + 15_000; // age the pending note past the hint threshold
await new Promise((r) => setTimeout(r, 900)); // one poll tick with the aged clock
Date.now = realNow;
check(
  'a slow answer fires the pending-hint state (names the permission gate in the popup)',
  fakePage.notes.some((n) => n.state === 'pending-hint'),
  JSON.stringify(fakePage.notes),
);
check(
  'the hint fires once, not every tick',
  fakePage.notes.filter((n) => n.state === 'pending-hint').length === 1,
  JSON.stringify(fakePage.notes),
);

// Re-keeping the text means the list is the only place the user can undo it.
fakePage.action = { action: '收藏', text: '选中的这段话', url: 'https://example.com/', title: 'Example Domain' };
await new Promise((r) => setTimeout(r, 900));

const clipsTool = await callTool('browser_clips_list', {});
check(
  'browser_clips_list shows the agent what the user kept',
  /选中的这段话/.test(clipsTool.content?.[0]?.text ?? ''),
  clipsTool.content?.[0]?.text,
);

// Off switch: the live page must lose the popup.
const selOff = await panelRequest('s2', 'settings.setSelPopup', { on: false });
check(
  'turning the switch off removes the popup from the live page',
  selOff?.result?.selPopup === false && fakePage.disabled > 0 && fakePage.installed === false,
  JSON.stringify({ result: selOff?.result, disabled: fakePage.disabled, installed: fakePage.installed }),
);
await panelRequest('s3', 'settings.setSelPopup', { on: true });

// A page that drops the popup is healed by the next poll, not left broken.
fakePage.installed = false;
await new Promise((r) => setTimeout(r, 900));
check('a page that lost the popup gets it back on the next poll', fakePage.installed === true, JSON.stringify(fakePage));

const stateReq3 = await panelRequest('s4', 'state.get');
check(
  'state.get carries the selection-popup switch for the panel footer',
  stateReq3?.result?.selPopup === true,
  JSON.stringify(stateReq3),
);

check('every capability call carried a method and params', calls.every((c) => typeof c.method === 'string'));

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
