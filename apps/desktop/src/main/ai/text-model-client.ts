/**
 * Text model client — one-shot completions outside the agent session.
 *
 * The browser plugin's whole-page translation needs many small, independent
 * model calls (one per batch of paragraphs). Routing those through the agent
 * would cost a chat turn each and wait on the tool-permission gate, so plugins
 * get a narrow capability instead: `ai.complete`, permission `ai`.
 *
 * Model selection follows the user's chat default (`SettingsManager#getDefaultModel`)
 * and falls back to the first model with configured auth — the same resolution
 * the VLM analyzer uses, minus the vision filter. Provider request shapes are
 * the three the app already speaks: anthropic, openai-compatible, google.
 */

import type { ModelRegistry, SettingsManager } from '@earendil-works/pi-coding-agent';

export interface AiCompleteInput {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AiCompleteOutput {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  model: string;
}

interface ResolvedModel {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  api: string;
}

/** Hard ceilings so a plugin cannot turn one call into an unbounded request. */
const MAX_PROMPT_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_OUTPUT_TOKENS = 2_048;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;

export class TextModelClient {
  private cached: ResolvedModel | null = null;
  private cachedAt = 0;
  private readonly CACHE_TTL = 60_000;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly settings?: SettingsManager,
  ) {}

  /** Drop the cached model (e.g. after the user switches models). */
  invalidateCache(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  async complete(input: AiCompleteInput): Promise<AiCompleteOutput> {
    const prompt = String(input.prompt ?? '');
    if (!prompt.trim()) throw new Error('ai.complete: prompt 不能为空');
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`ai.complete: prompt 超过 ${MAX_PROMPT_CHARS} 字符上限`);
    }

    const model = await this.resolveModel();
    const maxTokens = Math.min(
      MAX_OUTPUT_TOKENS,
      Math.max(64, Math.floor(input.maxTokens ?? DEFAULT_OUTPUT_TOKENS)),
    );
    const temperature = clampTemperature(input.temperature);
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const out = await this.call(model, {
        prompt,
        system: input.system,
        maxTokens,
        temperature,
        signal: controller.signal,
      });
      return { ...out, model: model.modelId };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`ai.complete: 请求超时（${Math.round(timeoutMs / 1000)}s）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── model resolution ────────────────────────────────────────────────────

  private async resolveModel(): Promise<ResolvedModel> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.CACHE_TTL) return this.cached;

    const all = this.registry.getAll();
    if (all.length === 0) throw new Error('ai.complete: 没有已配置的模型');

    let preferredId = '';
    try {
      preferredId = String(this.settings?.getDefaultModel?.() ?? '');
    } catch {
      // Settings are optional; fall through to the auth-ordered pool.
    }

    const preferred = preferredId
      ? all.find((m) => m.id === preferredId && this.registry.hasConfiguredAuth(m))
      : undefined;
    const fallback = all.find((m) => this.registry.hasConfiguredAuth(m));
    const chosen = preferred ?? fallback;
    if (!chosen) throw new Error('ai.complete: 没有带鉴权信息的模型，请先在设置里配置模型');

    const apiKey = await this.registry.getApiKeyForProvider(chosen.provider);
    if (!apiKey) throw new Error(`ai.complete: 模型 ${chosen.id} 没有可用的 API Key`);

    this.cached = {
      provider: chosen.provider,
      modelId: chosen.id,
      baseUrl: chosen.baseUrl || defaultBaseUrl(chosen.provider),
      apiKey,
      api: String(chosen.api ?? ''),
    };
    this.cachedAt = now;
    return this.cached;
  }

  private async call(
    model: ResolvedModel,
    req: { prompt: string; system?: string; maxTokens: number; temperature: number; signal: AbortSignal },
  ): Promise<Omit<AiCompleteOutput, 'model'>> {
    if (model.provider === 'anthropic' || model.api.includes('anthropic')) {
      return this.callAnthropic(model, req);
    }
    if (model.provider === 'google' || model.api.includes('google')) {
      return this.callGoogle(model, req);
    }
    return this.callOpenAI(model, req);
  }

  private async callAnthropic(
    model: ResolvedModel,
    req: { prompt: string; system?: string; maxTokens: number; temperature: number; signal: AbortSignal },
  ): Promise<Omit<AiCompleteOutput, 'model'>> {
    const response = await fetch(`${model.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      throw new Error(`ai.complete: Anthropic API ${response.status} ${await errorText(response)}`);
    }
    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: data?.content?.[0]?.text ?? '',
      usage: data?.usage
        ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
        : null,
    };
  }

  private async callOpenAI(
    model: ResolvedModel,
    req: { prompt: string; system?: string; maxTokens: number; temperature: number; signal: AbortSignal },
  ): Promise<Omit<AiCompleteOutput, 'model'>> {
    const base = model.baseUrl || 'https://api.openai.com/v1';
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        messages,
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      throw new Error(`ai.complete: OpenAI API ${response.status} ${await errorText(response)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data?.choices?.[0]?.message?.content ?? '',
      usage: data?.usage
        ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
        : null,
    };
  }

  private async callGoogle(
    model: ResolvedModel,
    req: { prompt: string; system?: string; maxTokens: number; temperature: number; signal: AbortSignal },
  ): Promise<Omit<AiCompleteOutput, 'model'>> {
    const url = `${model.baseUrl}/models/${model.modelId}:generateContent?key=${encodeURIComponent(model.apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      throw new Error(`ai.complete: Google API ${response.status} ${await errorText(response)}`);
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      usage: data?.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          }
        : null,
    };
  }
}

function clampTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.2;
  return Math.min(2, Math.max(0, value));
}

function defaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com/v1';
    case 'google': return 'https://generativelanguage.googleapis.com/v1beta';
    case 'openai': return 'https://api.openai.com/v1';
    default: return '';
  }
}

/** First line of an error body, so a 400 explains itself in the plugin log. */
async function errorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}
