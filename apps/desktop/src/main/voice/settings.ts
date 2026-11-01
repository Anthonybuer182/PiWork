/**
 * Voice providers and preferences, main-authoritative in `userData/voice.json`.
 *
 * Same shape as `preferences/tools.ts`: versioned JSON, atomic tmp+rename, a
 * single write chain. The renderer reads and writes through IPC only, because
 * transcription and synthesis run from main and the provider list must be
 * known there without a renderer round-trip.
 *
 * Built-ins (local sherpa STT/TTS, system speech) are NOT provider entries:
 * `builtin` selects one of them and is used only while `activeProvider` is
 * null. That keeps the user's provider list exactly what they configured.
 *
 * API keys are stored in plain text, exactly like `~/.pi/agent/models.json`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import type {
  BuiltinModelId,
  BuiltinSttEngine,
  BuiltinTtsEngine,
  VoiceCapability,
  VoiceCapabilitySettings,
  VoicePreferencesPatch,
  VoiceProviderEntry,
  VoiceProviderType,
  VoiceSettings,
} from '@pi/types';
import {
  BUILTIN_PROVIDER_SENTINEL,
  VOICE_PROVIDER_CAPABILITIES,
} from '@pi/types';

const STORAGE_VERSION = 2;

/** The name v1 used for the auto-seeded system-voice provider. */
export const LEGACY_SYSTEM_PROVIDER_NAME = '系统语音';

interface StoredVoiceFile {
  version: number;
  settings: VoiceSettings;
}

const KNOWN_TYPES = new Set<string>(Object.keys(VOICE_PROVIDER_CAPABILITIES));
/** Built-ins are synthesized by the resolver and never persisted as providers. */
const BUILTIN_ONLY_TYPES = new Set<string>(['sherpa-asr', 'sherpa-tts']);

const ASR_MODELS: BuiltinModelId[] = ['sensevoice', 'whisper-base', 'whisper-small'];
const TTS_MODELS: BuiltinModelId[] = ['melo-int8', 'kokoro'];

export interface VoiceSettingsServiceOptions {
  /** Test hook; production uses `process.platform`. */
  platform?: NodeJS.Platform;
}

export class VoiceSettingsService {
  private settings: VoiceSettings;
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  /** Incremented by flushSync so stale async writes cannot overwrite it. */
  private flushSeq = 0;
  private readonly instanceId = Math.random().toString(36).slice(2, 10);
  private readonly platform: NodeJS.Platform;

  constructor(
    private filePath: string,
    options: VoiceSettingsServiceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.settings = this.load();
  }

  get(): VoiceSettings {
    return structuredClone(this.settings);
  }

  /** Insert or update one provider, optionally renaming it. */
  saveProvider(input: unknown): VoiceSettings {
    const req = normalizeSaveRequest(input);
    const bucket = this.settings[req.capability];
    const provider = normalizeProvider(req.provider, req.capability);
    if (!provider) throw new Error('语音服务商类型无效，或该服务商不支持此能力');

    const existing = req.originalName;
    if (existing !== null && !Object.hasOwn(bucket.providers, existing)) {
      throw new Error(`语音服务商「${existing}」不存在`);
    }
    if (existing !== req.name && Object.hasOwn(bucket.providers, req.name)) {
      throw new Error(`语音服务商「${req.name}」已存在`);
    }

    if (existing !== null && existing !== req.name) {
      delete bucket.providers[existing];
      if (bucket.activeProvider === existing) bucket.activeProvider = req.name;
    }
    bucket.providers[req.name] = provider;
    // Only activate the very first provider when no built-in is selected.
    // `activeProvider: null` otherwise means "use the built-in", and editing
    // an unused cloud provider must not silently send audio to it.
    if (!bucket.activeProvider && bucket.builtin === 'off') {
      bucket.activeProvider = req.name;
    }

    this.persistSoon();
    return this.get();
  }

  deleteProvider(input: unknown): VoiceSettings {
    const { capability, name } = normalizeDeleteRequest(input);
    const bucket = this.settings[capability];
    delete bucket.providers[name];
    if (bucket.activeProvider === name) bucket.activeProvider = null;
    this.persistSoon();
    return this.get();
  }

  setPreferences(input: unknown): VoiceSettings {
    const { capability, patch } = normalizePreferencesRequest(input);
    const bucket = this.settings[capability];

    if (patch.builtin !== undefined) {
      validateBuiltin(patch.builtin, capability);
      if (
        capability === 'tts' &&
        patch.builtin === 'system-say' &&
        this.platform !== 'darwin' &&
        this.platform !== 'win32'
      ) {
        throw new Error('当前系统不支持内置系统语音');
      }
      bucket.builtin = patch.builtin;
      // Choosing a built-in means "stop using my provider". The reverse is
      // deliberately not true: selecting a provider leaves the builtin
      // configured but inactive, so switching back is one click.
      if (patch.builtin !== 'off') bucket.activeProvider = null;
    }
    if (patch.builtinModel !== undefined) {
      if (patch.builtinModel !== '') validateBuiltinModel(patch.builtinModel, capability);
      bucket.builtinModel = patch.builtinModel;
    }
    if (patch.activeProvider !== undefined) {
      const next = patch.activeProvider;
      if (next !== null && !Object.hasOwn(bucket.providers, next)) {
        throw new Error(`语音服务商「${next}」不存在`);
      }
      bucket.activeProvider = next;
    }
    if (patch.model !== undefined) bucket.model = patch.model.trim();
    if (patch.voice !== undefined) bucket.voice = patch.voice.trim();
    if (patch.language !== undefined) bucket.language = patch.language.trim();
    if (patch.autoSend !== undefined) bucket.autoSend = patch.autoSend;
    if (patch.autoRead !== undefined) bucket.autoRead = patch.autoRead;
    if (capability === 'stt') bucket.autoRead = false;

    this.persistSoon();
    return this.get();
  }

  /** Last-chance synchronous flush for the app's `will-quit`. */
  flushSync(): void {
    try {
      this.flushSeq += 1;
      const tmp = this.tempPath();
      writeFileSync(tmp, JSON.stringify(this.buildBody()), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[voice] could not flush voice settings:', err);
    }
  }

  // ── load / persist ───────────────────────────────────────────────

  private load(): VoiceSettings {
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
          version?: number;
          settings?: unknown;
        };
        if (parsed?.version === STORAGE_VERSION && parsed.settings) {
          return normalizeSettings(parsed.settings, this.platform);
        }
        if (parsed?.version === 1 && parsed.settings) {
          const migrated = migrateV1(
            normalizeSettings(parsed.settings, this.platform),
            this.platform,
          );
          this.settings = migrated;
          this.persistSoon();
          return migrated;
        }
      } catch (err) {
        console.warn(`[voice] could not read ${this.filePath}:`, err);
      }
      return normalizeSettings(undefined, this.platform);
    }
    return this.seed();
  }

  /** First run only: write the v2 defaults so "first run" is a fact on disk. */
  private seed(): VoiceSettings {
    const settings = normalizeSettings(undefined, this.platform);
    this.settings = settings;
    this.persistSoon();
    return settings;
  }

  private persistSoon(): void {
    const run = this.writeChain.then(() => this.writeNow());
    this.writeChain = run.catch(() => undefined);
  }

  private async writeNow(): Promise<void> {
    const tmp = this.tempPath();
    const flushSeq = this.flushSeq;
    try {
      await writeFile(tmp, JSON.stringify(this.buildBody()), 'utf8');
      // A synchronous flush at quit wrote a newer snapshot; renaming now
      // would restore the older state.
      if (this.flushSeq !== flushSeq) return;
      await rename(tmp, this.filePath);
    } catch (err) {
      console.warn('[voice] could not persist voice settings:', err);
    }
  }

  private tempPath(): string {
    this.writeSeq += 1;
    return `${this.filePath}.${process.pid}.${this.instanceId}.${this.writeSeq}.tmp`;
  }

  private buildBody(): StoredVoiceFile {
    return { version: STORAGE_VERSION, settings: this.settings };
  }
}

// ── migration ─────────────────────────────────────────────────────

/**
 * v1 seeded a "系统语音" provider and made it active. Now that system speech
 * is a built-in, an entry that is exactly our seed is redundant — remove it
 * and point the builtin at the same engine. Anything the user edited is left
 * untouched.
 */
function migrateV1(settings: VoiceSettings, platform: NodeJS.Platform): VoiceSettings {
  const tts = settings.tts;
  const seeded = tts.providers[LEGACY_SYSTEM_PROVIDER_NAME];
  const exactSeed =
    seeded &&
    seeded.type === 'system-say' &&
    Object.keys(seeded).length === 1;
  if (exactSeed) {
    delete tts.providers[LEGACY_SYSTEM_PROVIDER_NAME];
    if (tts.activeProvider === LEGACY_SYSTEM_PROVIDER_NAME) tts.activeProvider = null;
    tts.builtin =
      platform === 'darwin' || platform === 'win32' ? 'system-say' : 'local-tts';
    if (tts.builtin === 'local-tts' && !tts.builtinModel) tts.builtinModel = 'melo-int8';
  }
  // A v1 file could have been produced on a platform without system speech;
  // keep the normalized default in that case.
  return settings;
}

// ── normalization ──────────────────────────────────────────────────

function defaultSttBuiltin(): BuiltinSttEngine {
  return 'whisper';
}

function defaultTtsBuiltin(platform: NodeJS.Platform): BuiltinTtsEngine {
  return platform === 'darwin' || platform === 'win32' ? 'system-say' : 'local-tts';
}

function defaultCapability(
  capability: VoiceCapability,
  platform: NodeJS.Platform,
): VoiceCapabilitySettings {
  return {
    providers: {},
    activeProvider: null,
    model: '',
    voice: '',
    language: '',
    autoSend: false,
    autoRead: false,
    builtin: capability === 'stt' ? defaultSttBuiltin() : defaultTtsBuiltin(platform),
    builtinModel: capability === 'stt' ? 'sensevoice' : '',
  };
}

function normalizeSettings(raw: unknown, platform: NodeJS.Platform): VoiceSettings {
  const source = (raw ?? {}) as Partial<VoiceSettings>;
  return {
    stt: normalizeCapability(source.stt, 'stt', platform),
    tts: normalizeCapability(source.tts, 'tts', platform),
  };
}

function normalizeCapability(
  raw: unknown,
  capability: VoiceCapability,
  platform: NodeJS.Platform,
): VoiceCapabilitySettings {
  const settings = defaultCapability(capability, platform);
  const source = (raw ?? {}) as Partial<VoiceCapabilitySettings>;

  const providers: Record<string, VoiceProviderEntry> = {};
  if (source.providers && typeof source.providers === 'object') {
    for (const [name, entry] of Object.entries(source.providers)) {
      const cleanName = name.trim();
      const provider = normalizeProvider(entry, capability);
      // The sentinel is reserved for the dropdown; a hand-edited file must
      // not turn it into a real provider.
      if (cleanName && cleanName !== BUILTIN_PROVIDER_SENTINEL && provider) {
        providers[cleanName] = provider;
      }
    }
  }
  settings.providers = providers;

  const active = typeof source.activeProvider === 'string' ? source.activeProvider.trim() : '';
  settings.activeProvider = active && Object.hasOwn(providers, active) ? active : null;
  settings.model = typeof source.model === 'string' ? source.model.trim() : '';
  settings.voice = typeof source.voice === 'string' ? source.voice.trim() : '';
  settings.language = typeof source.language === 'string' ? source.language.trim() : '';
  settings.autoSend = capability === 'stt' && source.autoSend === true;
  settings.autoRead = capability === 'tts' && source.autoRead === true;

  if (typeof source.builtin === 'string' && isBuiltinValid(source.builtin, capability)) {
    settings.builtin = source.builtin as VoiceCapabilitySettings['builtin'];
  }
  if (typeof source.builtinModel === 'string' && isBuiltinModelValid(source.builtinModel, capability)) {
    settings.builtinModel = source.builtinModel as BuiltinModelId | '';
  }
  // A local TTS selection always needs a model id to know what to load.
  if (capability === 'tts' && settings.builtin === 'local-tts' && !settings.builtinModel) {
    settings.builtinModel = 'melo-int8';
  }
  // System speech only exists on macOS/Windows; don't leave Linux pointing at
  // an engine the resolver will reject.
  if (
    capability === 'tts' &&
    settings.builtin === 'system-say' &&
    platform !== 'darwin' &&
    platform !== 'win32'
  ) {
    settings.builtin = 'local-tts';
    settings.builtinModel = settings.builtinModel || 'melo-int8';
  }
  return settings;
}

function normalizeProvider(raw: unknown, capability: VoiceCapability): VoiceProviderEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<VoiceProviderEntry>;
  if (typeof entry.type !== 'string' || !KNOWN_TYPES.has(entry.type)) return null;
  if (BUILTIN_ONLY_TYPES.has(entry.type)) return null;
  const type = entry.type as VoiceProviderType;
  if (!VOICE_PROVIDER_CAPABILITIES[type][capability]) return null;

  const provider: VoiceProviderEntry = { type };
  const baseUrl = stringOrUndefined(entry.baseUrl);
  const apiKey = stringOrUndefined(entry.apiKey);
  const model = stringOrUndefined(entry.model);
  const voice = stringOrUndefined(entry.voice);
  const language = stringOrUndefined(entry.language);
  if (baseUrl) provider.baseUrl = baseUrl;
  if (apiKey) provider.apiKey = apiKey;
  if (model) provider.model = model;
  if (voice) provider.voice = voice;
  if (language) provider.language = language;

  if (entry.options && typeof entry.options === 'object') {
    const options: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.options)) {
      if (typeof value === 'string' && value.trim()) options[key.trim()] = value.trim();
    }
    if (Object.keys(options).length > 0) provider.options = options;
  }
  return provider;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ── validation ────────────────────────────────────────────────────

function isBuiltinValid(value: string, capability: VoiceCapability): boolean {
  if (capability === 'stt') return value === 'whisper' || value === 'off';
  return value === 'system-say' || value === 'local-tts' || value === 'off';
}

function validateBuiltin(value: unknown, capability: VoiceCapability): void {
  if (typeof value !== 'string' || !isBuiltinValid(value, capability)) {
    throw new Error('内置语音引擎无效');
  }
}

function isBuiltinModelValid(value: string, capability: VoiceCapability): boolean {
  if (capability === 'stt') return ASR_MODELS.includes(value as BuiltinModelId);
  return value === '' || TTS_MODELS.includes(value as BuiltinModelId);
}

function validateBuiltinModel(value: unknown, capability: VoiceCapability): void {
  if (typeof value !== 'string' || !isBuiltinModelValid(value, capability)) {
    throw new Error('内置语音模型无效');
  }
}

function normalizeSaveRequest(raw: unknown): {
  capability: VoiceCapability;
  originalName: string | null;
  name: string;
  provider: unknown;
} {
  const req = (raw ?? {}) as Record<string, unknown>;
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (!name) throw new Error('请填写语音服务商名称');
  if (name === BUILTIN_PROVIDER_SENTINEL) throw new Error('该名称保留给内置语音');
  // `__proto__` would set the map's prototype instead of adding an entry.
  if (name === '__proto__') throw new Error('该名称不可用');
  return {
    capability: normalizeCapabilityId(req.capability),
    originalName: typeof req.originalName === 'string' ? req.originalName : null,
    name,
    provider: req.provider,
  };
}

function normalizeDeleteRequest(raw: unknown): { capability: VoiceCapability; name: string } {
  const req = (raw ?? {}) as Record<string, unknown>;
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (!name) throw new Error('缺少语音服务商名称');
  return { capability: normalizeCapabilityId(req.capability), name };
}

function normalizePreferencesRequest(raw: unknown): {
  capability: VoiceCapability;
  patch: VoicePreferencesPatch;
} {
  const req = (raw ?? {}) as Record<string, unknown>;
  const capability = normalizeCapabilityId(req.capability);
  const patch = (req.patch ?? {}) as VoicePreferencesPatch;
  const clean: VoicePreferencesPatch = {};
  if (patch.activeProvider !== undefined) {
    if (patch.activeProvider !== null && typeof patch.activeProvider !== 'string') {
      throw new Error('语音服务商无效');
    }
    clean.activeProvider = patch.activeProvider;
  }
  for (const key of ['model', 'voice', 'language'] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'string') throw new Error('语音设置格式无效');
      clean[key] = patch[key] as string;
    }
  }
  for (const key of ['autoSend', 'autoRead'] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') throw new Error('语音设置格式无效');
      clean[key] = patch[key] as boolean;
    }
  }
  if (patch.builtin !== undefined) {
    validateBuiltin(patch.builtin, capability);
    clean.builtin = patch.builtin;
  }
  if (patch.builtinModel !== undefined) {
    if (patch.builtinModel !== '') validateBuiltinModel(patch.builtinModel, capability);
    clean.builtinModel = patch.builtinModel;
  }
  return { capability, patch: clean };
}

function normalizeCapabilityId(raw: unknown): VoiceCapability {
  if (raw !== 'stt' && raw !== 'tts') throw new Error('语音能力无效');
  return raw;
}
