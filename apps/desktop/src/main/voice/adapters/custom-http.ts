/**
 * The escape hatch: any vendor that does not match a bundled protocol.
 *
 * The user supplies method, headers and a body template; placeholders are
 * substituted as JSON-escaped strings (never evaluated), and the response is
 * read from a dot path or returned as binary. This is how 火山引擎, 讯飞 and
 * other proprietary protocols connect without shipping a new adapter.
 */

import {
  authHeader,
  readBinary,
  readJson,
  readPath,
  requireHttpUrl,
  send,
  sttTimeout,
  ttsTimeout,
} from '../http.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

const DEFAULT_STT_BODY =
  '{"audio":"{{audio_base64}}","mimeType":"{{mime}}","language":"{{language}}","model":"{{model}}"}';
const DEFAULT_TTS_BODY =
  '{"text":"{{text}}","voice":"{{voice}}","model":"{{model}}","language":"{{language}}"}';

/** Escape a value so it is safe inside a JSON string literal. */
export function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    jsonEscape(values[key] ?? ''),
  );
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') headers[key] = value;
    }
    return headers;
  } catch {
    throw new Error('请求头不是有效的 JSON');
  }
}

function requestFor(
  provider: ResolvedVoiceProvider,
  values: Record<string, string>,
  body: string,
  fallbackPath?: string,
): { url: string; init: RequestInit } {
  if (!(provider.entry.baseUrl ?? '').trim()) throw new Error('请填写请求 URL');
  const url = requireHttpUrl(provider.entry.baseUrl!, fallbackPath ?? '', '请求');
  const headers: Record<string, string> = {
    'Content-Type': provider.entry.options?.contentType || 'application/json',
    ...authHeader(provider.entry.apiKey),
    // Explicit headers win: some vendors use `Token x` / `X-Api-Key` instead
    // of Bearer, and the escape hatch must be able to say so.
    ...parseHeaders(provider.entry.options?.headers),
  };
  return {
    url,
    init: {
      method: (provider.entry.options?.method || 'POST').toUpperCase(),
      headers,
      body: renderTemplate(body, values),
    },
  };
}

export function customTranscribeRequest(
  provider: ResolvedVoiceProvider,
  audio: Buffer,
): { url: string; init: RequestInit } {
  return requestFor(
    provider,
    {
      audio_base64: audio.toString('base64'),
      mime: 'audio/wav',
      language: provider.language,
      model: provider.model,
    },
    provider.entry.options?.bodyTemplate || DEFAULT_STT_BODY,
  );
}

export function customSpeechRequest(
  provider: ResolvedVoiceProvider,
  text: string,
): { url: string; init: RequestInit } {
  return requestFor(
    provider,
    {
      text,
      voice: provider.voice,
      model: provider.model,
      language: provider.language,
    },
    provider.entry.options?.bodyTemplate || DEFAULT_TTS_BODY,
  );
}

export const customHttpAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const response = await send(customTranscribeRequest(provider, audio), '语音识别', sttTimeout());
    const data = await readJson(response, '语音识别');
    const text = readPath(data, provider.entry.options?.responsePath || 'text');
    if (typeof text !== 'string') {
      throw new Error('语音识别返回中没有找到文本字段，请检查「响应字段路径」');
    }
    return text;
  },
  async synthesize(provider, text) {
    const response = await send(customSpeechRequest(provider, text), '语音合成', ttsTimeout());
    const responseType = provider.entry.options?.responseType || 'binary';
    if (responseType === 'json-base64' || responseType === 'json-hex') {
      const data = await readJson(response, '语音合成');
      const encoded = readPath(data, provider.entry.options?.responsePath || 'audio');
      const label = responseType === 'json-hex' ? 'hex' : 'base64';
      if (typeof encoded !== 'string') {
        throw new Error(
          `语音合成返回中没有找到 ${label} 音频字段，请检查「响应字段路径」`,
        );
      }
      return {
        bytes: Buffer.from(encoded, responseType === 'json-hex' ? 'hex' : 'base64'),
        mimeType: provider.entry.options?.mimeType || 'audio/mpeg',
      };
    }
    return readBinary(response, provider.entry.options?.mimeType || 'audio/mpeg');
  },
};
