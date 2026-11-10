/**
 * VLM Analyzer — independently calls a visual-language model to analyze
 * browser screenshots, then returns a text description.
 *
 * Runs OUTSIDE the agent session so the agent's text-only model never
 * sees base64 image data. Only the text description is returned.
 *
 * Uses the app's shared model registry (a read facade over the pi 1.x
 * ModelRuntime) to find available VLM-capable models and their API keys.
 */

import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

// ── Types ──

export interface VlmAnalyzerConfig {
  /** Timeout for VLM API call (ms). Default: 15000 */
  timeoutMs?: number;
  /** Fallback prompt prefix appended to every analysis request */
  promptPrefix?: string;
}

interface VlmModelConfig {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  /** The API format: anthropic, openai, or google */
  api: string;
}

// ── Default prompt for visual analysis ──

const DEFAULT_PROMPT_PREFIX = `You are analyzing a browser screenshot to help a text-only AI agent understand the current page state.

Describe the page in plain text, focusing on:
1. **Layout**: What kind of page is this? (login, dashboard, shopping, etc.) How is it structured?
2. **Key interactive elements**: What buttons, inputs, links, dropdowns are visible? What are their labels?
3. **Visual state**: Is anything loading? Are there error messages, validation hints, disabled controls?
4. **Obstructions**: Are there popups, cookie banners, modals, or overlays blocking content?
5. **Captchas/Verification**: Is there a CAPTCHA, reCAPTCHA, or any visual verification challenge? If so, describe exactly what the user needs to do.

Be concise. Focus on information that helps the text-only agent decide its next action.

Analyze this screenshot:
`;

// ── VlmAnalyzer ──

/**
 * Known VLM model name patterns for auto-detection.
 * When a model's `input` field does not explicitly include "image",
 * these patterns are used to identify likely vision-capable models.
 */
const VLM_NAME_PATTERNS: RegExp[] = [
  // Explicit VL/vision markers
  /vl/i, /vision/i, /visual/i, /multimodal/i,
  // OpenAI vision models (gpt-4o, gpt-4-turbo, gpt-4-vision)
  /gpt-4o/i, /gpt-4-turbo/i, /gpt-4-v/i,
  // Anthropic Claude 3+ (all support vision)
  /claude-3/i, /claude-4/i, /claude-sonnet/i, /claude-opus/i,
  // Google Gemini (all support vision)
  /gemini/i,
  // Open-source VL models
  /pixtral/i, /llava/i, /cogv/i, /internvl/i, /minicpm-v/i,
  /deepseek-vl/i, /glm-4v/i, /yi-vl/i, /phi-3-v/i,
  /moondream/i, /paligemma/i, /florence/i, /owlv/i,
  // Qwen VL series
  /qwen-vl/i, /qwen2-vl/i, /qwen2.5-vl/i,
  // MiniMax multimodal models (M1, M3 support vision; M2.x does NOT)
  /minimax-m1/i, /minimax-m3/i,
];

/** Stage 1: model explicitly declares image input support. */
function isExplicitVlm(m: { input?: unknown; id?: string; name?: string }): boolean {
  return Array.isArray(m.input) && (m.input as string[]).includes('image');
}

/** Stage 2: model name matches a known VLM pattern but input field does not declare image. */
function isHeuristicVlm(m: { input?: unknown; id?: string; name?: string }): boolean {
  if (isExplicitVlm(m)) return false; // already handled in stage 1
  const candidateName = ((m.id ?? m.name) ?? '').toLowerCase();
  return VLM_NAME_PATTERNS.some((pattern) => pattern.test(candidateName));
}

export class VlmAnalyzer {
  private registry: ModelRegistry;
  private config: VlmAnalyzerConfig;
  private cachedModel: VlmModelConfig | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL = 60_000; // 1 min

  constructor(registry: ModelRegistry, config?: VlmAnalyzerConfig) {
    this.registry = registry;
    this.config = config ?? {};
  }

  /**
   * Analyze a screenshot and return a text description.
   * Returns null if no VLM is available or the call fails.
   */
  async analyze(base64Image: string, context?: string): Promise<string | null> {
    const model = await this.resolveModel();
    if (!model) {
      console.warn('[VlmAnalyzer] No VLM-capable model found. Skipping visual analysis.');
      return null;
    }

    const prompt = (this.config.promptPrefix ?? DEFAULT_PROMPT_PREFIX) +
      (context ? `\nAdditional context: ${context}\n` : '');

    try {
      const result = await this.callProvider(model, prompt, base64Image);
      return result;
    } catch (err) {
      console.warn('[VlmAnalyzer] VLM call failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Invalidate the cached VLM model selection */
  invalidateCache(): void {
    this.cachedModel = null;
    this.cacheTimestamp = 0;
  }

  // ── Private: model resolution ──

  /**
   * Resolve a VLM-capable model with three-stage fallback:
   *   1. Explicit `input: ["text", "image"]` — fastest, always correct
   *   2. Name-based heuristic — catches models like qwen-vl whose config
   *      doesn't declare image support explicitly
   *   3. Any remaining auth-configured model — last-resort fallback
   */
  private async resolveModel(): Promise<VlmModelConfig | null> {
    const now = Date.now();
    if (this.cachedModel && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return this.cachedModel;
    }

    // ── Gather candidates ──
    // Build an ordered pool: explicit VLM first, then name-heuristic, then any auth model.
    const allModels = this.registry.getAll();
    const seen = new Set<string>();
    const candidates: typeof allModels = [];

    // Stage 1: explicit + auth (highest confidence)
    for (const m of allModels) {
      if (seen.has(m.id)) continue;
      if (this.registry.hasConfiguredAuth(m) && isExplicitVlm(m)) {
        seen.add(m.id);
        candidates.push(m);
        console.log('[VlmAnalyzer] Stage 1 (explicit):', m.id, '| provider:', m.provider);
      }
    }
    // Stage 2: name-heuristic + auth
    for (const m of allModels) {
      if (seen.has(m.id)) continue;
      if (this.registry.hasConfiguredAuth(m) && isHeuristicVlm(m)) {
        seen.add(m.id);
        candidates.push(m);
        console.log('[VlmAnalyzer] Stage 2 (heuristic):', m.id, '| provider:', m.provider);
      }
    }
    // Stage 3: any remaining auth model (last-resort)
    for (const m of allModels) {
      if (seen.has(m.id)) continue;
      if (this.registry.hasConfiguredAuth(m)) {
        seen.add(m.id);
        candidates.push(m);
        console.log('[VlmAnalyzer] Stage 3 (fallback):', m.id, '| provider:', m.provider);
      }
    }

    if (candidates.length === 0) {
      console.warn('[VlmAnalyzer] No models with configured auth found.');
      return null;
    }

    console.log('[VlmAnalyzer] Candidates:', candidates.map((c) => `${c.id}(${c.provider})`).join(', '));

    // ── Stage 4: try each candidate, cache the first successful one ──
    for (const vlmModel of candidates) {
      try {
        const apiKey = await this.registry.getApiKeyForProvider(vlmModel.provider);
        if (!apiKey) {
          console.warn('[VlmAnalyzer] No API key for', vlmModel.id, '— skipping');
          continue;
        }

        this.cachedModel = {
          provider: vlmModel.provider,
          modelId: vlmModel.id,
          baseUrl: vlmModel.baseUrl || this.getDefaultBaseUrl(vlmModel.provider),
          apiKey,
          api: String(vlmModel.api || ''),
        };
        this.cacheTimestamp = now;
        console.log('[VlmAnalyzer] Selected:', this.cachedModel.modelId,
          '| api:', this.cachedModel.api,
          '| baseUrl:', this.cachedModel.baseUrl);
        return this.cachedModel;
      } catch (err) {
        console.warn('[VlmAnalyzer] Failed to resolve', vlmModel.id, '—', err);
      }
    }

    console.warn('[VlmAnalyzer] No VLM-capable model could be resolved.');
    return null;
  }

  private getDefaultBaseUrl(provider: string): string {
    switch (provider) {
      case 'anthropic': return 'https://api.anthropic.com/v1';
      case 'openai': return 'https://api.openai.com/v1';
      case 'google': return 'https://generativelanguage.googleapis.com/v1beta';
      default: return '';
    }
  }

  // ── Private: provider API calls ──

  private async callProvider(
    model: VlmModelConfig,
    prompt: string,
    base64Image: string,
  ): Promise<string> {
    const timeoutMs = this.config.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let text: string;

      if (model.provider === 'anthropic' || model.api.includes('anthropic')) {
        text = await this.callAnthropic(model, prompt, base64Image, controller.signal);
      } else if (model.provider === 'google' || model.api.includes('google')) {
        text = await this.callGoogle(model, prompt, base64Image, controller.signal);
      } else {
        // openai and custom providers use OpenAI-compatible API
        text = await this.callOpenAI(model, prompt, base64Image, controller.signal);
      }

      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callAnthropic(
    model: VlmModelConfig,
    prompt: string,
    base64Image: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${model.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    return data?.content?.[0]?.text ?? '';
  }

  private async callOpenAI(
    model: VlmModelConfig,
    prompt: string,
    base64Image: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = model.baseUrl
      ? `${model.baseUrl}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    return data?.choices?.[0]?.message?.content ?? '';
  }

  private async callGoogle(
    model: VlmModelConfig,
    prompt: string,
    base64Image: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = `${model.baseUrl}/models/${model.modelId}:generateContent?key=${encodeURIComponent(model.apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: 'image/png', data: base64Image } },
            { text: prompt },
          ],
        }],
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Google API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
}
