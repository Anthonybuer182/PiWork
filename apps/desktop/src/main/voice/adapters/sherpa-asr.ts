/**
 * Built-in local speech recognition (sherpa-onnx + SenseVoice/Whisper).
 *
 * The provider entry is synthesized by the resolver — it never comes from the
 * user's provider list — so `options.modelId` / `options.modelRoot` are the
 * only knobs. Audio never leaves the machine.
 */

import type { BuiltinModelId } from '@pi/types';
import { BUILTIN_MODELS, isBuiltinModelId } from '../builtin/models.js';
import { wav16kToFloat32 } from '../builtin/pcm.js';
import { voiceInference } from '../builtin/inference-client.js';
import type { VoiceAdapter } from '../types.js';

export const sherpaAsrAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const modelId = (provider.entry.options?.modelId ?? 'sensevoice') as BuiltinModelId;
    if (!isBuiltinModelId(modelId) || BUILTIN_MODELS[modelId].kind !== 'asr') {
      throw new Error('内置语音识别模型无效');
    }
    const modelRoot = provider.entry.options?.modelRoot;
    if (!modelRoot) throw new Error('内置语音识别模型路径无效，请在设置 → 语音中重新下载');

    const samples = wav16kToFloat32(audio);
    return voiceInference.recognize({
      modelId,
      modelRoot,
      language: provider.language,
      samples,
    });
  },
};
