/**
 * The `voice.speak` / `voice.stop` host capabilities: permission gate, payload
 * shape sent to the shell renderer, text limits, and readiness errors.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityHub } from '../src/main/plugins/capability-hub.ts';

function makeHub(permissions, { ready = { ok: true }, text } = {}) {
  const calls = [];
  const registry = {
    get(id) {
      return id === 'com.test.plugin'
        ? {
            manifest: { id, name: 'Test', version: '0.0.1', apiVersion: 3, permissions },
          }
        : undefined;
    },
    getDataDir() {
      return '/tmp/pi-plugin-test';
    },
  };
  const hub = new CapabilityHub({
    registry,
    emitEvent: () => undefined,
    sendToRenderer: (channel, payload) => calls.push({ channel, payload }),
    voiceReady: () => ready,
  });
  return { hub, calls };
}

const plugin = 'com.test.plugin';

test('voice.speak is denied without the voice permission', async () => {
  const { hub } = makeHub(['browser', 'storage']);
  await assert.rejects(hub.dispatch(plugin, 'voice.speak', { text: '你好' }), /permission denied/);
});

test('voice.speak relays text, key and toggle to the shell renderer', async () => {
  const { hub, calls } = makeHub(['voice']);
  const result = await hub.dispatch(plugin, 'voice.speak', { text: '  你好，世界  ' });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'pi:voice:speak');
  assert.deepEqual(calls[0].payload, {
    text: '你好，世界',
    key: `plugin:${plugin}`,
    toggle: true,
    pluginId: plugin,
  });

  await hub.dispatch(plugin, 'voice.speak', { text: '再来一次', toggle: false });
  assert.equal(calls[1].payload.toggle, false);
});

test('voice.speak rejects empty text and truncates very long text', async () => {
  const { hub, calls } = makeHub(['voice']);
  await assert.rejects(hub.dispatch(plugin, 'voice.speak', { text: '   ' }), /text is required/);

  await hub.dispatch(plugin, 'voice.speak', { text: '字'.repeat(9000) });
  assert.equal(calls[0].payload.text.length, 8000);
});

test('voice.speak reports an unconfigured TTS through the capability error', async () => {
  const { hub } = makeHub(['voice'], {
    ready: { ok: false, error: '语音合成未配置，请先在设置 → 语音中配置。' },
  });
  await assert.rejects(
    hub.dispatch(plugin, 'voice.speak', { text: '你好' }),
    /语音合成未配置/,
  );
});

test('voice.stop stops shell playback and needs the same permission', async () => {
  const { hub, calls } = makeHub(['voice']);
  assert.deepEqual(await hub.dispatch(plugin, 'voice.stop', {}), { ok: true });
  assert.equal(calls[0].channel, 'pi:voice:stop');

  const denied = makeHub([]).hub;
  await assert.rejects(denied.dispatch(plugin, 'voice.stop', {}), /permission denied/);
});
