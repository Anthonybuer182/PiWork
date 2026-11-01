/**
 * Protocol registry and provider resolution.
 *
 * Two kinds of provider exist:
 *  - user entries from voice.json, looked up by name;
 *  - built-ins, selected by `settings.<capability>.builtin` and used only when
 *    no named provider is active. Built-ins are synthesized here so they never
 *    appear in (or pollute) the user's provider list.
 *
 * Adapters are looked up by protocol family; the capability check happens here
 * so an STT-only entry can never be used for speech (or vice versa).
 */

import type {
  BuiltinModelId,
  BuiltinModelKind,
  VoiceCapability,
  VoiceSettings,
} from '@pi/types';
import {
  BUILTIN_STT_NAME,
  BUILTIN_TTS_LOCAL_NAME,
  BUILTIN_TTS_SYSTEM_NAME,
  VOICE_PROVIDER_CAPABILITIES,
} from '@pi/types';
import { openAiAdapter } from './adapters/openai.js';
import { azureAdapter } from './adapters/azure.js';
import { elevenLabsAdapter } from './adapters/elevenlabs.js';
import { deepgramAdapter } from './adapters/deepgram.js';
import { geminiAdapter } from './adapters/gemini.js';
import { customHttpAdapter } from './adapters/custom-http.js';
import { systemTtsAdapter } from './adapters/system-tts.js';
import { localWhisperAdapter } from './adapters/local-whisper.js';
import { sherpaAsrAdapter } from './adapters/sherpa-asr.js';
import { sherpaTtsAdapter } from './adapters/sherpa-tts.js';
import {
  BUILTIN_MODELS,
  formatMegabytes,
  isBuiltinModelId,
  modelTotalBytes,
} from './builtin/models.js';
import type { VoiceAdapter, ResolvedVoiceProvider } from './types.js';

const ADAPTERS: Record<string, VoiceAdapter> = {
  'openai-audio': openAiAdapter,
  'azure-openai-audio': azureAdapter,
  elevenlabs: elevenLabsAdapter,
  deepgram: deepgramAdapter,
  gemini: geminiAdapter,
  'custom-http': customHttpAdapter,
  'system-say': systemTtsAdapter,
  'local-whisper': localWhisperAdapter,
  'sherpa-asr': sherpaAsrAdapter,
  'sherpa-tts': sherpaTtsAdapter,
};

export function adapterFor(provider: ResolvedVoiceProvider): VoiceAdapter {
  const adapter = ADAPTERS[provider.entry.type];
  if (!adapter) throw new Error(`不支持的语音协议：${provider.entry.type}`);
  return adapter;
}

export function supportsCapability(
  provider: ResolvedVoiceProvider,
  capability: VoiceCapability,
): boolean {
  const adapter = ADAPTERS[provider.entry.type];
  if (!adapter) return false;
  const declared = VOICE_PROVIDER_CAPABILITIES[provider.entry.type]?.[capability] ?? false;
  const method = capability === 'stt' ? adapter.transcribe : adapter.synthesize;
  return declared && typeof method === 'function';
}

export interface ResolveVoiceOptions {
  /** Built-in models are consulted only when a built-in is selected. */
  isModelInstalled?: (id: BuiltinModelId) => boolean;
  /** Directory containing the downloaded model folders. */
  modelRoot?: string;
  platform?: NodeJS.Platform;
}

/**
 * Resolve a provider name (or the active provider, or the built-in fallback)
 * and apply capability-level overrides. Throws a Chinese error the renderer
 * can show as-is.
 */
export function resolveVoiceProvider(
  settings: VoiceSettings,
  capability: VoiceCapability,
  providerName?: string,
  options: ResolveVoiceOptions = {},
): ResolvedVoiceProvider {
  const bucket = settings[capability];
  const name = providerName || bucket.activeProvider;
  if (name) return resolveNamedProvider(settings, capability, name);
  return resolveBuiltin(settings, capability, options);
}

function resolveNamedProvider(
  settings: VoiceSettings,
  capability: VoiceCapability,
  name: string,
): ResolvedVoiceProvider {
  const bucket = settings[capability];
  if (!Object.hasOwn(bucket.providers, name)) {
    throw new Error(`语音服务商「${name}」不存在`);
  }
  const entry = bucket.providers[name];

  const provider: ResolvedVoiceProvider = {
    name,
    entry,
    model: bucket.model || entry.model || '',
    voice: bucket.voice || entry.voice || '',
    language: bucket.language || entry.language || '',
  };
  if (!supportsCapability(provider, capability)) {
    throw new Error(`语音服务商「${name}」不支持${capability === 'stt' ? '语音识别' : '语音合成'}`);
  }
  return provider;
}

function resolveBuiltin(
  settings: VoiceSettings,
  capability: VoiceCapability,
  options: ResolveVoiceOptions,
): ResolvedVoiceProvider {
  const bucket = settings[capability];

  if (capability === 'stt') {
    if (bucket.builtin !== 'whisper') {
      throw new Error('语音识别未配置，请先在设置 → 语音中启用内置识别或添加服务商。');
    }
    const modelId = normalizeBuiltinModel(bucket.builtinModel, 'asr');
    assertModelReady(modelId, options);
    return {
      name: BUILTIN_STT_NAME,
      entry: {
        type: 'sherpa-asr',
        options: { modelId, modelRoot: options.modelRoot ?? '' },
      },
      model: modelId,
      voice: '',
      language: bucket.language,
    };
  }

  if (bucket.builtin === 'system-say') {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new Error('当前系统不支持内置系统语音，请改用本地神经语音或配置语音服务商。');
    }
    return {
      name: BUILTIN_TTS_SYSTEM_NAME,
      entry: { type: 'system-say' },
      model: '',
      voice: bucket.voice,
      language: bucket.language,
    };
  }

  if (bucket.builtin === 'local-tts') {
    const modelId = normalizeBuiltinModel(bucket.builtinModel || 'melo-int8', 'tts');
    assertModelReady(modelId, options);
    return {
      name: BUILTIN_TTS_LOCAL_NAME,
      entry: {
        type: 'sherpa-tts',
        options: { modelId, modelRoot: options.modelRoot ?? '' },
      },
      model: modelId,
      voice: bucket.voice,
      language: bucket.language,
    };
  }

  throw new Error('语音合成未配置，请先在设置 → 语音中启用内置朗读或添加服务商。');
}

function normalizeBuiltinModel(raw: string, kind: BuiltinModelKind): BuiltinModelId {
  if (isBuiltinModelId(raw) && BUILTIN_MODELS[raw].kind === kind) return raw;
  return kind === 'asr' ? 'sensevoice' : 'melo-int8';
}

function assertModelReady(modelId: BuiltinModelId, options: ResolveVoiceOptions): void {
  if (!options.isModelInstalled || options.isModelInstalled(modelId)) return;
  const kind = BUILTIN_MODELS[modelId].kind;
  const label = kind === 'asr' ? '语音识别' : '语音合成';
  const size = formatMegabytes(modelTotalBytes(BUILTIN_MODELS[modelId]));
  throw new Error(
    `内置${label}模型尚未下载，请在设置 → 语音中下载（约 ${size} MB）。`,
  );
}
