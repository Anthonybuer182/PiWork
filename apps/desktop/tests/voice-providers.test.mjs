/**
 * Provider protocol shapes. These assert the wire format without calling any
 * vendor: request builders are pure and `fetch` is mocked for the two paths
 * that need a response parsed (errors and Gemini's PCM wrapping).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  openAiSpeechRequest,
  openAiTranscribeRequest,
} from '../src/main/voice/adapters/openai.ts';
import { azureDeploymentUrl } from '../src/main/voice/adapters/azure.ts';
import {
  elevenLabsSpeechRequest,
  elevenLabsTranscribeRequest,
} from '../src/main/voice/adapters/elevenlabs.ts';
import {
  deepgramTranscript,
  deepgramListenUrl,
  deepgramSpeakRequest,
} from '../src/main/voice/adapters/deepgram.ts';
import {
  geminiAudio,
  geminiSpeechRequest,
  geminiTranscribeRequest,
} from '../src/main/voice/adapters/gemini.ts';
import {
  customSpeechRequest,
  customTranscribeRequest,
  jsonEscape,
  parseHeaders,
  renderTemplate,
} from '../src/main/voice/adapters/custom-http.ts';
import { deepgramAdapter } from '../src/main/voice/adapters/deepgram.ts';
import { customHttpAdapter } from '../src/main/voice/adapters/custom-http.ts';
import { buildSayArgs, buildPowerShellCommand, buildPowerShellScript, psQuote } from '../src/main/voice/adapters/system-tts.ts';
import { buildWhisperArgs } from '../src/main/voice/adapters/local-whisper.ts';
import { readPath } from '../src/main/voice/http.ts';
import { isRawPcmMime, sampleRateFromMime, wrapPcm16ToWav } from '../src/main/voice/wav.ts';

function provider(entry, overrides = {}) {
  return {
    name: 'test',
    entry,
    model: entry.model ?? '',
    voice: entry.voice ?? '',
    language: entry.language ?? '',
    ...overrides,
  };
}

const audio = Buffer.from([1, 2, 3, 4]);

test('openai-compatible requests use the standard audio routes', () => {
  const p = provider({ type: 'openai-audio', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_1', model: 'whisper-large-v3' });
  const stt = openAiTranscribeRequest(p, audio);
  assert.equal(stt.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(stt.init.method, 'POST');
  assert.equal(stt.init.headers.Authorization, 'Bearer gsk_1');
  const form = stt.init.body;
  assert.equal(form.get('model'), 'whisper-large-v3');
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.get('file').name, 'audio.wav');
  assert.equal(form.get('file').size, 4);

  const tts = openAiSpeechRequest(p, '你好');
  assert.equal(tts.url, 'https://api.groq.com/openai/v1/audio/speech');
  assert.deepEqual(JSON.parse(tts.init.body), {
    model: 'whisper-large-v3',
    input: '你好',
    voice: 'alloy',
    response_format: 'mp3',
  });
});

test('openai-compatible paths can be overridden for gateways', () => {
  const p = provider({
    type: 'openai-audio',
    baseUrl: 'https://gateway.local/v1/',
    options: { sttPath: '/custom/asr', ttsPath: '/custom/tts' },
  });
  assert.equal(openAiTranscribeRequest(p, audio).url, 'https://gateway.local/v1/custom/asr');
  assert.equal(openAiSpeechRequest(p, 'x').url, 'https://gateway.local/v1/custom/tts');
});

test('azure addresses deployments and authenticates with api-key', () => {
  const p = provider({ type: 'azure-openai-audio', baseUrl: 'https://res.openai.azure.com', apiKey: 'k', model: 'whisper' });
  assert.equal(
    azureDeploymentUrl(p, 'transcriptions'),
    'https://res.openai.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01',
  );
  const withVersion = provider({
    type: 'azure-openai-audio',
    baseUrl: 'https://res.openai.azure.com',
    model: 'whisper',
    options: { apiVersion: '2024-10-21' },
  });
  assert.match(azureDeploymentUrl(withVersion, 'speech'), /api-version=2024-10-21$/);
});

test('elevenlabs uses XI auth and needs a voice id for speech', () => {
  const p = provider({ type: 'elevenlabs', apiKey: 'xi', model: 'scribe_v1', voice: '21m00Tcm4TlvDq8ikWAM' });
  const stt = elevenLabsTranscribeRequest(p, audio);
  assert.equal(stt.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(stt.init.headers['xi-api-key'], 'xi');
  assert.equal(stt.init.body.get('model_id'), 'scribe_v1');

  const speakProvider = provider({
    type: 'elevenlabs',
    apiKey: 'xi',
    voice: '21m00Tcm4TlvDq8ikWAM',
    model: 'eleven_multilingual_v2',
  });
  const tts = elevenLabsSpeechRequest(speakProvider, 'hi');
  assert.equal(tts.url, 'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128');
  assert.deepEqual(JSON.parse(tts.init.body), { text: 'hi', model_id: 'eleven_multilingual_v2' });

  assert.throws(() => elevenLabsSpeechRequest(provider({ type: 'elevenlabs' }), 'hi'), /Voice ID/);
});

test('deepgram builds listen/speak URLs and reads the transcript path', () => {
  const p = provider({ type: 'deepgram', apiKey: 'dg', model: 'nova-3', language: 'zh-CN' });
  const listen = deepgramListenUrl(p);
  assert.match(listen, /^https:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(listen, /model=nova-3/);
  assert.match(listen, /smart_format=true/);
  assert.match(listen, /language=zh-CN/);

  const speak = deepgramSpeakRequest(p, '你好');
  assert.equal(speak.url, 'https://api.deepgram.com/v1/speak?model=nova-3');
  assert.equal(speak.init.headers.Authorization, 'Token dg');

  assert.equal(
    deepgramTranscript({ results: { channels: [{ alternatives: [{ transcript: '测试' }] }] } }),
    '测试',
  );
  assert.equal(deepgramTranscript({}), undefined);
});

test('gemini sends inline audio for STT and AUDIO modalities for TTS', () => {
  const stt = geminiTranscribeRequest(provider({ type: 'gemini', apiKey: 'g' }), audio);
  assert.equal(stt.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(stt.init.headers['x-goog-api-key'], 'g');
  const body = JSON.parse(stt.init.body);
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(body.contents[0].parts[0].inlineData.data, audio.toString('base64'));

  const tts = geminiSpeechRequest(provider({ type: 'gemini', voice: 'Puck' }), '你好');
  const ttsBody = JSON.parse(tts.init.body);
  assert.deepEqual(ttsBody.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(ttsBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
});

test('gemini PCM is wrapped into a playable WAV', () => {
  const pcm = Buffer.alloc(8); // 4 samples
  const wrapped = geminiAudio({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm.toString('base64') } }] } }],
  });
  assert.equal(wrapped.mimeType, 'audio/wav');
  assert.equal(wrapped.bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wrapped.bytes.readUInt32LE(24), 24000);
  assert.equal(wrapped.bytes.length, 44 + 8);
  assert.ok(isRawPcmMime('audio/L16;rate=24000'));
  assert.equal(sampleRateFromMime('audio/L16;rate=16000'), 16000);
  assert.equal(sampleRateFromMime('audio/L16'), 24000);

  const header = wrapPcm16ToWav(Buffer.alloc(2), 16000);
  assert.equal(header.readUInt16LE(20), 1); // PCM
  assert.equal(header.readUInt16LE(22), 1); // mono
  assert.equal(header.readUInt16LE(34), 16); // bits
});

test('custom HTTP substitutes JSON-escaped values and reads dot paths', () => {
  assert.equal(jsonEscape('a"b\n'), 'a\\"b\\n');
  assert.equal(
    renderTemplate('{"text":"{{text}}"}', { text: 'say "hi"' }),
    '{"text":"say \\"hi\\""}',
  );
  assert.deepEqual(parseHeaders('{"X-Test":"1"}'), { 'X-Test': '1' });
  assert.deepEqual(parseHeaders(''), {});
  assert.throws(() => parseHeaders('{oops'), /JSON/);

  const p = provider({
    type: 'custom-http',
    baseUrl: 'https://vendor.example/asr',
    apiKey: 'k',
    options: { bodyTemplate: '{"audio":"{{audio_base64}}","lang":"{{language}}"}' },
  });
  const req = customTranscribeRequest(p, audio);
  assert.equal(req.url, 'https://vendor.example/asr');
  assert.equal(req.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(req.init.body), { audio: audio.toString('base64'), lang: '' });

  const speak = customSpeechRequest(provider({ type: 'custom-http', baseUrl: 'https://vendor.example/tts' }), '你好');
  assert.deepEqual(JSON.parse(speak.init.body), { text: '你好', voice: '', model: '', language: '' });

  assert.equal(readPath({ data: { items: [{ text: 'x' }] } }, 'data.items.0.text'), 'x');
  assert.equal(readPath({ a: 1 }, 'a.b'), undefined);
});

test('explicit custom headers override the generated auth header', () => {
  const p = provider({
    type: 'custom-http',
    baseUrl: 'https://vendor.example/asr',
    apiKey: 'k',
    options: { headers: '{"Authorization":"Token custom","X-Tenant":"t1"}' },
  });
  const headers = customTranscribeRequest(p, audio).init.headers;
  assert.equal(headers.Authorization, 'Token custom');
  assert.equal(headers['X-Tenant'], 't1');
});

test('custom HTTP can read base64 audio from JSON and binary audio', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { audio: Buffer.from('mp3-bytes').toString('base64') } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const p = provider({
      type: 'custom-http',
      baseUrl: 'https://vendor.example/tts',
      options: { responseType: 'json-base64', responsePath: 'data.audio', mimeType: 'audio/mpeg' },
    });
    const result = await customHttpAdapter.synthesize(p, 'hi');
    assert.equal(result.bytes.toString(), 'mp3-bytes');
    assert.equal(result.mimeType, 'audio/mpeg');

    globalThis.fetch = async () =>
      new Response(Buffer.from('raw-mp3'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    const binary = await customHttpAdapter.synthesize(
      provider({ type: 'custom-http', baseUrl: 'https://vendor.example/tts' }),
      'hi',
    );
    assert.equal(binary.bytes.toString(), 'raw-mp3');

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: { audio: Buffer.from('hex-mp3').toString('hex') } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const hex = await customHttpAdapter.synthesize(
      provider({
        type: 'custom-http',
        baseUrl: 'https://vendor.example/tts',
        options: { responseType: 'json-hex', responsePath: 'data.audio' },
      }),
      'hi',
    );
    assert.equal(hex.bytes.toString(), 'hex-mp3');
  } finally {
    globalThis.fetch = original;
  }
});

test('non-2xx responses become truncated, readable errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('x'.repeat(800), { status: 401, statusText: 'Unauthorized' });
  try {
    await assert.rejects(
      deepgramAdapter.transcribe(provider({ type: 'deepgram', apiKey: 'bad' }), audio),
      (err) => {
        assert.match(err.message, /语音识别 401/);
        assert.ok(err.message.length < 600);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('local adapters build argv without shell quoting', () => {
  assert.deepEqual(
    buildSayArgs({ textPath: '/tmp/t.txt', outPath: '/tmp/o.wav', voice: 'Tingting' }),
    ['-f', '/tmp/t.txt', '-o', '/tmp/o.wav', '--file-format=WAVE', '--data-format=LEI16@22050', '-v', 'Tingting'],
  );
  assert.equal(psQuote("it's"), "'it''s'");

  const script = buildPowerShellScript({ textPath: 'C:\\t.txt', outPath: 'C:\\o.wav', voice: 'Microsoft Huihui' });
  assert.match(script, /SelectVoice\('Microsoft Huihui'\)/);
  const encoded = buildPowerShellCommand(script);
  assert.equal(encoded[0], '-NoProfile');
  assert.equal(Buffer.from(encoded[3], 'base64').toString('utf16le'), script);

  assert.deepEqual(
    buildWhisperArgs({ modelPath: '/m.bin', audioPath: '/a.wav', outBase: '/r', language: 'zh' }),
    ['-m', '/m.bin', '-f', '/a.wav', '-oj', '-of', '/r', '-l', 'zh'],
  );
});
