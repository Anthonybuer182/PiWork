/**
 * Per-plugin "show plugin messages in conversations" preference.
 *
 * This is a USER preference, not plugin state: a plugin must not be able to
 * un-mute itself, and uninstalling the plugin should not silently lose the
 * choice. It lives in userData next to the other host preferences
 * (tool-settings.json, network.json) and is enforced by the renderer, which
 * filters plugin messages by pluginId.
 *
 * Muting hides the messages but does not delete them: unmuting brings the
 * history back, and an `agentVisible` message still reaches the model (mute is
 * about the user's timeline, not the agent's context).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface PluginMessageSettingsFile {
  muted?: string[];
}

export class PluginMessageSettingsService {
  private readonly muted = new Set<string>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as PluginMessageSettingsFile;
      for (const id of parsed?.muted ?? []) {
        if (typeof id === 'string' && id) this.muted.add(id);
      }
    } catch (err) {
      console.warn('[plugin-messages] settings read failed:', err);
    }
  }

  /** Muted plugin ids, sorted for a stable store value. */
  listMuted(): string[] {
    return [...this.muted].sort();
  }

  setMuted(pluginId: string, muted: boolean): string[] {
    const id = String(pluginId ?? '').trim();
    if (!id) throw new Error('pluginId is required');
    if (muted) this.muted.add(id);
    else this.muted.delete(id);
    this.save();
    return this.listMuted();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ muted: this.listMuted() }, null, 2), 'utf-8');
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[plugin-messages] settings write failed:', err);
    }
  }
}
