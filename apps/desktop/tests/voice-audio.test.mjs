/**
 * Renderer-side audio helpers: markdown stripping, sentence chunking and the
 * WAV encoder. Pure functions, so they run under node with no DOM.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  speechChunks,
  splitIntoSentences,
  stripMarkdownForSpeech,
} from '../../../packages/ui/src/lib/voice/chunker.ts';
import { floatTo16BitPcmWav16k } from '../../../packages/ui/src/lib/voice/wav.ts';

test('markdown noise is removed before speaking', () => {
  const input = [
    '# 标题',
    '',
    '正文里有**加粗**和 `代码`，还有[链接](https://example.com)。',
    '',
    '```js',
    'console.log("不要读这段")',
    '```',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '| a | b |',
  ].join('\n');
  const clean = stripMarkdownForSpeech(input);
  assert.ok(!clean.includes('```'));
  assert.ok(!clean.includes('不要读这段'));
  assert.ok(!clean.includes('https://example.com'));
  assert.ok(!clean.includes('#'));
  assert.ok(!clean.includes('**'));
  assert.ok(clean.includes('加粗'));
  assert.ok(clean.includes('链接'));
  assert.ok(clean.includes('标题'));
});

test('sentences split on Chinese and English terminators', () => {
  const chunks = splitIntoSentences('你好。今天天气不错！Really? Yes.');
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0], '你好。');
  assert.equal(chunks[2], 'Really?');
});

test('decimal points and abbreviations do not split mid-number', () => {
  const chunks = splitIntoSentences('圆周率是3.14159，这个数字很长。', { minLen: 1 });
  assert.equal(chunks.length, 1);
});

test('overlong sentences split at secondary punctuation', () => {
  const long = `${'第一部分内容'.repeat(12)}，${'第二部分内容'.repeat(12)}。`;
  const chunks = splitIntoSentences(long, { maxLen: 60, minLen: 1 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 80, `too long: ${chunk.length}`);
});

test('tiny fragments merge into a neighbour', () => {
  const chunks = splitIntoSentences('好。这是一个完整的句子，内容比较长一些。', { minLen: 6 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes('这是一个完整的句子'));
});

test('speechChunks packs sentences for natural prosody with a short first chunk', () => {
  const text = '第一句话。第二句话。第三句话。第四句话。第五句话。第六句话。';
  const chunks = speechChunks(text);
  assert.ok(chunks.length <= 2, `short text stays 1-2 chunks: ${JSON.stringify(chunks)}`);
  assert.ok(chunks[0].length <= 35, `first chunk stays short: ${chunks[0].length}`);
  const long = '这是一个比较长的句子，用来占据长度。'.repeat(6) + '最后一句。';
  const packed = speechChunks(long);
  assert.ok(packed.length >= 2);
  assert.ok(packed[0].length <= 90, `first chunk ${packed[0].length}`);
  for (const chunk of packed) assert.ok(chunk.length <= 170);
  assert.ok(packed.length >= 2);
});

test('a long first sentence is split at a clause mark for a fast start', () => {
  const text = '这是一个长度明显超过首块预算的句子，用来验证首块会在逗号处切开以尽快出声，后半句继续合成。';
  const chunks = speechChunks(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].length <= 42, `first=${chunks[0].length} ${JSON.stringify(chunks[0])}`);
  assert.ok(chunks[0].endsWith('，') || chunks[0].endsWith(','));
});

test('speechChunks caps the total and drops empty replies', () => {
  assert.deepEqual(speechChunks(''), []);
  assert.deepEqual(speechChunks('```\nonly code\n```'), []);
  const huge = '这是一句测试文本。'.repeat(2000);
  const total = speechChunks(huge).join('').length;
  assert.ok(total <= 8_000);
});

test('WAV encoding writes a 16 kHz mono 16-bit PCM header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 2, -2]);
  const wav = floatTo16BitPcmWav16k(samples, 16_000);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.length, 44 + samples.length * 2);
  const pcm = new Int16Array(wav.buffer, 44);
  assert.equal(pcm[1], 16383); // 0.5 * 0x7fff, truncated by Int16
  assert.equal(pcm[3], 0x7fff); // clipped +2
  assert.equal(pcm[4], -0x8000); // clipped -2
});

test('downsampling preserves duration', () => {
  const input = new Float32Array(48_000); // 1 s at 48 kHz
  const wav = floatTo16BitPcmWav16k(input, 48_000);
  const dataLength = wav.length - 44;
  assert.equal(dataLength, 16_000 * 2);
});
