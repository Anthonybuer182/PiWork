/**
 * ElevenLabs: Scribe for transcription, the text-to-speech endpoint for
 * playback. Voice ids are opaque strings, so the settings field is free text
 * and the vendor's default is used when empty.
 */

import { audioBlob, joinUrl, readBinary, readJson, requireHttpUrl, send, sttTimeout, ttsTimeout } from '../http.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

const DEFAULT_BASE = 'https://api.elevenlabs.io';

function baseUrl(provider: ResolvedVoiceProvider): string {
  return requireHttpUrl(provider.entry.baseUrl ?? '', DEFAULT_BASE, 'Base URL ');
}

function headers(provider: ResolvedVoiceProvider): Record<string, string> {
  return provider.entry.apiKey ? { 'xi-api-key': provider.entry.apiKey } : {};
}

export function elevenLabsTranscribeRequest(
  provider: ResolvedVoiceProvider,
  audio: Buffer,
): { url: string; init: RequestInit } {
  const form = new FormData();
  form.append('file', audioBlob(audio), 'audio.wav');
  form.append('model_id', provider.model || 'scribe_v1');
  if (provider.language) form.append('language_code', provider.language);

  return {
    url: joinUrl(baseUrl(provider), '/v1/speech-to-text'),
    init: { method: 'POST', headers: headers(provider), body: form },
  };
}

export function elevenLabsSpeechRequest(
  provider: ResolvedVoiceProvider,
  text: string,
): { url: string; init: RequestInit } {
  const voice = (provider.voice || '').trim();
  if (!voice) throw new Error('请填写 ElevenLabs 的 Voice ID');
  const format = provider.entry.options?.outputFormat || 'mp3_44100_128';
  return {
    url: joinUrl(baseUrl(provider), `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(format)}`),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        ...headers(provider),
      },
      body: JSON.stringify({ text, model_id: provider.model || 'eleven_multilingual_v2' }),
    },
  };
}

export const elevenLabsAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const response = await send(elevenLabsTranscribeRequest(provider, audio), '语音识别', sttTimeout());
    const data = (await readJson(response, '语音识别')) as { text?: unknown };
    if (typeof data.text !== 'string') throw new Error('语音识别返回格式不正确（缺少 text）');
    return data.text;
  },
  async synthesize(provider, text) {
    const response = await send(elevenLabsSpeechRequest(provider, text), '语音合成', ttsTimeout());
    return readBinary(response, 'audio/mpeg');
  },
};
