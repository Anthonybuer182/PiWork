import { existsSync, lstatSync, promises as fsp, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ImportedEntry, ImportFilesResult, SkippedImport } from '@pi/types';

/**
 * Copy the paths a user dropped onto the file tree into the workspace root.
 *
 * Kept free of Electron imports so the behavior can be unit-tested directly
 * (see `tests/import-files.test.mjs`). The renderer never supplies the
 * destination: the workspace root comes from the caller (main's per-window
 * context), and every destination is derived from it here.
 *
 * Copy, never move; never overwrite — a colliding name becomes
 * `name (1).ext`, then `name (2).ext`, and so on.
 */

/** True when `child` is `parent` or lives under it (either separator). */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * First free `name`, `name (n).ext` … in `dir`.
 *
 * Extensions are split for files only, except dotfiles (`.env` keeps its
 * name intact — `extname` already returns '' for it, but `.env.local` is
 * treated as base `.env` + ext `.local`, which reads correctly when renamed).
 */
export function uniquePath(dir: string, name: string, isDirectory: boolean): string {
  const direct = join(dir, name);
  if (!existsSync(direct)) return direct;

  const ext = isDirectory ? '' : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`No free name for ${name}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function importFilesIntoWorkspace(
  workspaceRoot: string,
  sources: unknown,
): Promise<ImportFilesResult> {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error('Workspace root must be an absolute path');
  }
  const root = resolve(workspaceRoot);
  if (!statSync(root).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`);
  }
  const rootReal = realpathSync(root);

  if (!Array.isArray(sources)) {
    throw new Error('Dropped sources must be an array of paths');
  }

  const imported: ImportedEntry[] = [];
  const skipped: SkippedImport[] = [];
  const seen = new Set<string>();

  for (const raw of sources) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      skipped.push({ source: String(raw ?? ''), reason: 'invalid-source' });
      continue;
    }
    if (!isAbsolute(raw)) {
      skipped.push({ source: raw, reason: 'invalid-source' });
      continue;
    }

    const source = resolve(raw);
    if (seen.has(source)) {
      skipped.push({ source, reason: 'duplicate' });
      continue;
    }
    seen.add(source);

    let destination: string | null = null;
    try {
      lstatSync(source);
      const sourceReal = realpathSync(source);
      const sourceIsDirectory = statSync(sourceReal).isDirectory();

      // Dropping a folder that contains the workspace (or the workspace root
      // itself) would recurse into its own destination.
      if (sourceIsDirectory && isWithin(rootReal, sourceReal)) {
        skipped.push({ source, reason: 'destination-inside-source' });
        continue;
      }

      // Already sitting at the workspace root: copying would just make a
      // duplicate of the user's own file.
      const direct = join(root, basename(source));
      if (existsSync(direct)) {
        try {
          if (realpathSync(direct) === sourceReal) {
            skipped.push({ source, reason: 'already-in-workspace' });
            continue;
          }
        } catch {
          // A dangling link at the destination is not the source; fall
          // through and let uniquePath pick a free name.
        }
      }

      destination = uniquePath(root, basename(source), sourceIsDirectory);
      await fsp.cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        // Keep symlinks as links: following one could copy an arbitrary
        // external tree, or recurse when it points back into the workspace.
        dereference: false,
        verbatimSymlinks: true,
      });
      imported.push({ source, path: destination });
    } catch (err) {
      // `uniquePath` only returns a free name, so whatever exists at
      // `destination` now belongs to this failed copy. Remove the half-written
      // tree instead of leaving it to look imported.
      if (destination) {
        await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        skipped.push({ source, reason: 'missing' });
      } else {
        skipped.push({ source, reason: 'failed', message: errorMessage(err) });
      }
    }
  }

  return { destination: root, imported, skipped };
}
