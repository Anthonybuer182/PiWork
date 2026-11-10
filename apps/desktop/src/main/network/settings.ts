/**
 * The persisted proxy choice, in userData/network.json.
 *
 * A plain file, like the storage location: it must be readable the moment the
 * main process starts, before any window exists, so the very first provider
 * request already knows the route. Changes apply without a restart — both
 * stacks read the setting per request — so this file only has to survive to
 * the next launch.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProxySettings } from '@pi/types';
import { DEFAULT_PROXY_SETTINGS, sanitizeProxySettings } from './rules';

const STORAGE_VERSION = 1;

interface NetworkFile {
  version?: unknown;
  mode?: unknown;
  url?: unknown;
}

/** Read the saved route; anything unreadable falls back to 跟随系统. */
export function readProxySettings(file: string): ProxySettings {
  if (!existsSync(file)) return { ...DEFAULT_PROXY_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as NetworkFile;
    if (parsed?.version !== STORAGE_VERSION) return { ...DEFAULT_PROXY_SETTINGS };
    return sanitizeProxySettings(parsed, DEFAULT_PROXY_SETTINGS);
  } catch (err) {
    console.warn('[network] unreadable network.json, following the system proxy:', err);
    return { ...DEFAULT_PROXY_SETTINGS };
  }
}

/** Save the route atomically. */
export function writeProxySettings(file: string, settings: ProxySettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const body: NetworkFile = {
    version: STORAGE_VERSION,
    mode: settings.mode,
    url: settings.url,
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  renameSync(tmp, file);
}
