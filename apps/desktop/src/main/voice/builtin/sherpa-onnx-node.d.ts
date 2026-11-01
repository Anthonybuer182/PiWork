/**
 * Minimal surface of `sherpa-onnx-node` used by the built-in adapters. The
 * package ships no type declarations; `sherpa.ts` narrows this further.
 */
declare module 'sherpa-onnx-node' {
  export const version: string;
  export const onnxruntimeVersion: string;
  export class OfflineRecognizer {
    constructor(config: unknown);
    static createAsync?: (config: unknown) => Promise<OfflineRecognizer>;
  }
  export class OfflineTts {
    constructor(config: unknown);
    static createAsync?: (config: unknown) => Promise<OfflineTts>;
  }
  export function readWave(path: string): unknown;
  export function writeWave(path: string, sampleRate: number, samples: Float32Array): void;
}
