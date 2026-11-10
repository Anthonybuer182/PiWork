import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, parse, resolve } from 'path';
import { homedir } from 'os';
import type { ConfigService } from '../services/config.js';
import { SettingsManager, getAgentDir, loadSkills } from '@earendil-works/pi-coding-agent';
import type { ModelRegistry, ModelRuntime, Skill as SdkSkill } from '@earendil-works/pi-coding-agent';
import { createModelRegistry, getSharedModelRuntime } from './model-runtime.js';
import type { Config, ModelCapabilities, ModelInfo, ModelProvider, ModelsConfig, ProviderEntry, ModelEntry, Skill } from '@pi/types';

// ── Multimodal model auto-detection ──

/**
 * Known multimodal model name patterns.
 * When a model's "input" field doesn't explicitly include "image",
 * these patterns are used to auto-detect vision-capable models and
 * automatically set input: ["text", "image"].
 */
const KNOWN_MULTIMODAL_PATTERNS: RegExp[] = [
  // Explicit VL/vision markers
  /vl/i, /vision/i, /visual/i, /multimodal/i,
  // OpenAI vision models
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
  // DeepSeek models (Janus, VL series are vision-capable)
  /janus/i,
  // Step series (step-1v, step-1o-vision)
  /step.*v/i,
  // Doubao vision models
  /doubao.*vision/i, /doubao.*vl/i,
  // Ernie VL models
  /ernie.*vl/i, /ernie-4/i,
  // Hunyuan vision
  /hunyuan.*vision/i, /hunyuan.*vl/i, /hunyuan-turbos/i,
  // Spark / iFlytek VL
  /spark.*vl/i,
];

/** Auto-detect and fix the "input" field for known multimodal models. */
function normalizeModelInput(model: ModelEntry): ModelEntry {
  // If already explicitly set to include image, don't touch it
  if (model.input?.includes('image')) return model;
  // If explicitly set to text-only by user, respect that choice
  if (model.input !== undefined && model.input.length > 0 && !model.input.includes('image')) {
    // Only override text-only if name matches a known multimodal pattern
    const name = ((model.name || model.id) ?? '').toLowerCase();
    if (KNOWN_MULTIMODAL_PATTERNS.some((p) => p.test(name))) {
      // Was text-only but name suggests multimodal — user probably forgot to set it.
      // Override to multimodal so the agent can send images to this model.
      return { ...model, input: ['text', 'image'] };
    }
    // Text-only and no name match — user intended this
    return model;
  }
  // input is undefined — auto-detect from name
  const name = ((model.name || model.id) ?? '').toLowerCase();
  if (KNOWN_MULTIMODAL_PATTERNS.some((p) => p.test(name))) {
    return { ...model, input: ['text', 'image'] };
  }
  return model;
}

/**
 * The active model's input capabilities, or undefined when the model does not
 * declare any.
 *
 * Undefined is deliberately distinct from "text only": a model with an empty
 * or missing `input` list is UNKNOWN, and the host uses the neutral capability
 * prompt for it. Only an explicit list without `image` proves the model cannot
 * see images.
 */
export function modelCapabilitiesOf(
  model: { input?: string[]; contextWindow?: number; maxTokens?: number } | null | undefined,
): ModelCapabilities | undefined {
  const input = model?.input?.filter((value) => typeof value === 'string' && value.trim().length > 0);
  if (!input || input.length === 0) return undefined;
  return {
    input,
    vision: input.includes('image'),
    ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model?.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  };
}

// Map real SDK thinking levels to our Config thinking levels
function toConfigThinkLevel(level?: string): Config['defaultThinkLevel'] {
  switch (level) {
    case 'off': return 'off';
    case 'minimal': return 'low';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'high';
    default: return 'medium';
  }
}

// Map our think levels to real SDK levels
function toRealThinkLevel(level?: string): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (level) {
    case 'off': return 'off';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    default: return undefined;
  }
}

// SDK thinking levels → our ThinkLevel set (deduped)
const VALID_THINK_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high']);

function toThinkLevels(thinkingLevelMap?: Record<string, string | null>): ('off' | 'low' | 'medium' | 'high')[] {
  if (!thinkingLevelMap) return ['off', 'low', 'medium', 'high'];
  const levels = new Set<string>();
  for (const l of Object.keys(thinkingLevelMap)) {
    if (l === 'minimal') levels.add('low');
    else if (l === 'xhigh') levels.add('high');
    else if (VALID_THINK_LEVELS.has(l)) levels.add(l);
  }
  return [...levels] as ('off' | 'low' | 'medium' | 'high')[];
}

// Normalize SDK provider to our ModelProvider type
function toModelProvider(raw: string): ModelProvider {
  if (raw === 'openai' || raw.startsWith('openai')) return 'openai';
  if (raw === 'google' || raw === 'google-vertex') return 'google';
  if (raw === 'anthropic') return 'anthropic';
  return 'custom';
}

// Environment variable names for built-in providers
const BUILT_IN_PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

function getConfiguredModelProviders(): Set<string> {
  const providers = new Set<string>();

  // 1. Providers from models.json
  const modelsJsonPath = join(getAgentDir(), 'models.json');
  try {
    if (existsSync(modelsJsonPath)) {
      const raw = readFileSync(modelsJsonPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config?.providers) {
        for (const name of Object.keys(config.providers)) {
          providers.add(name);
        }
      }
    }
  } catch {
    // models.json unreadable – skip
  }

  // 2. Built-in providers with env var API keys
  for (const [provider, envKey] of Object.entries(BUILT_IN_PROVIDER_ENV_KEYS)) {
    if (process.env[envKey]) {
      providers.add(provider);
    }
  }

  return providers;
}

// models.json helpers

function getModelsJsonModelIds(): Set<string> {
  const config = readModelsConfig();
  const ids = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    for (const model of provider.models) {
      ids.add(model.id);
    }
  }
  return ids;
}

function getModelsJsonPath(): string {
  return join(getAgentDir(), 'models.json');
}

function readModelsConfig(): ModelsConfig {
  const path = getModelsJsonPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      return { providers: parsed?.providers ?? {} };
    }
  } catch {
    // unreadable or malformed
  }
  return { providers: {} };
}

function writeModelsConfig(config: ModelsConfig): void {
  const path = getModelsJsonPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  for (const provider of Object.values(config.providers)) {
    provider.baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
  }
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Normalize a provider baseUrl: the OpenAI-compatible client appends the
 * endpoint path itself, so a user-entered full path like
 * "https://api.example.com/v1/chat/completions" would double up
 * (…/chat/completions/chat/completions → 404). Strip the endpoint suffix.
 */
function normalizeProviderBaseUrl(url: string): string {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
}

/**
 * One-time migration to auto-patch existing models whose names match known
 * multimodal patterns but have input: ["text"]. This ensures models like
 * MiniMax-M3 are recognized as vision-capable even if they were configured
 * before the auto-detection feature was added.
 *
 * Returns the number of models patched, or 0 if no changes were needed.
 */
export function migrateModelsConfig(): number {
  const config = readModelsConfig();
  let patched = 0;

  for (const provider of Object.values(config.providers)) {
    if (!provider.models) continue;
    for (let i = 0; i < provider.models.length; i++) {
      const original = provider.models[i];
      const normalized = normalizeModelInput(original);
      if (normalized !== original) {
        provider.models[i] = normalized;
        patched++;
      }
    }
  }

  if (patched > 0) {
    writeModelsConfig(config);
  }
  return patched;
}

// Re-read configured providers after models.json changes
async function refreshConfiguredProviders(modelRegistry: ModelRegistry): Promise<Set<string>> {
  // Re-create registry to pick up changes
  const providers = getConfiguredModelProviders();
  // Force registry refresh
  try {
    await modelRegistry.refresh();
  } catch {
    // refresh might not be available on in-memory instance
  }
  return providers;
}

export function createRealConfigService(cwd: string, agentDir?: string, modelRuntime?: ModelRuntime, settingsManager?: SettingsManager): ConfigService {
  const settings = settingsManager ?? SettingsManager.create(cwd, agentDir);

  // pi 1.x: the runtime is async, the registry is only a synchronous read facade.
  let runtimePromise: Promise<ModelRuntime> | undefined = modelRuntime
    ? Promise.resolve(modelRuntime)
    : undefined;
  let registry: ModelRegistry | undefined;
  async function getRegistry(): Promise<ModelRegistry> {
    runtimePromise ??= getSharedModelRuntime();
    const runtime = await runtimePromise;
    return (registry ??= createModelRegistry(runtime));
  }
  const resolvedAgentDir = agentDir || getAgentDir();

  // Determine which providers have usable auth (mutable after models.json writes)
  let configuredProviders = getConfiguredModelProviders();

  return {
    async get(): Promise<Config> {
      const globalSettings = settings.getGlobalSettings();
      const projectSettings = settings.getProjectSettings();
      const merged = { ...globalSettings, ...projectSettings };

      let rawDefaultModelId = settings.getDefaultModel() || merged.defaultModel || 'claude-sonnet-4';

      // Validate: only keep the default model if it's in models.json AND has configured auth
      const configuredModelIds = getModelsJsonModelIds();
      const availableModels = (await getRegistry()).getAvailable();
      const validModels = availableModels.filter((m) => configuredModelIds.has(m.id));
      if (rawDefaultModelId && !validModels.some((m) => m.id === rawDefaultModelId)) {
        rawDefaultModelId = validModels[0]?.id ?? '';
      }

      return {
        theme: (merged.theme as Config['theme']) ?? 'system',
        compactMode: false,
        defaultModelId: rawDefaultModelId,
        defaultThinkLevel: toConfigThinkLevel(settings.getDefaultThinkingLevel()),
        autoSave: true,
        fontSize: 14,
        codeFontSize: 13,
        enableStreaming: true,
        compactionEnabled: settings.getCompactionEnabled(),
      };
    },

    async update(data: Partial<Config>): Promise<Config> {
      if (data.defaultModelId) {
        settings.setDefaultModel(data.defaultModelId);
      }
      if (data.defaultThinkLevel) {
        settings.setDefaultThinkingLevel(toRealThinkLevel(data.defaultThinkLevel)!);
      }
      if (data.theme) {
        settings.setTheme(data.theme);
      }
      if (data.compactionEnabled !== undefined) {
        settings.setCompactionEnabled(data.compactionEnabled);
      }
      await settings.flush();
      return this.get();
    },

    async listModels(): Promise<ModelInfo[]> {
      // Auto-migrate existing models (e.g. MiniMax-M3) to include image support.
      // This runs on every models listing so users don't need to restart the app.
      const patched = migrateModelsConfig();
      if (patched > 0) {
        console.log(`[config] Auto-migrated ${patched} model(s) to multimodal (image input).`);
      }
      // Refresh from disk so listModels and getModelsConfig stay in sync
      const registry = await getRegistry();
      configuredProviders = await refreshConfiguredProviders(registry);
      // Only return models that are explicitly configured in models.json
      const configuredModelIds = getModelsJsonModelIds();
      const models = registry.getAll().filter((m) =>
        configuredProviders.has(m.provider) && configuredModelIds.has(m.id),
      );
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: toModelProvider(m.provider),
        supportsThinking: m.reasoning,
        thinkLevels: m.reasoning ? toThinkLevels(m.thinkingLevelMap) : ['off'],
        maxTokens: m.maxTokens,
        isAvailable: true,
      }));
    },

    async listSkills(): Promise<Skill[]> {
      // Build skill path list with correct priority:
      //   1. ~/.agents/skills/       — user-installed via pi CLI (wins on collision)
      //   2. Settings skill paths     — any extra path configured by user
      //   3. ~/.pi/agent/skills/     — bundled skills migrated on first launch (fallback)
      //   4. <cwd>/.pi/skills/       — project-level skills
      //
      // We use includeDefaults: false so we control the scan order.
      const skillPaths: string[] = [];

      // 1. User-installed skills — highest priority
      const agentsSkillsDir = join(homedir(), '.agents', 'skills');
      if (existsSync(agentsSkillsDir)) {
        skillPaths.push(agentsSkillsDir);
      }

      // 2. Settings-configured skill paths
      skillPaths.push(...settings.getSkillPaths());

      // 3. Agent skills (includes bundled skills after first-launch migration)
      const agentSkillsDir = join(resolvedAgentDir, 'skills');
      if (existsSync(agentSkillsDir) && !skillPaths.includes(agentSkillsDir)) {
        skillPaths.push(agentSkillsDir);
      }

      // 4. Project skills
      const projectSkillsDir = join(cwd, '.pi', 'skills');
      if (existsSync(projectSkillsDir) && !skillPaths.includes(projectSkillsDir)) {
        skillPaths.push(projectSkillsDir);
      }

      const result = loadSkills({
        cwd,
        agentDir: resolvedAgentDir,
        skillPaths,
        includeDefaults: false,
      });
      return result.skills.map((s: SdkSkill) => ({
        id: `skill-${s.name}`,
        name: s.name,
        description: s.description,
        category: 'custom' as Skill['category'],
        enabled: true,
      }));
    },

    // models.json CRUD

    async getSkillPaths(): Promise<string[]> {
      // The GLOBAL list, not the merged one: this pair backs an editor that
      // writes with setSkillPaths (global scope), and a project `skills` array
      // replaces the global one wholesale. Reading merged would show entries
      // the editor cannot save, and saving would silently do nothing.
      return [...(settings.getGlobalSettings().skills ?? [])];
    },

    async setSkillPaths(paths: string[]): Promise<void> {
      // Normalise while writing: pickers hand back trailing separators, and a
      // path list is compared verbatim downstream. Roots ("/", "C:\") keep
      // their separator — collapsing them would point at nothing.
      const next: string[] = [];
      for (const raw of paths) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const absolute = resolve(trimmed);
        const p = absolute === parse(absolute).root ? absolute : absolute.replace(/[\\/]+$/, '');
        if (!next.includes(p)) next.push(p);
      }
      settings.setSkillPaths(next);
      await settings.flush();
    },

    async getModelsConfig(): Promise<ModelsConfig> {
      // Auto-migrate existing models in case they were configured before this feature
      migrateModelsConfig();
      return readModelsConfig();
    },

    async saveModelsConfig(config: ModelsConfig): Promise<void> {
      // Normalize model inputs for known multimodal models
      for (const provider of Object.values(config.providers)) {
        if (provider.models) {
          provider.models = provider.models.map(normalizeModelInput);
        }
      }
      writeModelsConfig(config);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());
    },

    async upsertProvider(name: string, provider: ProviderEntry): Promise<void> {
      const current = readModelsConfig();
      // Normalize model inputs for known multimodal models
      if (provider.models) {
        provider.models = provider.models.map(normalizeModelInput);
      }
      current.providers[name] = provider;
      writeModelsConfig(current);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());
    },

    async listRemoteModels(input: { baseUrl: string; api: string; apiKey: string }) {
      // Loaded lazily: node-based tests import this adapter straight from src
      // for the migration helpers, and they have no bundler to resolve the
      // `.js → .ts` specifier. Production bundles resolve it normally.
      const { fetchRemoteModels } = await import('../utils/remote-models.js');
      return fetchRemoteModels(input);
    },

    async saveProvider(
      originalName: string | null,
      name: string,
      provider: ProviderEntry,
    ): Promise<void> {
      const current = readModelsConfig();
      const nextName = name.trim();
      if (!nextName) throw new Error('Provider name cannot be empty');
      if (provider.models) {
        provider.models = provider.models.map(normalizeModelInput);
      }

      if (originalName && originalName !== nextName) {
        if (!current.providers[originalName]) {
          throw new Error(`Provider "${originalName}" does not exist`);
        }
        if (current.providers[nextName]) {
          throw new Error(`Provider "${nextName}" already exists`);
        }
        // Rebuild in place so the provider keeps its position in the list.
        const providers: ModelsConfig['providers'] = {};
        for (const [key, value] of Object.entries(current.providers)) {
          providers[key === originalName ? nextName : key] =
            key === originalName ? provider : value;
        }
        current.providers = providers;
      } else {
        current.providers[nextName] = provider;
      }

      writeModelsConfig(current);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());
    },

    async deleteProvider(name: string): Promise<void> {
      const current = readModelsConfig();
      delete current.providers[name];
      writeModelsConfig(current);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());
    },

    async addModel(providerName: string, model: ModelEntry): Promise<void> {
      const current = readModelsConfig();
      const provider = current.providers[providerName];
      if (!provider) throw new Error(`Provider "${providerName}" does not exist`);
      if (provider.models.find((m) => m.id === model.id)) {
        throw new Error(`Model "${model.id}" already exists`);
      }
      provider.models.push(normalizeModelInput(model));
      writeModelsConfig(current);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());
    },

    async deleteModel(providerName: string, modelId: string): Promise<void> {
      const current = readModelsConfig();
      const provider = current.providers[providerName];
      if (!provider) throw new Error(`Provider "${providerName}" does not exist`);
      provider.models = provider.models.filter((m) => m.id !== modelId);
      writeModelsConfig(current);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());
    },

    async updateModel(providerName: string, modelId: string, model: Partial<ModelEntry>): Promise<void> {
      const current = readModelsConfig();
      const provider = current.providers[providerName];
      if (!provider) throw new Error(`Provider "${providerName}" does not exist`);
      const idx = provider.models.findIndex((m) => m.id === modelId);
      if (idx === -1) throw new Error(`Model "${modelId}" does not exist`);

      // No normalizeModelInput() here: on edit, a field the user did not touch
      // must not be rewritten (it could silently flip a text-only model to
      // multimodal just because the new name matches a heuristic). Fresh adds
      // and read-time migration handle that.
      const updated = { ...provider.models[idx], ...model };
      const nextId = updated.id.trim();
      if (!nextId) throw new Error('Model ID cannot be empty');
      if (nextId !== modelId && provider.models.some((m, i) => i !== idx && m.id === nextId)) {
        throw new Error(`Model "${nextId}" already exists`);
      }

      provider.models[idx] = { ...updated, id: nextId };
      writeModelsConfig(current);
      configuredProviders = await refreshConfiguredProviders(await getRegistry());

      // A rename changes the id downstream code uses to look the model up, so
      // keep the saved default-model selection pointing at it. Match on the id
      // alone: the desktop composer only ever writes defaultModel, so
      // defaultProvider can be stale (e.g. left by the CLI), and config.get()
      // resolves the default by id anyway.
      if (nextId !== modelId && settings.getDefaultModel() === modelId) {
        settings.setDefaultModel(nextId);
        await settings.flush();
      }
    },
  };
}
