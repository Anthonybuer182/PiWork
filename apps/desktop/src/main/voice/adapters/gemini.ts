/**
 * Google Gemini. One endpoint serves both directions through
 * `generateContent`: audio as inline data for transcription, AUDIO response
 * modalities for speech.
 *
 * TTS comes back as raw PCM (`audio/L16;rate=24000`), which Chromium will not
 * play — it is wrapped into a WAV container here.
 */

import { readJson, requireHttpUrl, send, sttTimeout, ttsTimeout } from '../http.js';
import { isRawPcmMime, sampleRateFromMime, wrapPcm16ToWav } from '../wav.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function endpoint(provider: ResolvedVoiceProvider, model: string): string {
  const base = requireHttpUrl(provider.entry.baseUrl ?? '', DEFAULT_BASE, 'Base URL ');
  const versioned = /\/v\d+(?:beta)?$/i.test(base) ? base : `${base}/v1beta`;
  return `${versioned}/models/${encodeURIComponent(model)}:generateContent`;
}

function headers(provider: ResolvedVoiceProvider): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(provider.entry.apiKey ? { 'x-goog-api-key': provider.entry.apiKey } : {}),
  };
}

export function geminiTranscribeRequest(
  provider: ResolvedVoiceProvider,
  audio: Buffer,
): { url: string; init: RequestInit } {
  const model = provider.model || 'gemini-2.5-flash';
  const instruction = provider.language
    ? `请把这段音频逐字转录成文字（语言提示：${provider.language}），只输出转录结果。`
    : '请把这段音频逐字转录成文字，只输出转录结果。';
  return {
    url: endpoint(provider, model),
    init: {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
              { text: instruction },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    },
  };
}

export function geminiSpeechRequest(
  provider: ResolvedVoiceProvider,
  text: string,
): { url: string; init: RequestInit } {
  const model = provider.model || 'gemini-2.5-flash-preview-tts';
  return {
    url: endpoint(provider, model),
    init: {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: provider.voice || 'Kore' },
            },
          },
        },
      }),
    },
  };
}

export function geminiText(data: unknown): string | undefined {
  const parts = (data as any)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  return text || undefined;
}

export function geminiAudio(data: unknown): { bytes: Buffer; mimeType: string } | undefined {
  const inline = (data as any)?.candidates?.[0]?.content?.parts?.find(
    (part: { inlineData?: { data?: unknown } }) => typeof part?.inlineData?.data === 'string',
  )?.inlineData as { data: string; mimeType?: string } | undefined;
  if (!inline) return undefined;
  const bytes = Buffer.from(inline.data, 'base64');
  const mimeType = inline.mimeType || 'audio/L16;rate=24000';
  if (isRawPcmMime(mimeType)) {
    return { bytes: wrapPcm16ToWav(bytes, sampleRateFromMime(mimeType)), mimeType: 'audio/wav' };
  }
  return { bytes, mimeType };
}

export const geminiAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const response = await send(geminiTranscribeRequest(provider, audio), '语音识别', sttTimeout());
    const text = geminiText(await readJson(response, '语音识别'));
    if (!text) throw new Error('语音识别没有返回文字');
    return text;
  },
  async synthesize(provider, text) {
    const response = await send(geminiSpeechRequest(provider, text), '语音合成', ttsTimeout());
    const audio = geminiAudio(await readJson(response, '语音合成'));
    if (!audio) throw new Error('语音合成没有返回音频');
    return audio;
  },
};
