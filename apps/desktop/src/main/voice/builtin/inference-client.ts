/**
 * Main-process client for the voice inference utility process.
 *
 * Spawned lazily on the first request and respawned after a crash. Every call
 * has a timeout; if the worker dies, all in-flight requests reject instead of
 * hanging a mic click or a read-aloud forever.
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import type { BuiltinModelId } from '@pi/types';
import type {
  WorkerReply,
  WorkerRequest,
} from './worker-protocol.js';

const REQUEST_TIMEOUT_MS = 180_000;

interface PendingRequest {
  resolve: (reply: WorkerReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function workerScriptPath(): string {
  const url = new URL('./voice-worker.mjs', import.meta.url);
  let path = fileURLToPath(url);
  // Packaged: `.node`/worker files are unpacked next to the asar.
  if (path.includes(`${sep}app.asar${sep}`)) {
    path = path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  }
  return path;
}

class VoiceInferenceClient {
  private child: UtilityProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  /** Synthesis requests whose results can still be discarded. */
  private synthGenerations = new Map<number, number>();
  private nextId = 1;

  async recognize(request: {
    modelId: BuiltinModelId;
    modelRoot: string;
    language: string;
    samples: Float32Array;
  }): Promise<string> {
    const reply = await this.send({ type: 'recognize', id: 0, ...request });
    if (reply.type !== 'recognized') throw new Error('本地语音识别返回了意外的结果');
    return reply.text;
  }

  async synthesize(request: {
    modelId: BuiltinModelId;
    modelRoot: string;
    text: string;
    sid: number;
    generation?: number;
  }): Promise<{ samples: Float32Array; sampleRate: number }> {
    const reply = await this.send({ type: 'synthesize', id: 0, ...request });
    if (reply.type !== 'synthesized') throw new Error('本地语音合成返回了意外的结果');
    return { samples: reply.samples, sampleRate: reply.sampleRate };
  }

  /**
   * Drop every queued/running synthesis request.
   *
   * A native synthesis cannot be interrupted, but queued ones can be skipped
   * in the worker; without this a stopped read-aloud leaves a backlog that
   * makes the next click wait tens of seconds.
   */
  cancelPendingSynthesis(generation = Number.MAX_SAFE_INTEGER): void {
    const hadSynth = this.synthGenerations.size > 0;
    this.child?.postMessage({ type: 'cancel-synthesis', generation } as WorkerRequest);
    for (const [id, requestGeneration] of this.synthGenerations) {
      if (requestGeneration > generation) continue;
      const entry = this.pending.get(id);
      this.synthGenerations.delete(id);
      if (!entry) continue;
      this.pending.delete(id);
      entry.reject(new Error('cancelled'));
    }
    // Native synthesis cannot be interrupted. A queued prefetch of a long
    // chunk can hold the worker for tens of seconds, making the next
    // read-aloud look dead; replacing the process is the cheapest way to
    // guarantee a clean slate (the model reloads in ~1 s).
    if (hadSynth && this.child) {
      this.restart(new Error('本地语音引擎已重置'));
    }
  }

  /** Load a TTS model ahead of use (best-effort; errors are swallowed). */
  async warmTts(modelId: BuiltinModelId, modelRoot: string): Promise<void> {
    await this.send({ type: 'warmup', id: 0, modelId, modelRoot });
  }

  /**
   * Free a model's recognizer/TTS instance in the worker. Waits for the ack
   * so the caller can then delete the files — on Windows an ONNX session keeps
   * the .onnx file open, and removing it first fails with EBUSY.
   */
  async evict(modelId: BuiltinModelId): Promise<void> {
    if (!this.child) return;
    await this.send({ type: 'evict', id: 0, modelId });
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    this.rejectAll(new Error('本地语音引擎已关闭'));
  }

  private send(message: WorkerRequest): Promise<WorkerReply> {
    const id = this.nextId++;
    const child = this.ensureChild();
    return new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本地语音推理超时，请重试'));
        // A stuck native call cannot be cancelled; replace the process so the
        // next request starts from a clean state.
        this.restart(new Error('本地语音引擎无响应，已重启'));
      }, REQUEST_TIMEOUT_MS);
      if (message.type === 'synthesize') {
        this.synthGenerations.set(id, message.generation ?? 0);
      }
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          this.synthGenerations.delete(id);
          if (reply.type === 'error') reject(new Error(reply.message));
          else resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.synthGenerations.delete(id);
          reject(error);
        },
        timer,
      });
      child.postMessage({ ...message, id } as WorkerRequest);
    });
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child;

    const child = utilityProcess.fork(workerScriptPath(), [], {
      serviceName: 'pi-voice-inference',
      stdio: 'pipe',
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      console.log('[voice-worker]', String(chunk).trim());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      console.warn('[voice-worker]', String(chunk).trim());
    });
    child.on('message', (message: WorkerReply) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      entry.resolve(message);
    });
    child.on('exit', (code: number) => {
      // A replaced process exits after `restart()`/`dispose()` already rejected
      // its requests. Rejecting again would fail requests queued for the new
      // worker, so only the current child owns the pending map.
      if (this.child !== child) return;
      this.child = null;
      this.rejectAll(
        new Error(`本地语音引擎已退出（code ${code}），请重试`),
      );
    });
    this.child = child;
    return child;
  }

  private restart(reason: Error): void {
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    this.rejectAll(reason);
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}

export const voiceInference = new VoiceInferenceClient();
