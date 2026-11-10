/**
 * Storage measurement and relocation.
 *
 * Sizes are measured here, in main: the renderer has no file-system access to
 * the agent directory, and walking tens of thousands of files over IPC would be
 * far worse than returning one number per area.
 */
import { app } from 'electron';
import { constants, existsSync } from 'node:fs';
import { access, cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ChangeAgentDirResult, StorageEntry, StorageInfo } from '@pi/types';
import {
  appliedAgentDirOverride,
  defaultAgentDir,
  liveAgentDir,
  readConfigFile,
  storageConfigFile,
  writeConfigFile,
} from './settings';

interface Measured {
  bytes: number;
  files: number;
}

/**
 * Recursive size of a directory. It is deliberately sequential and ignores
 * symlinks (neither following nor counting them): following links can loop,
 * and a link's own size says nothing about the data it points at.
 */
async function measureDir(root: string): Promise<Measured> {
  let bytes = 0;
  let files = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        bytes += info.size;
        files += 1;
      } catch {
        // A file removed mid-walk is not an error worth failing the whole scan.
      }
    }
  };

  await walk(root);
  return { bytes, files };
}

async function measureMany(paths: string[]): Promise<Measured> {
  const results = await Promise.all(paths.map((p) => measureDir(p)));
  return results.reduce((acc, r) => ({ bytes: acc.bytes + r.bytes, files: acc.files + r.files }), {
    bytes: 0,
    files: 0,
  });
}

function entry(id: StorageEntry['id'], path: string, measured: Measured): StorageEntry {
  return { id, path, bytes: measured.bytes, files: measured.files };
}

/** Files already present in a directory, ignoring the Finder's litter. */
async function existingFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => name !== '.DS_Store');
}

export class StorageService {
  constructor(
    private readonly appDataDir: string = app.getPath('userData'),
    private readonly configFile: string = storageConfigFile(),
    /** Overridable so tests never touch the real `~/.pi/agent`. */
    private readonly builtinDir: string = defaultAgentDir(),
  ) {}

  /** True while a saved location differs from the one this run is using. */
  private pending(configured: string | null, live: string): boolean {
    if (configured) return resolve(configured) !== resolve(live);
    return appliedAgentDirOverride() !== null && resolve(live) !== resolve(this.builtinDir);
  }

  async info(): Promise<StorageInfo> {
    const agentDir = liveAgentDir();
    const configured = readConfigFile(this.configFile);
    const restartRequired = this.pending(configured, agentDir);

    // The areas that carry actual bulk. Everything else in the agent dir —
    // config files, prompts, the todos file — is folded into "other" so the
    // rows add up to the real total.
    const [sessions, plugins, skills, runtime] = await Promise.all([
      measureDir(join(agentDir, 'sessions')),
      measureDir(join(agentDir, 'plugins')),
      measureMany([
        join(agentDir, 'skills'),
        join(agentDir, 'extensions'),
        join(agentDir, 'agents'),
      ]),
      measureMany([join(agentDir, 'npm'), join(agentDir, 'bin')]),
    ]);

    const [agentTotal, appTotal] = await Promise.all([
      measureDir(agentDir),
      measureDir(this.appDataDir),
    ]);

    const accounted = sessions.bytes + plugins.bytes + skills.bytes + runtime.bytes;
    const counted = sessions.files + plugins.files + skills.files + runtime.files;
    const other: Measured = {
      bytes: Math.max(0, agentTotal.bytes - accounted),
      files: Math.max(0, agentTotal.files - counted),
    };

    const entries: StorageEntry[] = [
      entry('sessions', join(agentDir, 'sessions'), sessions),
      entry('plugins', join(agentDir, 'plugins'), plugins),
      entry('skills', join(agentDir, 'skills'), skills),
      entry('runtime', join(agentDir, 'npm'), runtime),
      entry('other', agentDir, other),
      entry('app-data', this.appDataDir, appTotal),
    ];

    return {
      agentDir,
      defaultAgentDir: this.builtinDir,
      custom: configured !== null,
      restartRequired,
      pendingAgentDir: restartRequired ? (configured ?? this.builtinDir) : null,
      appDataDir: this.appDataDir,
      entries,
      totalBytes: agentTotal.bytes + appTotal.bytes,
    };
  }

  /**
   * Point the app at `dir`.
   *
   * A non-empty target is used as-is — that is how someone points the app at
   * data they moved by hand or keep in a synced folder. An empty target gets a
   * copy of the current data when `migrate` is set, so the usual case (pick a
   * new disk, keep your conversations) needs no manual step.
   */
  async change(dir: string, migrate: boolean): Promise<ChangeAgentDirResult> {
    const target = resolve(dir);
    const current = resolve(liveAgentDir());

    if (target === current) {
      throw new Error('这个文件夹已经是当前的数据位置。');
    }
    if (target.startsWith(current + sep)) {
      throw new Error('新位置不能放在当前的数据目录里面。');
    }

    await mkdir(target, { recursive: true });
    try {
      await access(target, constants.W_OK);
    } catch {
      throw new Error('这个文件夹不能写入，请换一个。');
    }

    const usedExisting = (await existingFiles(target)).length > 0;
    let copiedFiles = 0;

    if (!usedExisting && migrate && existsSync(current)) {
      await cp(current, target, { recursive: true, force: false, errorOnExist: false });
      copiedFiles = (await measureDir(target)).files;
    }

    writeConfigFile(this.configFile, target);
    return { info: await this.info(), copiedFiles, usedExisting };
  }

  /** Return to the default location, copying data back into an empty default. */
  async reset(): Promise<ChangeAgentDirResult> {
    const current = resolve(liveAgentDir());
    const fallback = resolve(this.builtinDir);
    let copiedFiles = 0;
    let usedExisting = false;

    if (current !== fallback && existsSync(current)) {
      await mkdir(fallback, { recursive: true });
      usedExisting = (await existingFiles(fallback)).length > 0;
      if (!usedExisting) {
        await cp(current, fallback, { recursive: true, force: false, errorOnExist: false });
        copiedFiles = (await measureDir(fallback)).files;
      }
    }

    writeConfigFile(this.configFile, null);
    return { info: await this.info(), copiedFiles, usedExisting };
  }
}
