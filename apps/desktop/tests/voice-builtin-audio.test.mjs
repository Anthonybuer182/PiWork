/**
 * PCM/WAV conversion and sherpa config builders. No native module is loaded.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floatTo16BitPcmWav16k } from '../../../packages/ui/src/lib/voice/wav.ts';
import {
  float32ToPcm16Wav,
  normalizeAndFade,
  wav16kToFloat32,
} from '../src/main/voice/builtin/pcm.ts';
import {
  buildRecognizerConfig,
  buildTtsConfig,
} from '../src/main/voice/builtin/sherpa.ts';

test('16k mono PCM WAV becomes float samples', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = Buffer.from(floatTo16BitPcmWav16k(input, 16_000));
  const samples = wav16kToFloat32(wav);
  assert.equal(samples.length, 4);
  assert.ok(Math.abs(samples[0]) < 1e-6);
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-3);
  assert.ok(Math.abs(samples[2] + 0.5) < 1e-3);
  assert.ok(Math.abs(samples[3] - 1) < 1e-3);
});

test('non-16k / stereo / non-PCM input is rejected', () => {
  const rate48k = Buffer.from(floatTo16BitPcmWav16k(new Float32Array(8), 16_000));
  rate48k.writeUInt32LE(48_000, 24);
  assert.throws(() => wav16kToFloat32(rate48k), /16kHz/);

  const stereo = Buffer.from(floatTo16BitPcmWav16k(new Float32Array(8), 16_000));
  stereo.writeUInt16LE(2, 22); // channels
  assert.throws(() => wav16kToFloat32(stereo), /单声道/);

  const float = Buffer.from(floatTo16BitPcmWav16k(new Float32Array(8), 16_000));
  float.writeUInt16LE(3, 20); // IEEE float format
  assert.throws(() => wav16kToFloat32(float), /PCM/);

  assert.throws(() => wav16kToFloat32(Buffer.from('not a wav')), /无效|WAV/);
});

test('float samples are clipped into a 16-bit WAV', () => {
  const wav = float32ToPcm16Wav(new Float32Array([2, -2, 0.25]), 24_000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 24_000);
  assert.equal(view.getInt16(44, true), 0x7fff);
  assert.equal(view.getInt16(46, true), -0x8000);
  assert.equal(view.getInt16(48, true), 8192);
});

test('recognizer config points at the right model files', () => {
  const sv = buildRecognizerConfig('sensevoice', '/models/sensevoice', 'zh');
  assert.equal(sv.modelConfig.senseVoice.model, '/models/sensevoice/model.int8.onnx');
  assert.equal(sv.modelConfig.tokens, '/models/sensevoice/tokens.txt');
  assert.equal(sv.modelConfig.senseVoice.language, 'zh');

  const base = buildRecognizerConfig('whisper-base', '/models/base', '');
  assert.equal(base.modelConfig.whisper.encoder, '/models/base/base-encoder.int8.onnx');
  assert.equal(base.modelConfig.whisper.decoder, '/models/base/base-decoder.int8.onnx');
  assert.equal(base.modelConfig.whisper.language, 'zh');

  const small = buildRecognizerConfig('whisper-small', '/models/small', 'en');
  assert.equal(small.modelConfig.whisper.encoder, '/models/small/small-encoder.int8.onnx');
  assert.equal(small.modelConfig.whisper.language, 'en');
});

test('TTS config wires lexicon, dict and rule FSTs', () => {
  const config = buildTtsConfig('melo-int8', '/models/melo');
  assert.equal(config.model.vits.model, '/models/melo/model.int8.onnx');
  assert.equal(config.model.vits.dictDir, '/models/melo/dict');
  assert.match(config.ruleFsts, /date\.fst,.*number\.fst,.*phone\.fst$/);
});

test('Kokoro config points at voices, lexicons and the zh rule FSTs', () => {
  const config = buildTtsConfig('kokoro', '/models/kokoro');
  assert.equal(config.model.kokoro.model, '/models/kokoro/model.onnx');
  assert.equal(config.model.kokoro.voices, '/models/kokoro/voices.bin');
  assert.match(config.model.kokoro.lexicon, /lexicon-us-en\.txt,.*lexicon-zh\.txt$/);
  assert.equal(config.model.kokoro.dictDir, '/models/kokoro/dict');
  assert.match(config.ruleFsts, /date-zh\.fst,.*phone-zh\.fst$/);
});

test('playback preparation normalizes loudness and fades clip edges', () => {
  const samples = new Float32Array(1000).fill(0.2);
  const prepared = normalizeAndFade(samples, 24_000);
  let peak = 0;
  for (const value of prepared) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak > 0.9 && peak <= 0.96, `peak ${peak}`);
  assert.equal(prepared[0], 0);
  assert.ok(Math.abs(prepared[prepared.length - 1]) < 1e-6);
  // Interior samples stay at the normalized level (no fade in the middle).
  assert.ok(Math.abs(Math.abs(prepared[500]) - 0.95) < 0.01);
});
