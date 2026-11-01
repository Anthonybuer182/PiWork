/**
 * The local models the app can download for its built-in voice engines.
 *
 * Nothing here is bundled with the installer: STT alone is ~229 MB and TTS
 * ~73 MB, so they are fetched on first use into `userData/voice-models` after
 * the user consents in Settings → 语音. Sizes are the upstream Content-Length
 * values and double as the integrity check after download.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { BuiltinModelId, BuiltinModelKind } from '@pi/types';

export interface BuiltinModelFile {
  /** Path relative to the model directory (may contain subdirectories). */
  name: string;
  size: number;
  /** SHA-256 of the upstream file; verified after every download. */
  sha256: string;
}

export interface BuiltinModelSpec {
  id: BuiltinModelId;
  kind: BuiltinModelKind;
  repo: string;
  files: BuiltinModelFile[];
}

const MIRROR = 'https://hf-mirror.com';
const UPSTREAM = 'https://huggingface.co';

export const BUILTIN_MODELS: Record<BuiltinModelId, BuiltinModelSpec> = {
  sensevoice: {
    id: 'sensevoice',
    kind: 'asr',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: [
      { name: 'model.int8.onnx', size: 239_233_841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
      { name: 'tokens.txt', size: 315_894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
    ],
  },
  'whisper-base': {
    id: 'whisper-base',
    kind: 'asr',
    repo: 'csukuangfj/sherpa-onnx-whisper-base',
    files: [
      { name: 'base-encoder.int8.onnx', size: 29_120_534, sha256: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11' },
      { name: 'base-decoder.int8.onnx', size: 130_672_026, sha256: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d' },
      { name: 'base-tokens.txt', size: 816_730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  'whisper-small': {
    id: 'whisper-small',
    kind: 'asr',
    repo: 'csukuangfj/sherpa-onnx-whisper-small',
    files: [
      { name: 'small-encoder.int8.onnx', size: 112_442_483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
      { name: 'small-decoder.int8.onnx', size: 262_226_114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
      { name: 'small-tokens.txt', size: 816_730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  kokoro: {
    id: 'kokoro',
    kind: 'tts',
    repo: 'csukuangfj/kokoro-multi-lang-v1_1',
    files: [
      { name: 'model.onnx', size: 325_561_476, sha256: '99db0bc8fd0c5033d249fe922db16768b71b4a6b26cfd93d206fbf66c76efb5f' },
      { name: 'voices.bin', size: 53_790_720, sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c' },
      { name: 'tokens.txt', size: 1_111, sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14' },
      { name: 'lexicon-us-en.txt', size: 5_956_885, sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
      { name: 'lexicon-zh.txt', size: 2_120_131, sha256: 'fea060803db3e59193987f1a3436f56917bda09f3b3595b6588e46ae60cebf93' },
      { name: 'date-zh.fst', size: 59_154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
      { name: 'number-zh.fst', size: 64_482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
      { name: 'phone-zh.fst', size: 88_630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
      { name: 'dict/jieba.dict.utf8', size: 5_071_204, sha256: '3043b77068e09c9904f27cad82f12b6ebe9dbdb5aeff3b25e45ab7f9c1122b55' },
      { name: 'dict/hmm_model.utf8', size: 519_739, sha256: 'f17790586ac86dd048c8adffed052c4bd2b28ed0682972c1275e59040c0589a7' },
      { name: 'dict/idf.utf8', size: 5_998_717, sha256: 'dbd1e03d72b2263cc8d84a4304ed77677eed9e7deaf43a1a5133bbba9733b535' },
      { name: 'dict/stop_words.utf8', size: 8_974, sha256: 'b788b8a939d2e2fe079abd579ea98f12f9fb84370bfd0dddd81bb9381f7ab42c' },
      { name: 'dict/user.dict.utf8', size: 829_194, sha256: '5faabcd0c52adf512de77fd7eee3d556da8c98b50f493b47c66a981b3a24959c' },
    ],
  },
  'melo-int8': {
    id: 'melo-int8',
    kind: 'tts',
    repo: 'csukuangfj/vits-melo-tts-zh_en',
    files: [
      { name: 'model.int8.onnx', size: 53_517_430, sha256: 'f085f5079e05f039b800aeb542f5253c26a303211b0c6465d0d9387977855a63' },
      { name: 'lexicon.txt', size: 6_837_671, sha256: '7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528' },
      { name: 'tokens.txt', size: 655, sha256: 'd18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d' },
      { name: 'date.fst', size: 59_154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
      { name: 'number.fst', size: 64_482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
      { name: 'phone.fst', size: 88_630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
      { name: 'new_heteronym.fst', size: 21_974, sha256: 'ca14b2127e27baa571664e4bb791e143e7425f56a6bc29db08d74f97e6aa4e29' },
      { name: 'dict/jieba.dict.utf8', size: 5_071_204, sha256: '3043b77068e09c9904f27cad82f12b6ebe9dbdb5aeff3b25e45ab7f9c1122b55' },
      { name: 'dict/hmm_model.utf8', size: 519_739, sha256: 'f17790586ac86dd048c8adffed052c4bd2b28ed0682972c1275e59040c0589a7' },
      { name: 'dict/idf.utf8', size: 5_998_717, sha256: 'dbd1e03d72b2263cc8d84a4304ed77677eed9e7deaf43a1a5133bbba9733b535' },
      { name: 'dict/stop_words.utf8', size: 8_974, sha256: 'b788b8a939d2e2fe079abd579ea98f12f9fb84370bfd0dddd81bb9381f7ab42c' },
      { name: 'dict/user.dict.utf8', size: 49, sha256: '495bbf49270408a1234690e1e6a97328f30a482a7a72aa769e8a12e8714b0c62' },
    ],
  },
};

export function isBuiltinModelId(value: unknown): value is BuiltinModelId {
  return typeof value === 'string' && Object.hasOwn(BUILTIN_MODELS, value);
}

export function modelTotalBytes(spec: BuiltinModelSpec): number {
  return spec.files.reduce((total, file) => total + file.size, 0);
}

export function modelDir(root: string, id: BuiltinModelId): string {
  return join(root, id);
}

/** Mirror first (reachable from mainland China), upstream as a fallback. */
export function modelUrls(spec: BuiltinModelSpec, file: BuiltinModelFile): string[] {
  const path = `${spec.repo}/resolve/main/${file.name}?download=true`;
  return [`${MIRROR}/${path}`, `${UPSTREAM}/${path}`];
}

/** Exact-size check: a truncated download must never count as installed. */
export function isInstalledAt(
  dir: string,
  spec: BuiltinModelSpec,
  stat: (path: string) => { size: number } = statSync,
): boolean {
  return spec.files.every((file) => {
    try {
      return stat(join(dir, file.name)).size === file.size;
    } catch {
      return false;
    }
  });
}

export function formatMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
