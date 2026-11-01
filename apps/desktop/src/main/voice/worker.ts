/**
 * Voice inference utility process.
 *
 * Runs sherpa-onnx off the main thread: model loading (~0.5 s) and synthesis
 * (seconds on CPU) must never stall IPC or the UI, and a native crash here is
 * recoverable — the main process respawns this worker on the next request.
 *
 * Requests are handled strictly one at a time; the recognizer/TTS instances
 * are cached inside sherpa.ts.
 */

import type { BuiltinModelId } from '@pi/types';
import { modelDir } from './builtin/models.js';
import {
  evictBuiltinModel,
  getRecognizer,
  getTts,
  synthesizeWithSherpa,
} from './builtin/sherpa.js';
import type {
  WorkerReply,
  WorkerRequest,
} from './builtin/worker-protocol.js';

const port = process.parentPort;

function reply(message: WorkerReply): void {
  port?.postMessage(message);
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === 'warmup') {
    // Load the TTS model ahead of the first click; synthesis then starts
    // immediately instead of waiting for a 300 MB ONNX session.
    await getTts(message.modelId as BuiltinModelId, modelDir(message.modelRoot, message.modelId as BuiltinModelId));
    reply({ type: 'warmed', id: message.id });
    return;
  }

  if (message.type === 'cancel-synthesis') return;

  if (message.type === 'evict') {
    evictBuiltinModel(message.modelId);
    if (typeof message.id === 'number') {
      reply({ type: 'evicted', id: message.id });
    }
    return;
  }

  try {
    if (message.type === 'recognize') {
      const modelId = message.modelId as BuiltinModelId;
      const recognizer = await getRecognizer(
        modelId,
        modelDir(message.modelRoot, modelId),
        message.language,
      );
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: message.samples, sampleRate: 16_000 });
      const result =
        typeof recognizer.decodeAsync === 'function'
          ? await recognizer.decodeAsync(stream)
          : (recognizer.decode?.(stream), recognizer.getResult?.(stream));
      reply({ type: 'recognized', id: message.id, text: String(result?.text ?? '').trim() });
      return;
    }

    const modelId = message.modelId as BuiltinModelId;
    const tts = await getTts(modelId, modelDir(message.modelRoot, modelId));
    const audio = await synthesizeWithSherpa(tts, {
      text: message.text,
      sid: message.sid,
      speed: 1,
    });
    reply({
      type: 'synthesized',
      id: message.id,
      samples: audio.samples,
      sampleRate: audio.sampleRate,
    });
  } catch (err) {
    reply({
      type: 'error',
      id: message.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

if (!port) {
  console.error('[voice-worker] must run as an Electron utility process');
} else {
  // Serialize native calls: one recognizer/TTS instance is shared and the
  // addon is not designed for concurrent decode on the same handle.
  let chain: Promise<void> = Promise.resolve();
  let cancelGeneration = -1;

  port.on('message', (event) => {
    const message = event.data as WorkerRequest;
    // Cancellation is handled immediately, not queued: the whole point is to
    // stop the backlog when the user stops speaking. Generation-based so a
    // late cancel cannot drop requests from the *next* read-aloud.
    if (message.type === 'cancel-synthesis') {
      cancelGeneration = Math.max(cancelGeneration, message.generation);
      return;
    }
    chain = chain
      .then(() => {
        if (
          message.type === 'synthesize' &&
          (message.generation ?? 0) <= cancelGeneration
        ) {
          return;
        }
        return handle(message);
      })
      .catch((err) => {
        console.error('[voice-worker] unhandled:', err);
      });
  });
}
