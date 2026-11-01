/**
 * Audio encoding shared by the recorder and the settings test.
 *
 * Every vendor accepts the same 16 kHz mono WAV, so the renderer normalizes
 * once instead of shipping whatever container MediaRecorder happened to pick
 * (Chromium gives webm/opus; Safari gives mp4/aac). Pure and dependency-free
 * so it can be unit-tested under node.
 */

export const VOICE_SAMPLE_RATE = 16_000;

/**
 * Downsample by averaging each output window (box filter), then quantize to
 * signed 16-bit little-endian PCM inside a 44-byte RIFF/WAVE header.
 */
export function floatTo16BitPcmWav16k(
  channel: Float32Array,
  inputRate: number,
): Uint8Array {
  const outRate = VOICE_SAMPLE_RATE;
  const ratio = inputRate > 0 ? inputRate / outRate : 1;
  const outLength = Math.max(1, Math.round(channel.length / ratio));
  const pcm = new Int16Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(channel.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += channel[j];
    const sample = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
