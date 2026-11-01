/**
 * Deepgram: `/v1/listen` takes the raw audio body, `/v1/speak` returns the
 * audio body. Auth is `Token`, not `Bearer`.
 *
 * Aura (TTS) voices are mostly English; the settings page hints that Chinese
 * output needs a model that supports it or another provider.
 */

import { joinUrl, toBytes, readBinary, readJson, requireHttpUrl, send, sttTimeout, ttsTimeout } from '../http.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

const DEFAULT_BASE = 'https://api.deepgram.com';

function baseUrl(provider: ResolvedVoiceProvider): string {
  return requireHttpUrl(provider.entry.baseUrl ?? '', DEFAULT_BASE, 'Base URL ');
}

function headers(provider: ResolvedVoiceProvider): Record<string, string> {
  return provider.entry.apiKey ? { Authorization: `Token ${provider.entry.apiKey}` } : {};
}

export function deepgramListenUrl(provider: ResolvedVoiceProvider): string {
  const params = new URLSearchParams({
    model: provider.model || 'nova-3',
    smart_format: 'true',
  });
  if (provider.language) params.set('language', provider.language);
  return `${joinUrl(baseUrl(provider), '/v1/listen')}?${params.toString()}`;
}

export function deepgramSpeakRequest(
  provider: ResolvedVoiceProvider,
  text: string,
): { url: string; init: RequestInit } {
  const model = provider.model || 'aura-asteria-en';
  return {
    url: `${joinUrl(baseUrl(provider), '/v1/speak')}?model=${encodeURIComponent(model)}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(provider) },
      body: JSON.stringify({ text }),
    },
  };
}

export function deepgramTranscript(data: unknown): string | undefined {
  const transcript = (data as any)?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof transcript === 'string' ? transcript : undefined;
}

export const deepgramAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const response = await send(
      {
        url: deepgramListenUrl(provider),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav', ...headers(provider) },
          body: toBytes(audio),
        },
      },
      '语音识别',
      sttTimeout(),
    );
    const transcript = deepgramTranscript(await readJson(response, '语音识别'));
    if (transcript === undefined) throw new Error('语音识别返回格式不正确（缺少 transcript）');
    return transcript;
  },
  async synthesize(provider, text) {
    const response = await send(deepgramSpeakRequest(provider, text), '语音合成', ttsTimeout());
    return readBinary(response, 'audio/mpeg');
  },
};
