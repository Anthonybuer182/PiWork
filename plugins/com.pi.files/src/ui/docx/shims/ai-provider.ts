/**
 * Stand-in for `@genoffice/ai-provider`.
 *
 * The plugin runs the HOST's agent, so GenOffice's provider layer is not
 * shipped. What survives is the type surface, because `shared/ipc.ts` re-exports
 * these names and the renderer type-checks against them.
 *
 * `AI_PROVIDERS` is the one runtime value. It only feeds GenOffice's own model
 * picker, which lives inside the AI panel we replaced — so an empty list is
 * both correct and honest: this plugin has no providers of its own to offer.
 * The model list belongs to the host, not here.
 */

/** GenOffice's provider descriptors. Empty: the host owns model choice. */
export const AI_PROVIDERS: AiProviderMeta[] = [];

export interface AiProviderMeta {
  id: string;
  label: string;
  models: string[];
  [key: string]: unknown;
}

export type AiProviderId = string;

export interface AiProviderConfig {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  [key: string]: unknown;
}

export interface AiSettings {
  providers?: Record<string, AiProviderConfig>;
  activeProvider?: string | null;
  [key: string]: unknown;
}

export interface AiChatRequest {
  messages?: unknown[];
  [key: string]: unknown;
}

export interface AiChatResponse {
  text?: string;
  error?: string;
  [key: string]: unknown;
}

export interface AiStreamRequest {
  requestId?: string;
  [key: string]: unknown;
}

export interface AiStreamChunk {
  requestId?: string;
  delta?: string;
  done?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface GenSparkAccountStatus {
  loggedIn?: boolean;
  email?: string | null;
  [key: string]: unknown;
}

/** Whether GenOffice's provider layer can generate images. The plugin has no
 *  provider layer — the host owns models — so this is always false. */
export function imageGenerationAvailable(..._args: unknown[]): boolean {
  return false;
}

// ── Provider-selection helpers ───────────────────────────────────────────
// Newer GenOffice builds move these out of the AI panel and call them from
// `App.tsx` / `desktop-api.ts` while building the panel's initial state. The
// plugin has no provider layer at all (the host owns model choice), so the
// selection helpers are identity operations and the labeller falls back.

export interface AiCustomProfile {
  id?: string;
  name?: string;
  api?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface AiCustomEndpoint extends AiCustomProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The configured provider id, if there is one; the host owns the real default. */
export function activeProvider(settings: AiSettings): AiProviderId {
  const provider = settings.activeProvider;
  return typeof provider === 'string' && provider ? provider : 'host';
}

export function normalizeCustomProfile(raw: unknown): AiCustomProfile | undefined {
  return raw && typeof raw === 'object' ? (raw as AiCustomProfile) : undefined;
}

/** No custom endpoints exist here; settings pass through untouched. */
export function resolveCustomEndpoints(settings: AiSettings): AiSettings {
  return settings;
}

export function upsertCustomEndpoint(
  settings: AiSettings,
  _endpoint: AiCustomEndpoint,
  _activate = false,
): AiSettings {
  return settings;
}

export function customEndpointLabel(endpoint: AiCustomEndpoint, fallback: string): string {
  return endpoint?.name || endpoint?.baseUrl || fallback;
}
