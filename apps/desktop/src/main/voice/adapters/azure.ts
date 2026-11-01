/**
 * Azure OpenAI audio. Same payloads as OpenAI, different addressing:
 * the model is a deployment name in the path and auth is `api-key`.
 */

import { audioBlob, joinUrl, readBinary, readJson, requireHttpUrl, send, sttTimeout, ttsTimeout } from '../http.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

/**
 * Accept a full resource endpoint, or an endpoint that already includes the
 * deployment (`…/openai/deployments/foo`). A missing deployment is an error —
 * guessing would silently hit the wrong model.
 */
export function azureDeploymentUrl(
  provider: ResolvedVoiceProvider,
  route: 'transcriptions' | 'speech',
): string {
  if (!(provider.entry.baseUrl ?? '').trim()) throw new Error('请填写 Azure 资源地址');
  const base = requireHttpUrl(provider.entry.baseUrl!, '', 'Azure 资源地址');
  const version = provider.entry.options?.apiVersion || '2024-06-01';

  let prefix = base;
  if (!/\/openai\/deployments\/[^/]+$/i.test(prefix)) {
    const deployment = (provider.model || '').trim();
    if (!deployment) throw new Error('请填写 Azure 部署名（Deployment）');
    prefix = joinUrl(prefix, `openai/deployments/${encodeURIComponent(deployment)}`);
  }
  return `${prefix}/audio/${route}?api-version=${encodeURIComponent(version)}`;
}

function azureHeaders(provider: ResolvedVoiceProvider): Record<string, string> {
  return provider.entry.apiKey ? { 'api-key': provider.entry.apiKey } : {};
}

export const azureAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const form = new FormData();
    form.append('file', audioBlob(audio), 'audio.wav');
    form.append('response_format', 'json');
    if (provider.language) form.append('language', provider.language);

    const response = await send(
      {
        url: azureDeploymentUrl(provider, 'transcriptions'),
        init: { method: 'POST', headers: azureHeaders(provider), body: form },
      },
      '语音识别',
      sttTimeout(),
    );
    const data = (await readJson(response, '语音识别')) as { text?: unknown };
    if (typeof data.text !== 'string') throw new Error('语音识别返回格式不正确（缺少 text）');
    return data.text;
  },
  async synthesize(provider, text) {
    const response = await send(
      {
        url: azureDeploymentUrl(provider, 'speech'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...azureHeaders(provider) },
          body: JSON.stringify({
            input: text,
            voice: provider.voice || 'zh-CN-XiaoxiaoNeural',
            response_format: 'mp3',
          }),
        },
      },
      '语音合成',
      ttsTimeout(),
    );
    return readBinary(response, 'audio/mpeg');
  },
};
