/**
 * Download lifecycle for the built-in voice models.
 *
 * One download per model at a time. Every window that asks for the same model
 * joins the existing download (progress is broadcast to all of them), and the
 * download is aborted only when the last interested window closes. Delete and
 * start are serialized per model so a delete can never race a fresh download.
 */

import { mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type {
  BuiltinModelId,
  VoiceBuiltinModel,
  VoiceModelProgress,
} from '@pi/types';
import {
  BUILTIN_MODELS,
  isBuiltinModelId,
  isInstalledAt,
  modelDir,
  modelTotalBytes,
  modelUrls,
} from './models.js';
import { downloadToFile } from './downloader.js';

interface InflightDownload {
  controller: AbortController;
  promise: Promise<void>;
  received: number;
  /** Windows waiting for this model, with their `destroyed` listeners. */
  waiters: Map<WebContents, () => void>;
}

const PROGRESS_THROTTLE_MS = 150;

export class VoiceModelManager {
  private inflight = new Map<BuiltinModelId, InflightDownload>();
  /** Serializes start/delete transitions per model. */
  private locks = new Map<BuiltinModelId, Promise<unknown>>();
  private readonly onDeleted: (id: BuiltinModelId) => Promise<void> | void;

  constructor(
    readonly root: string,
    options: { onDeleted?: (id: BuiltinModelId) => Promise<void> | void } = {},
  ) {
    this.onDeleted = options.onDeleted ?? (() => undefined);
  }

  list(): VoiceBuiltinModel[] {
    return (Object.keys(BUILTIN_MODELS) as BuiltinModelId[]).map((id) => {
      const spec = BUILTIN_MODELS[id];
      return {
        id,
        kind: spec.kind,
        sizeBytes: modelTotalBytes(spec),
        installed: this.isInstalled(id),
        downloading: this.inflight.has(id),
      };
    });
  }

  isInstalled(id: BuiltinModelId): boolean {
    return isInstalledAt(modelDir(this.root, id), BUILTIN_MODELS[id]);
  }

  pathFor(id: BuiltinModelId): string {
    return modelDir(this.root, id);
  }

  ensure(id: BuiltinModelId, sender: WebContents): Promise<void> {
    if (!isBuiltinModelId(id)) throw new Error('未知的内置语音模型');

    // Fast path: join an existing download (no lock needed — the entry is
    // installed synchronously when the download starts).
    const running = this.inflight.get(id);
    if (running) {
      this.addWaiter(id, running, sender);
      return running.promise;
    }
    let result: Promise<void> | null = null;
    return this.runExclusive(id, async () => {
      const concurrent = this.inflight.get(id);
      if (concurrent) {
        this.addWaiter(id, concurrent, sender);
        result = concurrent.promise;
        return;
      }
      if (this.isInstalled(id)) {
        result = Promise.resolve();
        return;
      }
      // Start synchronously (the inflight entry is registered before this
      // returns), then release the lock so a second window joins the download
      // instead of queueing behind the whole file transfer.
      result = this.startDownload(id, sender);
    }).then(() => result ?? Promise.resolve());
  }

  cancel(id: BuiltinModelId): void {
    this.inflight.get(id)?.controller.abort();
  }

  async delete(id: BuiltinModelId): Promise<VoiceBuiltinModel[]> {
    if (!isBuiltinModelId(id)) throw new Error('未知的内置语音模型');
    return this.runExclusive(id, async () => {
      const running = this.inflight.get(id);
      if (running) {
        running.controller.abort();
        await running.promise.catch(() => undefined);
      }
      if (this.inflight.has(id)) throw new Error('模型正在下载，请先取消');

      // Drop the worker's loaded session first: Windows keeps model files
      // mapped, so deleting before eviction fails with EBUSY.
      try {
        await this.onDeleted(id);
      } catch {
        /* worker unavailable: no loaded session can be holding the files */
      }
      await rm(modelDir(this.root, id), { recursive: true, force: true });
      return this.list();
    });
  }

  /** Remove leftover `.part` files from interrupted earlier runs. */
  async cleanupParts(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const dir = join(this.root, entry);
        try {
          const files = await readdir(dir, { recursive: true });
          await Promise.all(
            files
              .filter((file) => String(file).endsWith('.part'))
              .map((file) => rm(join(dir, String(file)), { force: true })),
          );
        } catch {
          /* not a directory or raced with delete */
        }
      }),
    );
  }

  // ── internals ───────────────────────────────────────────────────

  private startDownload(id: BuiltinModelId, sender: WebContents): Promise<void> {
    const spec = BUILTIN_MODELS[id];
    const totalBytes = modelTotalBytes(spec);
    const controller = new AbortController();
    const record: InflightDownload = {
      controller,
      received: 0,
      promise: Promise.resolve(),
      waiters: new Map(),
    };

    const emit = (progress: VoiceModelProgress) => {
      for (const waiter of record.waiters.keys()) {
        if (!waiter.isDestroyed()) waiter.send('pi:voice:model-progress', progress);
      }
    };

    const run = async () => {
      await this.assertDiskSpace(totalBytes);
      await mkdir(modelDir(this.root, id), { recursive: true });
      // Nested directories must exist before the first write.
      for (const file of spec.files) {
        const slash = file.name.lastIndexOf('/');
        if (slash > 0) {
          await mkdir(join(modelDir(this.root, id), file.name.slice(0, slash)), {
            recursive: true,
          });
        }
      }

      let completedBytes = 0;
      let lastEmit = 0;
      for (const file of spec.files) {
        const receivedBefore = completedBytes;
        try {
          await downloadToFile({
            urls: modelUrls(spec, file),
            destPath: join(modelDir(this.root, id), file.name),
            expectedBytes: file.size,
            expectedSha256: file.sha256,
            signal: controller.signal,
            onProgress: (received) => {
              record.received = receivedBefore + received;
              const now = Date.now();
              if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
              lastEmit = now;
              emit({
                modelId: id,
                phase: 'downloading',
                file: file.name,
                receivedBytes: record.received,
                totalBytes,
              });
            },
          });
        } catch (err) {
          if (controller.signal.aborted) {
            emit({
              modelId: id,
              phase: 'cancelled',
              receivedBytes: record.received,
              totalBytes,
            });
            throw new Error('下载已取消');
          }
          const message = err instanceof Error ? err.message : String(err);
          emit({
            modelId: id,
            phase: 'error',
            file: file.name,
            receivedBytes: record.received,
            totalBytes,
            message,
          });
          throw new Error(`模型下载失败：${message}`);
        }
        completedBytes += file.size;
        record.received = completedBytes;
      }

      if (!this.isInstalled(id)) throw new Error('模型下载不完整，请重试');
      emit({ modelId: id, phase: 'done', receivedBytes: totalBytes, totalBytes });
    };

    const promise = run()
      .catch((err) => {
        throw err;
      })
      .finally(() => {
        for (const [waiter, listener] of record.waiters) {
          if (!waiter.isDestroyed()) waiter.removeListener('destroyed', listener);
        }
        record.waiters.clear();
        this.inflight.delete(id);
      });

    record.promise = promise;
    this.inflight.set(id, record);
    this.addWaiter(id, record, sender);
    return promise;
  }

  /** Add a window as a listener; the download aborts when the last one goes. */
  private addWaiter(id: BuiltinModelId, record: InflightDownload, sender: WebContents): void {
    if (record.waiters.has(sender)) return;
    const onClose = () => {
      record.waiters.delete(sender);
      if (record.waiters.size === 0 && this.inflight.get(id) === record) {
        record.controller.abort();
      }
    };
    record.waiters.set(sender, onClose);
    sender.once('destroyed', onClose);
  }

  private runExclusive<T>(id: BuiltinModelId, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    // Keep the chain alive even when this operation rejects.
    this.locks.set(id, next.catch(() => undefined));
    return next;
  }

  private async assertDiskSpace(neededBytes: number): Promise<void> {
    try {
      const stat = await statfs(this.root);
      const available = stat.bavail * stat.bsize;
      if (available < neededBytes * 1.05) {
        throw new Error(
          `磁盘空间不足，需要约 ${Math.ceil((neededBytes * 1.05) / 1024 / 1024)} MB`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('磁盘空间不足')) throw err;
      // statfs is best-effort; the write itself will report a real failure.
    }
  }
}
