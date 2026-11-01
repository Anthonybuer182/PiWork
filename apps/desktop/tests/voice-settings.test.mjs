/**
 * Voice provider configuration on disk: seeding, normalization, renames and
 * the active-provider invariant. Runs against temp files — no Electron.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VoiceSettingsService,
  LEGACY_SYSTEM_PROVIDER_NAME,
} from '../src/main/voice/settings.ts';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-voice-'));
  t.after(() => {
    // A pending atomic write can recreate a temp file mid-rimraf; leftover
    // temp directories are harmless, so a failed cleanup must not fail a test.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch {
      /* ignored */
    }
  });
  return join(dir, 'voice.json');
}

function service(t, platform = 'darwin') {
  return new VoiceSettingsService(tempFile(t), { platform });
}

test('defaults enable the built-ins and leave the provider lists empty', (t) => {
  const s = service(t).get();
  assert.equal(s.stt.autoSend, false);
  assert.equal(s.tts.autoRead, false);
  assert.deepEqual(s.stt.providers, {});
  assert.deepEqual(s.tts.providers, {});
  assert.equal(s.stt.activeProvider, null);
  assert.equal(s.stt.builtin, 'whisper');
  assert.equal(s.stt.builtinModel, 'sensevoice');
  assert.equal(s.tts.builtin, 'system-say');
});

test('the built-in TTS default follows the platform', (t) => {
  assert.equal(service(t, 'darwin').get().tts.builtin, 'system-say');
  assert.equal(service(t, 'win32').get().tts.builtin, 'system-say');
  assert.equal(service(t, 'linux').get().tts.builtin, 'local-tts');
});

test('providers are saved, renamed and become active once the builtin is off', (t) => {
  const svc = service(t);
  svc.setPreferences({ capability: 'stt', patch: { builtin: 'off' } });
  svc.saveProvider({
    capability: 'stt',
    originalName: null,
    name: 'OpenAI',
    provider: { type: 'openai-audio', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'whisper-1' },
  });
  let s = svc.get();
  assert.equal(s.stt.activeProvider, 'OpenAI');
  assert.equal(s.stt.providers.OpenAI.model, 'whisper-1');

  svc.saveProvider({
    capability: 'stt',
    originalName: 'OpenAI',
    name: 'OpenAI 主账号',
    provider: s.stt.providers.OpenAI,
  });
  s = svc.get();
  assert.equal(s.stt.activeProvider, 'OpenAI 主账号');
  assert.equal(s.stt.providers.OpenAI, undefined);
  assert.ok(s.stt.providers['OpenAI 主账号']);
});

test('a provider that does not support the capability is rejected', (t) => {
  const svc = service(t);
  assert.throws(
    () => svc.saveProvider({
      capability: 'stt',
      originalName: null,
      name: '系统语音',
      provider: { type: 'system-say' },
    }),
    /不支持/,
  );
});

test('duplicate names are refused unless it is the same provider', (t) => {
  const svc = service(t);
  svc.saveProvider({ capability: 'tts', originalName: null, name: 'A', provider: { type: 'openai-audio' } });
  assert.throws(
    () => svc.saveProvider({ capability: 'tts', originalName: null, name: 'A', provider: { type: 'openai-audio' } }),
    /已存在/,
  );
  // Saving the same entry under the same name is an update, not a conflict.
  svc.saveProvider({ capability: 'tts', originalName: 'A', name: 'A', provider: { type: 'openai-audio', voice: 'alloy' } });
  assert.equal(svc.get().tts.providers.A.voice, 'alloy');
});

test('deleting the active provider clears the selection', (t) => {
  const svc = service(t, 'linux');
  svc.setPreferences({ capability: 'tts', patch: { builtin: 'off' } });
  svc.saveProvider({ capability: 'tts', originalName: null, name: 'E', provider: { type: 'elevenlabs', apiKey: 'x' } });
  assert.equal(svc.get().tts.activeProvider, 'E');
  svc.deleteProvider({ capability: 'tts', name: 'E' });
  const s = svc.get();
  assert.equal(s.tts.activeProvider, null);
  assert.deepEqual(s.tts.providers, {});
});

test('preferences patch strings, booleans and validates the active provider', (t) => {
  const svc = service(t);
  svc.saveProvider({ capability: 'stt', originalName: null, name: 'W', provider: { type: 'local-whisper', options: { binaryPath: '/usr/bin/whisper-cli' } } });
  let s = svc.setPreferences({ capability: 'stt', patch: { language: ' zh ', autoSend: true } });
  assert.equal(s.stt.language, 'zh');
  assert.equal(s.stt.autoSend, true);
  // autoRead is a TTS-only preference; writing it on STT must not stick.
  s = svc.setPreferences({ capability: 'stt', patch: { autoRead: true } });
  assert.equal(s.stt.autoRead, false);
  assert.throws(
    () => svc.setPreferences({ capability: 'stt', patch: { activeProvider: 'missing' } }),
    /不存在/,
  );
  s = svc.setPreferences({ capability: 'stt', patch: { activeProvider: null } });
  assert.equal(s.stt.activeProvider, null);
});

test('a corrupt file falls back to defaults and is replaced on the next write', (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{ not json', 'utf8');
  const svc = new VoiceSettingsService(file, { platform: 'linux' });
  assert.equal(svc.get().tts.activeProvider, null);
  svc.setPreferences({ capability: 'tts', patch: { builtin: 'off' } });
  svc.saveProvider({ capability: 'tts', originalName: null, name: 'N', provider: { type: 'openai-audio' } });
  svc.flushSync();
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.settings.tts.activeProvider, 'N');
});

test('an unknown or mismatched persisted provider is dropped', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: {
      stt: {
        providers: {
          bad: { type: 'not-a-protocol' },
          system: { type: 'system-say' },
          ok: { type: 'openai-audio', model: 'whisper-1' },
        },
        activeProvider: 'bad',
      },
      tts: { providers: {} },
    },
  }), 'utf8');
  const s = new VoiceSettingsService(file, { platform: 'linux' }).get();
  assert.deepEqual(Object.keys(s.stt.providers), ['ok']);
  assert.equal(s.stt.activeProvider, null);
});

test('choosing a builtin clears the active provider; choosing a provider keeps the builtin', (t) => {
  const svc = service(t, 'linux');
  svc.setPreferences({ capability: 'stt', patch: { builtin: 'off' } });
  svc.saveProvider({ capability: 'stt', originalName: null, name: 'W', provider: { type: 'openai-audio', baseUrl: 'https://x/v1' } });
  assert.equal(svc.get().stt.activeProvider, 'W');

  let s = svc.setPreferences({ capability: 'stt', patch: { builtin: 'whisper' } });
  assert.equal(s.stt.activeProvider, null);
  assert.equal(s.stt.builtin, 'whisper');

  s = svc.setPreferences({ capability: 'stt', patch: { activeProvider: 'W' } });
  assert.equal(s.stt.activeProvider, 'W');
  assert.equal(s.stt.builtin, 'whisper');

  s = svc.setPreferences({ capability: 'stt', patch: { builtin: 'off' } });
  assert.equal(s.stt.activeProvider, 'W', 'turning the builtin off must not drop the provider');
});

test('Kokoro can be selected as the built-in TTS model', (t) => {
  const svc = service(t);
  const s = svc.setPreferences({
    capability: 'tts',
    patch: { builtin: 'local-tts', builtinModel: 'kokoro' },
  });
  assert.equal(s.tts.builtinModel, 'kokoro');
});

test('builtin and model values are validated per capability', (t) => {
  const svc = service(t);
  assert.throws(
    () => svc.setPreferences({ capability: 'stt', patch: { builtin: 'local-tts' } }),
    /内置语音引擎无效/,
  );
  assert.throws(
    () => svc.setPreferences({ capability: 'tts', patch: { builtinModel: 'sensevoice' } }),
    /内置语音模型无效/,
  );
  const s = svc.setPreferences({ capability: 'tts', patch: { builtin: 'local-tts' } });
  assert.equal(s.tts.builtin, 'local-tts');
  assert.equal(s.tts.activeProvider, null);
});

test('editing an inactive provider does not steal the builtin selection', (t) => {
  const svc = service(t, 'linux');
  svc.saveProvider({ capability: 'stt', originalName: null, name: 'Cloud', provider: { type: 'openai-audio', baseUrl: 'https://x/v1' } });
  svc.setPreferences({ capability: 'stt', patch: { builtin: 'whisper' } });
  svc.saveProvider({ capability: 'stt', originalName: 'Cloud', name: 'Cloud', provider: { type: 'openai-audio', baseUrl: 'https://y/v1' } });
  const s = svc.get();
  assert.equal(s.stt.activeProvider, null);
  assert.equal(s.stt.builtin, 'whisper');
  assert.equal(s.stt.providers.Cloud.baseUrl, 'https://y/v1');
});

test('the builtin sentinel cannot be used as a provider name', (t) => {
  const svc = service(t);
  assert.throws(
    () => svc.saveProvider({ capability: 'tts', originalName: null, name: '__builtin__', provider: { type: 'openai-audio' } }),
    /保留/,
  );
});

test('v1 migrates the auto-seeded system provider into the builtin', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: {
      stt: { providers: {}, activeProvider: null, model: '', voice: '', language: '', autoSend: false, autoRead: false },
      tts: {
        providers: { [LEGACY_SYSTEM_PROVIDER_NAME]: { type: 'system-say' } },
        activeProvider: LEGACY_SYSTEM_PROVIDER_NAME,
        model: '', voice: '', language: '', autoSend: false, autoRead: false,
      },
    },
  }), 'utf8');
  const svc = new VoiceSettingsService(file, { platform: 'darwin' });
  const s = svc.get();
  assert.deepEqual(s.tts.providers, {});
  assert.equal(s.tts.activeProvider, null);
  assert.equal(s.tts.builtin, 'system-say');
  svc.flushSync();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
});

test('v1 migration on Linux picks the local TTS engine', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: {
      stt: {},
      tts: {
        providers: { [LEGACY_SYSTEM_PROVIDER_NAME]: { type: 'system-say' } },
        activeProvider: LEGACY_SYSTEM_PROVIDER_NAME,
      },
    },
  }), 'utf8');
  const s = new VoiceSettingsService(file, { platform: 'linux' }).get();
  assert.equal(s.tts.builtin, 'local-tts');
  assert.equal(s.tts.builtinModel, 'melo-int8');
});

test('a persisted provider using the builtin sentinel is dropped', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    version: 2,
    settings: {
      stt: {},
      tts: {
        providers: { __builtin__: { type: 'openai-audio' } },
        activeProvider: '__builtin__',
      },
    },
  }), 'utf8');
  const s = new VoiceSettingsService(file, { platform: 'linux' }).get();
  assert.deepEqual(s.tts.providers, {});
  assert.equal(s.tts.activeProvider, null);
});

test('system speech cannot be selected on unsupported platforms', (t) => {
  const svc = service(t, 'linux');
  assert.throws(
    () => svc.setPreferences({ capability: 'tts', patch: { builtin: 'system-say' } }),
    /不支持内置系统语音/,
  );
});

test('v1 keeps a system-say provider the user edited', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    version: 1,
    settings: {
      stt: {},
      tts: {
        providers: { [LEGACY_SYSTEM_PROVIDER_NAME]: { type: 'system-say', voice: 'Tingting' } },
        activeProvider: LEGACY_SYSTEM_PROVIDER_NAME,
      },
    },
  }), 'utf8');
  const s = new VoiceSettingsService(file, { platform: 'darwin' }).get();
  assert.equal(s.tts.providers[LEGACY_SYSTEM_PROVIDER_NAME].voice, 'Tingting');
  assert.equal(s.tts.activeProvider, LEGACY_SYSTEM_PROVIDER_NAME);
});

test('flushSync writes a versioned file', (t) => {
  const file = tempFile(t);
  const svc = new VoiceSettingsService(file, { platform: 'linux' });
  svc.saveProvider({ capability: 'tts', originalName: null, name: 'X', provider: { type: 'deepgram', apiKey: 'k' } });
  svc.flushSync();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.settings.tts.providers.X.type, 'deepgram');
});
