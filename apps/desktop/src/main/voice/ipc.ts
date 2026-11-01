/**
 * `pi:voice:*` handlers.
 *
 * Transcribe/synthesize are the only channels that make outbound requests;
 * the preference channels just read and write `voice.json`. Payload shapes are
 * validated here because the renderer is the untrusted side of every send.
 */

import { ipcMain } from 'electron';
import type { VoiceSynthesizeRequest, VoiceTranscribeRequest } from '@pi/types';
import { VoiceSettingsService } from './settings.js';
import { VoiceModelManager } from './builtin/model-manager.js';
import { isBuiltinModelId } from './builtin/models.js';
import { adapterFor, resolveVoiceProvider } from './registry.js';
import { voiceInference } from './builtin/inference-client.js';

/** A 120 s 16 kHz mono WAV is ~3.8 MB; allow generous headroom. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** One sentence chunk as produced by the renderer, with room for long ones. */
const MAX_TTS_CHARS = 4000;

export function warmLocalTts(
  service: VoiceSettingsService,
  modelManager: VoiceModelManager,
): void {
  const settings = service.get();
  if (settings.tts.activeProvider || settings.tts.builtin !== 'local-tts') return;
  const modelId = (settings.tts.builtinModel || 'melo-int8') as Parameters<VoiceModelManager['isInstalled']>[0];
  if (!modelManager.isInstalled(modelId)) return;
  void voiceInference.warmTts(modelId, modelManager.root).catch(() => undefined);
}

export interface VoiceIpcHooks {
  /** Renderer reports start/stop of a plugin-owned read-aloud (key `plugin:*`). */
  onPluginPlayback?: (key: string, playing: boolean) => void;
}

export function registerVoiceIpc(
  service: VoiceSettingsService,
  modelManager: VoiceModelManager,
  hooks: VoiceIpcHooks = {},
): void {
  const resolveOptions = {
    isModelInstalled: (id: Parameters<typeof modelManager.isInstalled>[0]) =>
      modelManager.isInstalled(id),
    modelRoot: modelManager.root,
  };

  ipcMain.handle('pi:voice:get', () => service.get());

  ipcMain.handle('pi:voice:get-models', () => modelManager.list());

  ipcMain.handle('pi:voice:download-model', async (event, request: unknown) => {
    const modelId = (request as { modelId?: unknown } | undefined)?.modelId;
    if (!isBuiltinModelId(modelId)) throw new Error('未知的内置语音模型');
    await modelManager.ensure(modelId, event.sender);
    warmLocalTts(service, modelManager);
    return modelManager.list();
  });

  ipcMain.handle('pi:voice:cancel-model-download', (_event, request: unknown) => {
    const modelId = (request as { modelId?: unknown } | undefined)?.modelId;
    if (!isBuiltinModelId(modelId)) throw new Error('未知的内置语音模型');
    modelManager.cancel(modelId);
  });

  ipcMain.handle('pi:voice:plugin-playback', (_event, request: unknown) => {
    const req = (request ?? {}) as { key?: unknown; playing?: unknown };
    const key = typeof req.key === 'string' ? req.key : '';
    if (!key.startsWith('plugin:')) return;
    hooks.onPluginPlayback?.(key, req.playing === true);
  });

  ipcMain.handle('pi:voice:cancel-synthesis', (_event, request: unknown) => {
    const generation = (request as { generation?: unknown } | undefined)?.generation;
    voiceInference.cancelPendingSynthesis(
      typeof generation === 'number' ? generation : Number.MAX_SAFE_INTEGER,
    );
  });

  ipcMain.handle('pi:voice:delete-model', async (_event, request: unknown) => {
    const modelId = (request as { modelId?: unknown } | undefined)?.modelId;
    if (!isBuiltinModelId(modelId)) throw new Error('未知的内置语音模型');
    return modelManager.delete(modelId);
  });

  ipcMain.handle('pi:voice:save-provider', (_event, request: unknown) => {
    const next = service.saveProvider(request);
    warmLocalTts(service, modelManager);
    return next;
  });

  ipcMain.handle('pi:voice:delete-provider', (_event, request: unknown) => {
    const next = service.deleteProvider(request);
    warmLocalTts(service, modelManager);
    return next;
  });

  ipcMain.handle('pi:voice:set-preferences', (_event, request: unknown) => {
    const next = service.setPreferences(request);
    warmLocalTts(service, modelManager);
    return next;
  });

  ipcMain.handle('pi:voice:transcribe', async (_event, request: unknown) => {
    const req = (request ?? {}) as Partial<VoiceTranscribeRequest>;
    const audio = toBuffer(req.audio);
    if (!audio || audio.length === 0) throw new Error('没有收到录音数据');
    if (audio.length > MAX_AUDIO_BYTES) throw new Error('录音过长，请控制在两分钟以内');

    const provider = resolveVoiceProvider(service.get(), 'stt', req.providerName, resolveOptions);
    if (typeof req.language === 'string' && req.language.trim()) {
      provider.language = req.language.trim();
    }
    const adapter = adapterFor(provider);
    if (!adapter.transcribe) throw new Error(`语音服务商「${provider.name}」不支持语音识别`);

    const text = (await adapter.transcribe(provider, audio)).trim();
    return { text, provider: provider.name };
  });

  ipcMain.handle('pi:voice:synthesize', async (_event, request: unknown) => {
    const req = (request ?? {}) as Partial<VoiceSynthesizeRequest>;
    const text = typeof req.text === 'string' ? req.text.trim() : '';
    if (!text) throw new Error('没有可朗读的文本');
    if (text.length > MAX_TTS_CHARS) throw new Error('朗读文本过长');

    const provider = resolveVoiceProvider(service.get(), 'tts', req.providerName, resolveOptions);
    if (typeof req.voice === 'string' && req.voice.trim()) provider.voice = req.voice.trim();
    if (typeof req.generation === 'number') provider.generation = req.generation;
    if (typeof req.language === 'string' && req.language.trim()) {
      provider.language = req.language.trim();
    }
    const adapter = adapterFor(provider);
    if (!adapter.synthesize) throw new Error(`语音服务商「${provider.name}」不支持语音合成`);

    const audio = await adapter.synthesize(provider, text);
    return {
      audioBase64: audio.bytes.toString('base64'),
      mimeType: audio.mimeType,
      provider: provider.name,
    };
  });
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}
