/**
 * Built-in selection vs. a user provider: which one wins, what the synthetic
 * provider looks like, and how missing models / platforms are reported.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceSettingsService } from '../src/main/voice/settings.ts';
import {
  adapterFor,
  resolveVoiceProvider,
  supportsCapability,
} from '../src/main/voice/registry.ts';

function service(t, platform = 'darwin') {
  const dir = mkdtempSync(join(tmpdir(), 'pi-voice-resolver-'));
  t.after(() => {
    // A pending atomic write can recreate a temp file mid-rimraf; leftover
    // temp directories are harmless, so a failed cleanup must not fail a test.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch {
      /* ignored */
    }
  });
  return new VoiceSettingsService(join(dir, 'voice.json'), { platform });
}

const installed = () => true;
const missing = () => false;

test('an active user provider wins over the builtin', (t) => {
  const svc = service(t);
  svc.saveProvider({
    capability: 'stt',
    originalName: null,
    name: 'Mine',
    provider: { type: 'openai-audio', baseUrl: 'https://x/v1' },
  });
  svc.setPreferences({ capability: 'stt', patch: { activeProvider: 'Mine' } });
  const provider = resolveVoiceProvider(svc.get(), 'stt', undefined, {
    isModelInstalled: missing,
    modelRoot: '/models',
  });
  assert.equal(provider.name, 'Mine');
  assert.equal(provider.entry.type, 'openai-audio');
});

test('the builtin STT is used when nothing is active', (t) => {
  const svc = service(t);
  const provider = resolveVoiceProvider(svc.get(), 'stt', undefined, {
    isModelInstalled: installed,
    modelRoot: '/models',
  });
  assert.equal(provider.name, '内置识别');
  assert.equal(provider.entry.type, 'sherpa-asr');
  assert.equal(provider.entry.options.modelId, 'sensevoice');
  assert.equal(provider.entry.options.modelRoot, '/models');
  assert.ok(supportsCapability(provider, 'stt'));
  assert.ok(!supportsCapability(provider, 'tts'));
  assert.equal(adapterFor(provider).transcribe instanceof Function, true);
});

test('a missing builtin model is reported with its size', (t) => {
  const svc = service(t);
  assert.throws(
    () => resolveVoiceProvider(svc.get(), 'stt', undefined, {
      isModelInstalled: missing,
      modelRoot: '/models',
    }),
    /尚未下载.*228 MB/,
  );
});

test('turning the builtin off falls back to a configuration error', (t) => {
  const svc = service(t);
  svc.setPreferences({ capability: 'stt', patch: { builtin: 'off' } });
  assert.throws(
    () => resolveVoiceProvider(svc.get(), 'stt', undefined, { isModelInstalled: installed }),
    /未配置/,
  );
});

test('system speech is the default TTS on macOS/Windows only', (t) => {
  const mac = service(t, 'darwin').get();
  // Both halves must pass the platform explicitly. The resolver falls back to
  // `process.platform`, so without it this test asserted macOS behaviour while
  // running on the Linux CI runner — green locally, red on every push.
  const provider = resolveVoiceProvider(mac, 'tts', undefined, { platform: 'darwin' });
  assert.equal(provider.entry.type, 'system-say');
  assert.equal(provider.name, '内置朗读（系统）');

  const linux = service(t, 'linux').get();
  linux.tts.builtin = 'system-say';
  assert.throws(
    () => resolveVoiceProvider(linux, 'tts', undefined, { platform: 'linux' }),
    /不支持内置系统语音/,
  );
});

test('local neural TTS resolves to the sherpa adapter when installed', (t) => {
  const svc = service(t, 'linux');
  assert.throws(
    () => resolveVoiceProvider(svc.get(), 'tts', undefined, {
      isModelInstalled: missing,
      modelRoot: '/models',
    }),
    /尚未下载.*69 MB/,
  );

  const provider = resolveVoiceProvider(svc.get(), 'tts', undefined, {
    isModelInstalled: installed,
    modelRoot: '/models',
  });
  assert.equal(provider.name, '内置朗读（本地）');
  assert.equal(provider.entry.type, 'sherpa-tts');
  assert.equal(provider.entry.options.modelId, 'melo-int8');
  assert.ok(supportsCapability(provider, 'tts'));
});

test('a spoken voice id maps to the local model selection', (t) => {
  const svc = service(t, 'linux');
  svc.setPreferences({ capability: 'tts', patch: { voice: '2', builtin: 'local-tts' } });
  const provider = resolveVoiceProvider(svc.get(), 'tts', undefined, {
    isModelInstalled: installed,
    modelRoot: '/models',
  });
  assert.equal(provider.voice, '2');
});
