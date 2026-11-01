/**
 * The universal path: OpenAI's audio endpoints.
 *
 * OpenAI, Groq, SiliconFlow, DashScope's compatible mode, Together, Fireworks,
 * self-hosted gateways and local servers all expose these two routes. The
 * common drift is the base path, so `options.sttPath` / `options.ttsPath`
 * override it without needing a new adapter.
 */

import {
  audioBlob,
  authHeader,
  joinUrl,
  readBinary,
  readJson,
  requireHttpUrl,
  send,
  sttTimeout,
  ttsTimeout,
} from '../http.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

export function openAiTranscribeRequest(
  provider: ResolvedVoiceProvider,
  audio: Buffer,
): { url: string; init: RequestInit } {
  const base = requireHttpUrl(provider.entry.baseUrl ?? '', DEFAULT_BASE, 'Base URL ');
  const path = provider.entry.options?.sttPath || '/audio/transcriptions';
  const model = provider.model || 'whisper-1';

  const form = new FormData();
  form.append('file', audioBlob(audio), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  if (provider.language) form.append('language', provider.language);

  return {
    url: joinUrl(base, path),
    init: { method: 'POST', headers: { ...authHeader(provider.entry.apiKey) }, body: form },
  };
}

export function openAiSpeechRequest(
  provider: ResolvedVoiceProvider,
  text: string,
): { url: string; init: RequestInit } {
  const base = requireHttpUrl(provider.entry.baseUrl ?? '', DEFAULT_BASE, 'Base URL ');
  const path = provider.entry.options?.ttsPath || '/audio/speech';
  const model = provider.model || 'tts-1';
  return {
    url: joinUrl(base, path),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(provider.entry.apiKey),
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: provider.voice || 'alloy',
        response_format: provider.entry.options?.responseFormat || 'mp3',
      }),
    },
  };
}

export const openAiAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const response = await send(openAiTranscribeRequest(provider, audio), '语音识别', sttTimeout());
    const data = (await readJson(response, '语音识别')) as { text?: unknown };
    if (typeof data.text !== 'string') throw new Error('语音识别返回格式不正确（缺少 text）');
    return data.text;
  },
  async synthesize(provider, text) {
    const response = await send(openAiSpeechRequest(provider, text), '语音合成', ttsTimeout());
    return readBinary(response, 'audio/mpeg');
  },
};
