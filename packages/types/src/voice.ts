/**
 * Voice (语音) configuration shared by the renderer and the main process.
 *
 * Speech input (STT) and speech output (TTS) are configured independently:
 * an app may transcribe with one vendor and speak with another, and a vendor
 * may support only one direction. Entries live in two separate provider maps
 * for that reason — an entry is always owned by exactly one capability.
 */

export type VoiceCapability = 'stt' | 'tts';

/**
 * Protocol families, not vendors. `openai-audio` is the universal path: any
 * gateway that speaks the OpenAI audio endpoints works by filling in a base
 * URL. `custom-http` is the escape hatch for everything else (火山, 讯飞 …).
 */
export type VoiceProviderType =
  | 'openai-audio'
  | 'azure-openai-audio'
  | 'elevenlabs'
  | 'deepgram'
  | 'gemini'
  | 'custom-http'
  | 'system-say'
  | 'local-whisper'
  // Built-in engines: never offered in the add-provider dialog.
  | 'sherpa-asr'
  | 'sherpa-tts';

/** Built-in STT engines. `whisper` means the bundled sherpa runtime. */
export type BuiltinSttEngine = 'whisper' | 'off';
/** Built-in TTS engines. `local-tts` means the bundled sherpa runtime. */
export type BuiltinTtsEngine = 'system-say' | 'local-tts' | 'off';

/** Models downloadable at runtime, stored under userData/voice-models. */
export type BuiltinModelId =
  | 'sensevoice'
  | 'whisper-base'
  | 'whisper-small'
  | 'melo-int8'
  | 'kokoro';

export type BuiltinModelKind = 'asr' | 'tts';

export interface VoiceBuiltinModel {
  id: BuiltinModelId;
  kind: BuiltinModelKind;
  sizeBytes: number;
  installed: boolean;
  downloading: boolean;
}

export interface VoiceModelProgress {
  modelId: BuiltinModelId;
  phase: 'downloading' | 'done' | 'error' | 'cancelled';
  /** File currently being downloaded. */
  file?: string;
  receivedBytes: number;
  totalBytes: number;
  message?: string;
}

export interface VoiceProviderEntry {
  type: VoiceProviderType;
  /** Base URL, e.g. `https://api.openai.com/v1`. Empty means the adapter default. */
  baseUrl?: string;
  apiKey?: string;
  /** Model id; for Azure this is the deployment name. */
  model?: string;
  /** TTS voice id / Gemini prebuilt voice name / macOS `say -v` voice. */
  voice?: string;
  /** STT language hint (ISO-639-1 where the vendor accepts it). */
  language?: string;
  /**
   * Adapter-specific knobs kept as strings so the provider dialog stays a
   * simple form: `apiVersion` (Azure), `sttPath`/`ttsPath` (OpenAI gateways),
   * custom-HTTP templates, whisper binary/model paths.
   */
  options?: Record<string, string>;
}

export interface VoiceCapabilitySettings {
  providers: Record<string, VoiceProviderEntry>;
  /** Name of the provider used by the composer / speak button. */
  activeProvider: string | null;
  /** Capability-level overrides; empty means use the provider entry's value. */
  model: string;
  voice: string;
  language: string;
  /** STT only: send immediately after transcription instead of filling the composer. */
  autoSend: boolean;
  /** TTS only: read each reply aloud once it finishes, when this window is focused. */
  autoRead: boolean;
  /**
   * Built-in default used when `activeProvider` is null. Built-ins are not
   * entries in `providers`; they are resolved at request time so the user's
   * provider list stays exactly what they configured.
   */
  builtin: BuiltinSttEngine | BuiltinTtsEngine;
  /** Model for the built-in engine (empty for system speech). */
  builtinModel: BuiltinModelId | '';
}

export interface VoiceSettings {
  stt: VoiceCapabilitySettings;
  tts: VoiceCapabilitySettings;
}

/** A capability-level preference patch from the settings page. */
export interface VoicePreferencesPatch {
  activeProvider?: string | null;
  model?: string;
  voice?: string;
  language?: string;
  autoSend?: boolean;
  autoRead?: boolean;
  builtin?: BuiltinSttEngine | BuiltinTtsEngine;
  builtinModel?: BuiltinModelId | '';
}

export interface VoiceTranscribeRequest {
  /** Omit to use the active STT provider. */
  providerName?: string;
  /** 16 kHz mono 16-bit WAV, encoded in the renderer. */
  audio: Uint8Array;
  mimeType: string;
  language?: string;
}

export interface VoiceTranscribeResult {
  text: string;
  provider: string;
}

export interface VoiceSynthesizeRequest {
  /** Omit to use the active TTS provider. */
  providerName?: string;
  text: string;
  voice?: string;
  language?: string;
  /** Playback generation; queued requests older than a cancel are dropped. */
  generation?: number;
}

export interface VoiceSynthesizeResult {
  audioBase64: string;
  mimeType: string;
  provider: string;
}

/** Which direction each protocol family implements. */
export const VOICE_PROVIDER_CAPABILITIES: Record<
  VoiceProviderType,
  { stt: boolean; tts: boolean }
> = {
  'openai-audio': { stt: true, tts: true },
  'azure-openai-audio': { stt: true, tts: true },
  elevenlabs: { stt: true, tts: true },
  deepgram: { stt: true, tts: true },
  gemini: { stt: true, tts: true },
  'custom-http': { stt: true, tts: true },
  'system-say': { stt: false, tts: true },
  'local-whisper': { stt: true, tts: false },
  'sherpa-asr': { stt: true, tts: false },
  'sherpa-tts': { stt: false, tts: true },
};

/** Names the settings UI uses for built-ins; never persisted as providers. */
export const BUILTIN_STT_NAME = '内置识别';
export const BUILTIN_TTS_SYSTEM_NAME = '内置朗读（系统）';
export const BUILTIN_TTS_LOCAL_NAME = '内置朗读（本地）';

/** Reserved dropdown sentinel: "use the built-in". */
export const BUILTIN_PROVIDER_SENTINEL = '__builtin__';
