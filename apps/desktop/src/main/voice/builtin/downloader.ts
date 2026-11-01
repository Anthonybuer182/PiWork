/**
 * Streaming file download with size verification and host fallback.
 *
 * Downloads land in `<dest>.part` and only become `<dest>` after the byte
 * count matches the catalog. On failure the part file is removed and the next
 * host is tried from zero — ranged resume is deliberately out of scope.
 */

import { createHash, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadOptions {
  urls: string[];
  destPath: string;
  expectedBytes: number;
  /** SHA-256 from the model catalog; a mismatch throws and tries the next host. */
  expectedSha256: string;
  signal: AbortSignal;
  onProgress?: (received: number) => void;
  fetchImpl?: typeof fetch;
}

export async function downloadToFile(options: DownloadOptions): Promise<number> {
  const partPath = `${options.destPath}.part`;
  let lastError: unknown;

  for (const url of options.urls) {
    const hasher = createHash('sha256');
    try {
      await downloadFromHost(url, partPath, options, hasher);
      const size = (await stat(partPath)).size;
      if (size !== options.expectedBytes) {
        throw new Error(
          `下载文件大小不符（${size} / ${options.expectedBytes} 字节）`,
        );
      }
      const digest = hasher.digest('hex');
      if (digest !== options.expectedSha256) {
        throw new Error('文件校验失败（SHA-256 不匹配）');
      }
      await rename(partPath, options.destPath);
      return size;
    } catch (err) {
      lastError = err;
      await rm(partPath, { force: true }).catch(() => undefined);
      if (options.signal.aborted) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('下载失败');
}

/**
 * Electron's global fetch goes through Chromium's network service, which is
 * not what we want here (it fails in the packaged/main context and ignores
 * Node's TLS settings). Downloads use Node's own http(s) client; tests inject
 * `fetchImpl` instead.
 */
function requestWithRedirects(
  url: string,
  signal: AbortSignal,
  redirects = 5,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('下载地址无效'));
      return;
    }
    const getter = parsed.protocol === 'http:' ? httpGet : httpsGet;
    const request = getter(
      parsed,
      { headers: { 'User-Agent': 'Pi-Desktop-Voice/1.0' } },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (location && [301, 302, 303, 307, 308].includes(status) && redirects > 0) {
          response.resume();
          resolve(
            requestWithRedirects(new URL(location, parsed).toString(), signal, redirects - 1),
          );
          return;
        }
        resolve(response);
      },
    );
    // A mirror that accepts the connection and then stalls must not hang the
    // download forever; socket inactivity for 60 s aborts this host.
    request.setTimeout(60_000, () => request.destroy(new Error('下载超时')));
    const onAbort = () => request.destroy(new Error('下载已取消'));
    if (signal.aborted) {
      request.destroy(new Error('下载已取消'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('error', reject);
    request.on('close', () => signal.removeEventListener('abort', onAbort));
  });
}

async function downloadFromHost(
  url: string,
  partPath: string,
  options: DownloadOptions,
  hasher: Hash,
): Promise<void> {
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      hasher.update(chunk);
      options.onProgress?.(received);
      callback(null, chunk);
    },
  });

  if (options.fetchImpl) {
    const response = await options.fetchImpl(url, {
      signal: options.signal,
      redirect: 'follow',
    });
    if (!response.ok || !response.body) {
      throw new Error(`下载失败（HTTP ${response.status}）`);
    }
    await pipeline(
      response.body as unknown as AsyncIterable<Uint8Array>,
      counter,
      createWriteStream(partPath),
      { signal: options.signal },
    );
    return;
  }

  const response = await requestWithRedirects(url, options.signal);
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    response.resume();
    throw new Error(`下载失败（HTTP ${status}）`);
  }
  await pipeline(
    response,
    counter,
    createWriteStream(partPath),
    { signal: options.signal },
  );
}
