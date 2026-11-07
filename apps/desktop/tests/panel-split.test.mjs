/**
 * Right-column editor groups.
 *
 * A split turns the flat tab list into groups: each group owns its tabs, its
 * active tab and its width. Splitting moves the selected tab into a new group;
 * opening another tab (or clicking +) adds it to the focused group without
 * disturbing the others; dragging a tab to another group moves it there.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usePanelStore } from '../../../packages/ui/src/stores/panel-store.ts';

const VIEWER = 'plugin:com.test:viewer';

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

function seed({ multiInstance = true } = {}) {
  reset();
  usePanelStore.getState().setPluginPanels([
    {
      id: 'com.test',
      name: 'Test',
      version: '1.0.0',
      enabled: true,
      state: 'active',
      panels: [
        {
          id: 'viewer',
          title: 'Viewer',
          entry: './ui.html',
          multiInstance,
          keepAlive: 'lru',
          scope: 'session',
        },
      ],
    },
  ]);
}

function state() {
  return usePanelStore.getState();
}

function openFile(file) {
  state().openPanel(VIEWER, { params: { file }, focus: true });
  return state().focusedId.right;
}

test('the first split creates two groups and moves the selected tab right', () => {
  seed();
  const a = openFile('/a');
  const b = openFile('/b');
  const c = openFile('/c');
  state().setFocused('right', a);

  state().splitTab('right', a);
  const s = state();
  assert.equal(s.splitGroups.right.length, 2);
  const [left, right] = s.splitGroups.right;
  assert.deepEqual(left.tabs.sort(), [b, c].sort());
  assert.equal(right.tabs[0], a);
  assert.equal(right.active, a);
  assert.equal(s.focusedId.right, a, 'the moved tab is focused');
  assert.equal(s.openPanelIds.right.length, 3, 'no duplicate tab is created');
});

test('+ adds an empty tab to one group and keeps the split', () => {
  seed();
  const a = openFile('/a');
  const b = openFile('/b');
  state().splitTab('right', a);
  const group = state().splitGroups.right[0];
  const before = state().openPanelIds.right.length;

  state().addTabToGroup('right', group.id, VIEWER);
  const s = state();
  const updated = s.splitGroups.right.find((g) => g.id === group.id);
  assert.equal(s.splitGroups.right.length, 2, 'still two groups');
  assert.equal(s.openPanelIds.right.length, before + 1);
  assert.ok(updated.tabs.length >= 1);
  assert.equal(updated.active, s.focusedId.right);
  assert.equal(s.params[s.focusedId.right], undefined, 'the new tab starts empty');
  assert.ok(s.openPanelIds.right.includes(b));
});

test('clicking tabs inside a group changes only that group active tab', () => {
  seed();
  const a = openFile('/a');
  const b = openFile('/b');
  const c = openFile('/c');
  state().setFocused('right', a);
  state().splitTab('right', a);
  const before = state().splitGroups.right;
  const left = before[0];
  const other = left.tabs.find((k) => k !== left.active) ?? left.tabs[0];

  state().setFocused('right', other);
  const s = state();
  assert.equal(s.splitGroups.right.length, 2);
  assert.equal(s.splitGroups.right[0].id, before[0].id, 'groups do not swap');
  assert.equal(s.splitGroups.right[1].id, before[1].id);
  assert.equal(s.splitGroups.right[0].active, other);
  assert.equal(s.splitGroups.right[1].active, before[1].active);
  assert.equal(s.focusedId.right, other);
  assert.ok(s.openPanelIds.right.includes(b) && s.openPanelIds.right.includes(c));
});

test('splitting again adds a group to the right and backfills an emptied source', () => {
  seed();
  const a = openFile('/a');
  const b = openFile('/b');
  state().splitTab('right', a); // a in group 1, b in group 0
  assert.equal(state().splitGroups.right.length, 2);

  state().splitTab('right', a); // group 1 would empty; it gets a fresh tab
  const s = state();
  assert.equal(s.splitGroups.right.length, 3);
  const groups = s.splitGroups.right;
  assert.ok(groups[groups.length - 1].tabs.includes(a));
  assert.equal(s.focusedId.right, a);
  // The source group still has a tab (the backfill), so the column survives.
  assert.ok(groups[groups.length - 2].tabs.length >= 1);
});

test('moving a tab between groups removes an emptied group', () => {
  seed();
  const a = openFile('/a');
  const b = openFile('/b');
  const c = openFile('/c');
  state().setFocused('right', a);
  state().splitTab('right', a);
  const [left, right] = state().splitGroups.right;
  assert.equal(left.tabs.length, 2);
  const moved = left.tabs[0];

  state().moveTabBetweenGroups('right', moved, right.id);
  let s = state();
  assert.equal(s.splitGroups.right.length, 2);
  assert.ok(s.splitGroups.right[1].tabs.includes(moved));
  assert.equal(s.splitGroups.right[1].active, moved);
  assert.equal(s.focusedId.right, moved);

  // Moving the other tab out empties the left group; it disappears and the
  // split collapses to the surviving group.
  const remaining = left.tabs.find((k) => k !== moved);
  state().moveTabBetweenGroups('right', remaining, right.id);
  s = state();
  assert.deepEqual(s.splitGroups.right, []);
  assert.ok(s.openPanelIds.right.includes(moved));
});

test('closing the last tab in a group removes that group', () => {
  seed();
  const a = openFile('/a');
  const b = openFile('/b');
  state().splitTab('right', a);
  const left = state().splitGroups.right[0];
  const only = left.tabs[0];
  state().closeTab('right', only);
  const s = state();
  assert.deepEqual(s.splitGroups.right, []);
  assert.ok(s.openPanelIds.right.includes(a));
});

test('singleton panels cannot split', () => {
  seed({ multiInstance: false });
  const key = openFile('/only');
  state().splitTab('right', key);
  assert.deepEqual(state().splitGroups.right, []);
});
