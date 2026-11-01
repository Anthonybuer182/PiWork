/**
 * Messages between the main process and the voice inference utility process.
 *
 * Inference lives in its own process so a native crash cannot take the app
 * down and model loading never blocks the main thread. Payloads are plain
 * structured-cloneable values (Float32Array survives the hop).
 */

import type { BuiltinModelId } from '@pi/types';

export interface RecognizeRequest {
  type: 'recognize';
  id: number;
  modelId: BuiltinModelId;
  modelRoot: string;
  language: string;
  samples: Float32Array;
}

export interface SynthesizeRequest {
  type: 'synthesize';
  id: number;
  modelId: BuiltinModelId;
  modelRoot: string;
  text: string;
  sid: number;
  /** Playback generation this chunk belongs to. */
  generation?: number;
}

export interface WarmupRequest {
  type: 'warmup';
  id: number;
  modelId: BuiltinModelId;
  modelRoot: string;
}

export interface CancelSynthesisRequest {
  type: 'cancel-synthesis';
  /** Everything with this generation or older is no longer wanted. */
  generation: number;
}

export interface EvictRequest {
  type: 'evict';
  /** Present when the caller waits for the cache to be dropped. */
  id?: number;
  modelId: BuiltinModelId;
}

export type WorkerRequest =
  | RecognizeRequest
  | SynthesizeRequest
  | WarmupRequest
  | CancelSynthesisRequest
  | EvictRequest;

export interface RecognizedReply {
  type: 'recognized';
  id: number;
  text: string;
}

export interface SynthesizedReply {
  type: 'synthesized';
  id: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface WarmedReply {
  type: 'warmed';
  id: number;
}

export interface EvictedReply {
  type: 'evicted';
  id: number;
}

export interface ErrorReply {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerReply =
  | RecognizedReply
  | SynthesizedReply
  | EvictedReply
  | WarmedReply
  | ErrorReply;
