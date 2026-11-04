/**
 * The persisted choice of where agent data lives.
 *
 * The SDK derives every data path — sessions, settings, auth, models, plugins,
 * skills — from `getAgentDir()`, which honours `PI_CODING_AGENT_DIR` when it is
 * set. So the choice is kept in a tiny file inside userData and pushed into the
 * environment before the SDK is first touched.
 *
 * It is a plain file rather than a field in one of the existing settings
 * services because it must be readable synchronously at module load, before
 * `SettingsManager` or the plugin registry exists — those are exactly the
 * consumers that need to know the answer.
 *
 * The file lives in userData, which itself stays at the OS default: moving it
 * would move Chromium's caches and every other Electron-managed file, and the
 * value worth relocating is the agent's data, not the app's runtime state.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const CONFIG_VERSION = 1;
/** Read by the SDK in `getAgentDir()`; the name comes from its package name. */
const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';

interface StorageFile {
  version: number;
  agentDir?: string;
}

export function storageConfigFile(): string {
  return join(app.getPath('userData'), 'storage.json');
}

/** The built-in location, i.e. what `getAgentDir()` answers with no override. */
export function defaultAgentDir(): string {
  return join(homedir(), '.pi', 'agent');
}

/** Read a saved location from `file`; null when there is none. */
export function readConfigFile(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StorageFile;
    if (parsed?.version !== CONFIG_VERSION) return null;
    const dir = parsed.agentDir;
    return typeof dir === 'string' && dir.trim() ? dir : null;
  } catch (err) {
    // A corrupt file must not brick startup; fall back to the default and let
    // the next save overwrite it.
    console.warn('[storage] unreadable storage.json, using the default location:', err);
    return null;
  }
}

/** Save `dir` into `file`, or clear the override when null. Writes atomically. */
export function writeConfigFile(file: string, dir: string | null): void {
  mkdirSync(dirname(file), { recursive: true });
  const body: StorageFile = {
    version: CONFIG_VERSION,
    ...(dir ? { agentDir: dir } : {}),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** The location saved in Settings, or null while the default applies. */
function readConfiguredAgentDir(): string | null {
  return readConfigFile(storageConfigFile());
}

/** The override this run started with, if any. */
let appliedFromConfig: string | null = null;

/** The override this process applied at startup; null when the env owns it. */
export function appliedAgentDirOverride(): string | null {
  return appliedFromConfig;
}

/**
 * Push the saved choice into the environment. Must run before the first
 * `getAgentDir()` call — the plugin registry constructor already calls it.
 */
export function applyStorageSettings(): void {
  const configured = readConfiguredAgentDir();
  if (configured) {
    process.env[ENV_AGENT_DIR] = configured;
    appliedFromConfig = configured;
  }
}

/** Where the SDK is reading from in this run (env override included). */
export function liveAgentDir(): string {
  return getAgentDir();
}
