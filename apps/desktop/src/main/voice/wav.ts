/**
 * Wrap raw 16-bit little-endian PCM in a RIFF/WAVE container.
 *
 * Gemini's TTS returns bare PCM (`audio/L16;rate=24000`); every other adapter
 * returns a container already. Keeping this in one place also lets the tests
 * assert header bytes without spawning anything.
 */

export function wrapPcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Pull the sample rate out of `audio/L16;rate=24000` (default 24 kHz). */
export function sampleRateFromMime(mimeType: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mimeType ?? '');
  const rate = match ? Number(match[1]) : 0;
  return Number.isFinite(rate) && rate >= 8000 ? rate : 24000;
}

export function isRawPcmMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return /^audio\/(l16|pcm)/i.test(mimeType);
}
