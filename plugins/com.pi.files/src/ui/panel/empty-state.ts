/**
 * The panel's empty state: what a viewer tab shows before it has a file.
 *
 * A host tab is not blank — it is a real panel with a job. This one offers the
 * workspace's file tree (the same workspace the app is showing, not a system
 * picker) so the user can pick a document without leaving the panel. Picking
 * one loads it into THIS tab: the backend pushes `ui.render` and the page
 * dispatches onto the right renderer.
 *
 * Everything here is the plugin's own DOM; the host only provides the tab.
 */

import { PLUGIN_ID, backend } from '../shims/common';

const EMPTY_CSS = `
  .fi-empty {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 28px 20px;
    text-align: center;
    font-family: var(--font-sans, -apple-system, "PingFang SC", sans-serif);
    /* Host tokens are HSL COMPONENTS (--foreground arrives as "222.2 84% 4.9%"),
       so they need wrapping in hsl(). Bare, the value is not a colour, the
       declaration is dropped, and the var() fallback does NOT rescue it — that
       only fires for an UNDEFINED variable, not an invalid one. */
    color: hsl(var(--foreground, 222.2 84% 4.9%));
  }
  .fi-empty svg { color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); }
  .fi-empty-title { font-size: 14px; font-weight: 600; }
  .fi-empty-hint {
    font-size: 12.5px;
    line-height: 1.7;
    color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%));
    max-width: 32em;
  }
  .fi-empty-formats {
    margin-top: 4px;
    font-size: 11.5px;
    letter-spacing: 0.02em;
    color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%));
    opacity: 0.85;
  }
  .fi-pick {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    padding: 6px 14px;
    border: 1px solid hsl(var(--border, 214 32% 91%));
    border-radius: 7px;
    background: hsl(var(--card, 0 0% 100%));
    color: inherit;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .fi-pick:hover:not(:disabled) {
    background: hsl(var(--accent, 210 40% 96%));
    color: hsl(var(--accent-foreground, 222 47% 11%));
  }
  .fi-pick:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .fi-tree {
    width: 100%;
    max-width: 420px;
    max-height: 48vh;
    overflow: auto;
    padding: 4px;
    border: 1px solid hsl(var(--border, 214 32% 91%));
    border-radius: 8px;
    background: hsl(var(--card, 0 0% 100%));
    text-align: left;
    font-size: 12.5px;
  }
  .fi-tree[hidden] { display: none; }
  .fi-tree-root,
  .fi-row {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 25px;
    padding: 1px 6px;
    border-radius: 5px;
    white-space: nowrap;
    overflow: hidden;
  }
  .fi-tree-root { color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); }
  .fi-row { cursor: default; }
  .fi-row.dir { cursor: pointer; }
  .fi-row.file.previewable { cursor: pointer; }
  .fi-row:hover:not(.muted) {
    background: hsl(var(--accent, 210 40% 96%));
    color: hsl(var(--accent-foreground, 222 47% 11%));
  }
  .fi-row.muted { opacity: 0.45; }
  .fi-twisty {
    flex: none;
    width: 12px;
    color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%));
    font-size: 10px;
  }
  .fi-name { overflow: hidden; text-overflow: ellipsis; }
  .fi-children { margin-left: 13px; }
  .fi-tree-error {
    padding: 6px 8px;
    color: hsl(var(--destructive, 0 84% 60%));
    font-size: 12px;
  }
`;

interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}
interface DirListing {
  path: string;
  entries: DirEntry[];
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function extOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at === -1 ? '' : name.slice(at + 1).toLowerCase();
}

/**
 * The formats this plugin handles, as its own manifest declares them.
 * Read rather than restated, so the tree's "can this open?" filter cannot
 * drift from the host's `filePreview.match` routing.
 */
let cachedPreviewExts: Set<string> | null = null;

async function previewableExts(): Promise<Set<string>> {
  if (cachedPreviewExts) return cachedPreviewExts;
  try {
    const res = await fetch(`pi-plugin://${PLUGIN_ID}/manifest.json`);
    if (!res.ok) return new Set();
    const manifest = (await res.json()) as {
      contributes?: { filePreview?: { match?: string[] }[] };
    };
    const exts = (manifest.contributes?.filePreview ?? []).flatMap((f) => f.match ?? []);
    cachedPreviewExts = new Set(exts.map((e) => e.toLowerCase().replace(/^\./, '')));
    return cachedPreviewExts;
  } catch {
    return new Set();
  }
}

/** Render one directory's entries, lazily loading subdirectories. */
function renderEntries(
  container: HTMLElement,
  entries: DirEntry[],
  previewable: Set<string>,
): void {
  container.textContent = '';
  for (const entry of entries) {
    if (entry.dir) {
      const row = document.createElement('div');
      row.className = 'fi-row dir';
      const twisty = document.createElement('span');
      twisty.className = 'fi-twisty';
      twisty.textContent = '▸';
      const name = document.createElement('span');
      name.className = 'fi-name';
      name.textContent = entry.name;
      row.append(twisty, name);
      const children = document.createElement('div');
      children.className = 'fi-children';
      children.hidden = true;
      let loaded = false;
      row.addEventListener('click', async () => {
        const open = !children.hidden;
        if (open) {
          children.hidden = true;
          twisty.textContent = '▸';
          return;
        }
        children.hidden = false;
        twisty.textContent = '▾';
        if (loaded) return;
        loaded = true;
        children.textContent = '加载中…';
        try {
          const listing = await backend<DirListing>('file.listDir', { path: entry.path });
          renderEntries(children, listing.entries ?? [], previewable);
        } catch (err) {
          children.textContent = `无法读取：${err instanceof Error ? err.message : String(err)}`;
        }
      });
      container.append(row, children);
    } else {
      const supported = previewable.has(extOf(entry.name));
      const row = document.createElement('div');
      row.className = `fi-row file${supported ? ' previewable' : ' muted'}`;
      const twisty = document.createElement('span');
      twisty.className = 'fi-twisty';
      const name = document.createElement('span');
      name.className = 'fi-name';
      name.textContent = entry.name;
      row.append(twisty, name);
      if (supported) {
        row.title = entry.path;
        row.addEventListener('click', () => {
          row.classList.add('muted');
          void backend('file.open', { path: entry.path }).catch((err) => {
            row.classList.remove('muted');
            const error = document.createElement('div');
            error.className = 'fi-tree-error';
            error.textContent = `打开失败：${err instanceof Error ? err.message : String(err)}`;
            container.append(error);
          });
        });
      } else {
        row.title = '该格式不能在查看器中打开';
      }
      container.append(row);
    }
  }
}

interface WorkspaceSdk {
  workspace?: string | null;
  /** Protocol 7: replays the current workspace on subscribe, then on change. */
  onWorkspace?: (cb: (id: string | null) => void) => void;
}

/** Render the empty state into the panel's root element. */
export function mountEmptyState(): void {
  const root = document.getElementById('root');
  if (!root) return;
  const style = document.createElement('style');
  style.textContent = EMPTY_CSS;
  document.head.appendChild(style);

  root.innerHTML = `
    <div class="fi-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
      </svg>
      <div class="fi-empty-title">未选择文件</div>
      <div class="fi-empty-hint">在左侧文件树点开一个文件，或从当前工作空间选择。</div>
      <button type="button" class="fi-pick" id="fi-pick">从工作空间选择文件</button>
      <div class="fi-tree" id="fi-tree" hidden></div>
      <div class="fi-empty-formats"></div>
    </div>
  `;

  const formatsSlot = root.querySelector('.fi-empty-formats');
  void previewableExts().then((exts) => {
    if (formatsSlot) formatsSlot.textContent = [...exts].join(' · ');
  });

  const tree = root.querySelector<HTMLElement>('#fi-tree');
  const button = root.querySelector<HTMLButtonElement>('#fi-pick');
  if (!tree || !button) return;

  const sdk = window.piSDK as unknown as WorkspaceSdk | undefined;
  let workspace: string | null =
    typeof sdk?.workspace === 'string' && sdk.workspace ? sdk.workspace : null;
  let opened = false;

  // The workspace arrives over `panel.mounted`; on a reload the page can boot
  // before that report lands, so subscribing (and replaying) is what turns
  // the disabled button live without a manual reload.
  const applyWorkspace = (id: string | null): void => {
    workspace = id || null;
    opened = false;
    tree.hidden = true;
    delete tree.dataset.loaded;
    tree.textContent = '';
    if (!workspace) {
      button.disabled = true;
      button.textContent = '当前没有工作空间';
    } else {
      button.disabled = false;
      button.textContent = '从工作空间选择文件';
    }
  };
  if (sdk?.onWorkspace) sdk.onWorkspace(applyWorkspace);
  else applyWorkspace(workspace);

  button.addEventListener('click', async () => {
    if (!workspace) return;
    opened = !opened;
    tree.hidden = !opened;
    button.textContent = opened ? '收起文件树' : '从工作空间选择文件';
    if (!opened) return;
    if (tree.dataset.loaded === '1') return;
    tree.dataset.loaded = '1';
    tree.innerHTML = '<div class="fi-tree-root">加载中…</div>';
    const rootPath = workspace;
    try {
      const exts = await previewableExts();
      const listing = await backend<DirListing>('file.listDir', { path: rootPath });
      tree.textContent = '';
      const head = document.createElement('div');
      head.className = 'fi-tree-root';
      head.textContent = basename(rootPath);
      tree.append(head);
      renderEntries(tree, listing.entries ?? [], exts);
    } catch (err) {
      tree.textContent = `无法读取工作空间：${err instanceof Error ? err.message : String(err)}`;
    }
  });
}
