/**
 * Conversion between the renderer's WAV and the float samples sherpa wants.
 *
 * The renderer always produces 16 kHz mono 16-bit PCM, so the reader validates
 * exactly that instead of quietly feeding a model the wrong format.
 */

import { wrapPcm16ToWav } from '../wav.js';

export interface ParsedWav {
  sampleRate: number;
  samples: Float32Array;
}

export function wav16kToFloat32(wav: Buffer): Float32Array {
  if (wav.length < 44) throw new Error('录音数据无效');
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('录音格式不是 WAV');
  }

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(wav.length, bodyStart + size);

    if (id === 'fmt ' && bodyStart + 16 <= wav.length) {
      format = wav.readUInt16LE(bodyStart);
      channels = wav.readUInt16LE(bodyStart + 2);
      sampleRate = wav.readUInt32LE(bodyStart + 4);
      bitsPerSample = wav.readUInt16LE(bodyStart + 14);
    } else if (id === 'data') {
      data = wav.subarray(bodyStart, bodyEnd);
    }

    offset = bodyStart + size + (size % 2);
  }

  if (!data) throw new Error('录音数据缺少音频段');
  if (format !== 1 || bitsPerSample !== 16) throw new Error('录音必须是 16-bit PCM');
  if (channels !== 1) throw new Error('录音必须是单声道');
  if (sampleRate !== 16_000) throw new Error('录音必须是 16kHz 采样率');

  const sampleCount = Math.floor(data.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = data.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

/**
 * Even out per-chunk loudness and remove clicks at chunk boundaries.
 *
 * Chunks are synthesized independently, so their peaks differ; normalizing to
 * a common peak keeps the volume stable between sentences. A few milliseconds
 * of fade at both ends prevents the speaker from clicking when clips abut.
 */
export function normalizeAndFade(samples: Float32Array, sampleRate: number): Float32Array {
  if (samples.length === 0) return samples;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  const target = 0.95;
  // Quiet speech is boosted up to 6x; near-silence is left alone so noise is
  // not amplified into a hiss.
  const gain = peak > 0.01 ? Math.min(6, target / peak) : 1;

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain;

  const fade = Math.min(Math.round(sampleRate * 0.006), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i += 1) {
    const factor = i / fade;
    out[i] *= factor;
    out[out.length - 1 - i] *= factor;
  }
  return out;
}

export function float32ToPcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), i * 2);
  }
  return wrapPcm16ToWav(pcm, sampleRate);
}
