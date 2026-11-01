/**
 * Built-in local neural speech (sherpa-onnx + MeloTTS).
 *
 * Returns WAV bytes for the renderer's player, which already expects WAV from
 * the system-voice adapter. Synthesis happens per sentence, so latency stays
 * low even on CPU.
 */

import type { BuiltinModelId } from '@pi/types';
import { BUILTIN_MODELS, isBuiltinModelId } from '../builtin/models.js';
import { float32ToPcm16Wav, normalizeAndFade } from '../builtin/pcm.js';
import { voiceInference } from '../builtin/inference-client.js';
import type { VoiceAdapter } from '../types.js';

export const sherpaTtsAdapter: VoiceAdapter = {
  async synthesize(provider, text) {
    const modelId = (provider.entry.options?.modelId ?? 'melo-int8') as BuiltinModelId;
    if (!isBuiltinModelId(modelId) || BUILTIN_MODELS[modelId].kind !== 'tts') {
      throw new Error('内置语音合成模型无效');
    }
    const modelRoot = provider.entry.options?.modelRoot;
    if (!modelRoot) throw new Error('内置语音合成模型路径无效，请在设置 → 语音中重新下载');

    const sid = Number.parseInt(provider.voice, 10);
    const audio = await voiceInference.synthesize({
      modelId,
      modelRoot,
      text,
      // Kokoro exposes many voices; 50 is a Chinese voice in the v1.1 bundle.
      sid: Number.isFinite(sid) && sid >= 0 ? sid : modelId === 'kokoro' ? 50 : 0,
      generation: provider.generation,
    });
    if (!audio?.samples?.length || !audio.sampleRate) {
      throw new Error('语音合成没有返回音频');
    }
    return {
      bytes: float32ToPcm16Wav(
        normalizeAndFade(audio.samples, audio.sampleRate),
        audio.sampleRate,
      ),
      mimeType: 'audio/wav',
    };
  },
};
