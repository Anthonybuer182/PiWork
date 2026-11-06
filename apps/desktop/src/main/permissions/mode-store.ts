import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionMode } from '@pi/types';

/**
 * The global permission mode, stored in pi's own settings file
 * (`<agentDir>/settings.json`, normally `~/.pi/agent/settings.json`).
 *
 * pi's `SettingsManager` writes by reading the current file and overwriting
 * only the fields it changed, so an app-specific key like `permissionMode`
 * survives its saves. The pi CLI ignores the key; PiWork reads it at launch.
 *
 * The write is a read-modify-write with a temp file + rename. Settings changes
 * are rare; the small window against a simultaneous pi settings write is
 * accepted (the worst case is one of the two changes being lost, never a
 * truncated file).
 */
export const PERMISSION_MODE_FIELD = 'permissionMode';

export function readPermissionMode(file: string): PermissionMode {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    return raw[PERMISSION_MODE_FIELD] === 'full' ? 'full' : 'default';
  } catch {
    return 'default';
  }
}

export function writePermissionMode(file: string, mode: PermissionMode): void {
  try {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Missing or unreadable: start a fresh object rather than lose the mode.
    }
    settings[PERMISSION_MODE_FIELD] = mode;
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
    renameSync(temporary, file);
  } catch (err) {
    // The in-memory gate still works; only the next launch's seed is lost.
    console.warn('[permission] could not persist mode:', err);
  }
}
