/**
 * Which column a panel belongs to decides whether its tabs follow the
 * conversation.
 *
 * The right column is the workspace of the conversation on screen, the left
 * column is the workspace as a whole (all sessions, all files) — so a panel
 * that declares no `scope` takes the default of its column: right → session,
 * left → global. Before this, every undeclared panel was global, which is why
 * a plugin centre opened once showed up in every new conversation.
 *
 * A declaration always wins: a right-side panel that must stay open across
 * conversations can still say `scope: 'global'`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usePanelStore } from '../../../packages/ui/src/stores/panel-store.ts';

const PLUGIN_CENTER = 'host:plugins';
const SESSIONS = 'host:sessions';
const DOCS = 'plugin:com.test:docs';
const PINNED = 'plugin:com.test:pinned';

function reset() {
  usePanelStore.setState({
    panels: [],
    focusedId: { left: null, right: null },
    openPanelIds: { left: [], right: [] },
    panelOrder: { left: [], right: [] },
    splitGroups: { left: [], right: [] },
    currentSessionId: null,
    sessionPanels: {},
    sessionOrder: [],
    mountedIds: [],
    recency: [],
    runtime: {},
    params: {},
    tabTitles: {},
    activationNonces: {},
    pluginPanelsSynced: false,
  });
}

function state() {
  return usePanelStore.getState();
}

function register(pluginPanels = []) {
  state().setHostPanels([
    { id: PLUGIN_CENTER, title: '插件中心', icon: 'puzzle', source: 'host', keepAlive: 'never', region: 'right' },
    { id: SESSIONS, title: '会话', icon: 'sessions', source: 'host', keepAlive: 'always', region: 'left' },
  ]);
  state().setPluginPanels([
    { id: 'com.test', name: 'Test', version: '1.0.0', state: 'active', panels: pluginPanels },
  ]);
}

function scopeOf(id) {
  return state().panels.find((p) => p.id === id)?.scope;
}

test('right-side panels belong to the conversation when they declare nothing', () => {
  reset();
  register([{ id: 'docs', title: '文档', entry: './ui/index.html', region: 'right' }]);
  assert.equal(scopeOf(PLUGIN_CENTER), 'session');
  assert.equal(scopeOf(DOCS), 'session');
});

test('left-side panels stay with the workspace when they declare nothing', () => {
  reset();
  register([{ id: 'docs', title: '文档', entry: './ui/index.html', region: 'left' }]);
  assert.equal(scopeOf(SESSIONS), 'global');
  assert.equal(scopeOf(DOCS), 'global');
});

test('a region-less panel is a right-column panel, so it follows the conversation', () => {
  reset();
  register([{ id: 'docs', title: '文档', entry: './ui/index.html' }]);
  assert.equal(scopeOf(DOCS), 'session');
});

test('an explicit scope wins in both directions', () => {
  reset();
  register([
    { id: 'pinned', title: '常驻', entry: './ui/index.html', region: 'right', scope: 'global' },
    { id: 'docs', title: '文档', entry: './ui/index.html', region: 'left', scope: 'session' },
  ]);
  assert.equal(scopeOf(PINNED), 'global');
  assert.equal(scopeOf(DOCS), 'session');
});

test('a new conversation starts empty; switching back restores the tab', () => {
  reset();
  register([{ id: 'docs', title: '文档', entry: './ui/index.html', region: 'right' }]);

  state().enterSession('A');
  state().openPanel(PLUGIN_CENTER);
  assert.deepEqual(state().openPanelIds.right, [PLUGIN_CENTER]);

  // A brand-new conversation has no tabs of its own — the right column is the
  // panel grid, not whatever management panel was open a moment ago.
  state().enterSession('B');
  assert.deepEqual(state().openPanelIds.right, []);
  assert.equal(state().focusedId.right, null);
  assert.deepEqual(state().sessionPanels.A?.selected, [PLUGIN_CENTER]);

  // Coming back reattaches it.
  state().enterSession('A');
  assert.deepEqual(state().openPanelIds.right, [PLUGIN_CENTER]);
  assert.equal(state().focusedId.right, PLUGIN_CENTER);
});

test('an explicitly global right panel follows every conversation', () => {
  reset();
  register([
    { id: 'pinned', title: '常驻', entry: './ui/index.html', region: 'right', scope: 'global' },
  ]);

  state().enterSession('A');
  state().openPanel(PINNED);
  assert.deepEqual(state().openPanelIds.right, [PINNED]);

  state().enterSession('B');
  assert.deepEqual(state().openPanelIds.right, [PINNED]);
  assert.equal(state().focusedId.right, PINNED);
});
