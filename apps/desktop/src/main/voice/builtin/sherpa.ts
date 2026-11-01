/**
 * Lazy loader and instance caches for the sherpa-onnx native runtime.
 *
 * The addon is an external npm dependency: in dev it resolves from
 * node_modules, and in a packaged app it must be loaded from
 * `app.asar.unpacked` because `.node`/`.dylib` files cannot live inside an
 * asar archive. Creating a recognizer/TTS instance costs 1–3 s, so instances
 * are cached per model id and creation is guarded against duplicate loads.
 */

import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import type { BuiltinModelId } from '@pi/types';
import { BUILTIN_MODELS } from './models.js';

export interface SherpaResult {
  text?: string;
}

export interface SherpaRecognizer {
  createStream: () => {
    acceptWaveform: (wave: { samples: Float32Array; sampleRate: number }) => void;
  };
  decodeAsync?: (stream: unknown) => Promise<SherpaResult>;
  decode?: (stream: unknown) => void;
  getResult?: (stream: unknown) => SherpaResult;
}

export interface SherpaTts {
  sampleRate: number;
  generateAsync: (request: {
    text: string;
    sid?: number;
    speed?: number;
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | void;
  }) => Promise<{ samples: Float32Array; sampleRate: number }>;
}

interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
  OfflineTts: new (config: unknown) => SherpaTts;
}

let modulePromise: Promise<SherpaModule> | null = null;

export async function loadSherpa(): Promise<SherpaModule> {
  modulePromise ??= (async () => {
    try {
      // The package is CommonJS: under ESM `import()` its exports live on
      // `.default`, with no named re-exports unless Node can statically see
      // them (it cannot for this module).
      const imported = (await import('sherpa-onnx-node')) as unknown as {
        default?: SherpaModule;
      } & Partial<SherpaModule>;
      const resolved = (imported.default ?? imported) as unknown as SherpaModule;
      if (!resolved.OfflineRecognizer || !resolved.OfflineTts) {
        throw new Error('sherpa-onnx 模块缺少预期的导出');
      }
      return resolved;
    } catch (first) {
      // Packaged: the addon was unpacked next to the asar, not inside it.
      try {
        const require = createRequire(import.meta.url);
        const resolved = require.resolve('sherpa-onnx-node');
        const unpacked = resolved.replace(
          `app.asar${sep}`,
          `app.asar.unpacked${sep}`,
        );
        return require(unpacked) as SherpaModule;
      } catch {
        throw first;
      }
    }
  })().catch((err) => {
    modulePromise = null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `本地语音引擎加载失败：${message}。请确认安装包完整，或改用其他语音服务商。`,
    );
  });
  return modulePromise;
}

// ── recognition ───────────────────────────────────────────────────

export function buildRecognizerConfig(
  id: BuiltinModelId,
  dir: string,
  language: string,
): unknown {
  const featConfig = { sampleRate: 16_000, featureDim: 80 };
  if (id === 'sensevoice') {
    return {
      featConfig,
      modelConfig: {
        senseVoice: {
          model: join(dir, 'model.int8.onnx'),
          language: language || 'auto',
          useInverseTextNormalization: 1,
        },
        tokens: join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    };
  }

  const prefix = id === 'whisper-base' ? 'base' : 'small';
  return {
    featConfig,
    modelConfig: {
      whisper: {
        encoder: join(dir, `${prefix}-encoder.int8.onnx`),
        decoder: join(dir, `${prefix}-decoder.int8.onnx`),
        language: language || 'zh',
        task: 'transcribe',
      },
      tokens: join(dir, `${prefix}-tokens.txt`),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  };
}

export function buildTtsConfig(id: BuiltinModelId, dir: string): unknown {
  if (id === 'kokoro') {
    return {
      model: {
        kokoro: {
          model: join(dir, 'model.onnx'),
          voices: join(dir, 'voices.bin'),
          tokens: join(dir, 'tokens.txt'),
          // Chinese/English lexicons are comma-separated in sherpa-onnx.
          lexicon: [join(dir, 'lexicon-us-en.txt'), join(dir, 'lexicon-zh.txt')].join(','),
          dictDir: join(dir, 'dict'),
        },
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      ruleFsts: [
        join(dir, 'date-zh.fst'),
        join(dir, 'number-zh.fst'),
        join(dir, 'phone-zh.fst'),
      ].join(','),
      maxNumSentences: 1,
    };
  }
  return {
    model: {
      vits: {
        model: join(dir, 'model.int8.onnx'),
        lexicon: join(dir, 'lexicon.txt'),
        tokens: join(dir, 'tokens.txt'),
        dictDir: join(dir, 'dict'),
      },
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    ruleFsts: [
      join(dir, 'date.fst'),
      join(dir, 'number.fst'),
      join(dir, 'phone.fst'),
    ].join(','),
    maxNumSentences: 1,
  };
}

const recognizers = new Map<string, Promise<SherpaRecognizer>>();
const ttsInstances = new Map<BuiltinModelId, Promise<SherpaTts>>();

export function getRecognizer(
  id: BuiltinModelId,
  dir: string,
  language: string,
): Promise<SherpaRecognizer> {
  // The language is baked into the config at construction, so it is part of
  // the cache key; otherwise changing the setting needs an app restart.
  const cacheKey = `${id}:${language}`;
  let cached = recognizers.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const sherpa = await loadSherpa();
      const config = buildRecognizerConfig(id, dir, language);
      // The packaged addon's async factory rejects with "settlement failed";
      // the synchronous constructor loads the same files in ~0.5 s and is
      // cached, so it is the reliable path.
      return new sherpa.OfflineRecognizer(config);
    })().catch((err) => {
      recognizers.delete(cacheKey);
      throw err;
    });
    recognizers.set(cacheKey, cached);
  }
  return cached;
}

export function getTts(id: BuiltinModelId, dir: string): Promise<SherpaTts> {
  let cached = ttsInstances.get(id);
  if (!cached) {
    cached = (async () => {
      const sherpa = await loadSherpa();
      const config = buildTtsConfig(id, dir);
      return new sherpa.OfflineTts(config);
    })().catch((err) => {
      ttsInstances.delete(id);
      throw err;
    });
    ttsInstances.set(id, cached);
  }
  return cached;
}

/**
 * Synthesize through the streaming callback instead of the returned buffer.
 *
 * Electron's V8 memory cage rejects the external ArrayBuffer the addon builds
 * for the final result ("External buffers are not allowed"), so `generateAsync`
 * rejects *after* delivering every audio chunk through `onProgress`. The
 * chunks themselves are ordinary typed arrays and arrive intact, so use them
 * and treat the rejection as end-of-stream. If nothing arrived, the failure is
 * real and is rethrown.
 */
export async function synthesizeWithSherpa(
  tts: SherpaTts,
  request: { text: string; sid?: number; speed?: number },
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  try {
    const result = await tts.generateAsync({
      ...request,
      onProgress: (info) => {
        if (info?.samples?.length) {
          chunks.push(info.samples.slice());
          totalSamples += info.samples.length;
        }
        return 1;
      },
    });
    if (result?.samples?.length) {
      return { samples: result.samples, sampleRate: result.sampleRate };
    }
  } catch (err) {
    if (totalSamples === 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`本地语音合成失败：${message}`);
    }
  }
  if (totalSamples === 0) throw new Error('本地语音合成没有返回音频');
  const samples = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { samples, sampleRate: tts.sampleRate };
}

/** Drop cached instances after the model files are deleted. */
export function evictBuiltinModel(id: BuiltinModelId): void {
  for (const key of recognizers.keys()) {
    if (key.startsWith(`${id}:`)) recognizers.delete(key);
  }
  ttsInstances.delete(id);
}

export function modelFilesPresent(id: BuiltinModelId): boolean {
  return id in BUILTIN_MODELS;
}
