/**
 * Shared HTTP helpers for the voice adapters.
 *
 * Every request is made from the main process so the renderer never touches an
 * API key and the packaged `connect-src 'self'` policy stays intact. Errors
 * carry the status and a short body excerpt (never headers, never the key).
 */

const STT_TIMEOUT_MS = 90_000;
const TTS_TIMEOUT_MS = 60_000;

export function sttTimeout(): number {
  return STT_TIMEOUT_MS;
}

export function ttsTimeout(): number {
  return TTS_TIMEOUT_MS;
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Hosted providers must get an absolute http(s) URL; local servers stay allowed. */
export function requireHttpUrl(value: string, fallback: string, label: string): string {
  const url = (value || fallback).trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`${label}地址无效，需要以 http:// 或 https:// 开头`);
  }
  return url.replace(/\/+$/, '');
}

export interface VoiceRequest {
  url: string;
  init: RequestInit;
}

/** Execute a request and turn a non-2xx response into a readable Error. */
export async function send(
  request: VoiceRequest,
  label: string,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}请求失败：${reason}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label} ${response.status}：${body.slice(0, 500) || response.statusText}`);
  }
  return response;
}

export async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}返回的不是有效 JSON`);
  }
}

export async function readBinary(
  response: Response,
  fallbackMime: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMime;
  return { bytes, mimeType };
}

export function authHeader(apiKey: string | undefined, scheme = 'Bearer'): Record<string, string> {
  return apiKey ? { Authorization: `${scheme} ${apiKey}` } : {};
}

/**
 * Buffer -> fetch body. Node's `Buffer` is backed by `ArrayBufferLike`, which
 * the DOM typings reject as `BodyInit`/`BlobPart`; copying into a plain
 * Uint8Array widens it back to `ArrayBuffer` without changing the bytes.
 */
export function toBytes(audio: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(audio);
}

export function audioBlob(audio: Buffer, type = 'audio/wav'): Blob {
  return new Blob([toBytes(audio)], { type });
}

/** Dot-path read with numeric segments, e.g. `results.channels.0.transcript`. */
export function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
