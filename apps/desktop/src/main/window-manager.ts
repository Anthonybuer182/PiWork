import { BrowserWindow, screen } from 'electron';
import type { Rectangle } from 'electron';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_NAME } from './branding';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Icon for a dev run: there is no app bundle to take one from, so point at
 * build/ (electron-builder only reads it; it is not shipped inside the asar).
 * In a packaged build this path lands inside the asar, resolves to nothing,
 * and each platform falls back to the bundle icon.
 */
const DEV_ICON = path.join(__dirname, '../../build/icon.png');

/** Height of the renderer-drawn title bar; must match TitleBar's h-11 (2.75rem). */
export const TITLE_BAR_HEIGHT = 44;

export interface CreateWindowOptions {
  /** Registry id for this window — exposed to the renderer via argv + URL query. */
  windowId?: number;
  /** Workspace the window opens on (absolute path; the workspace id). */
  workspaceId?: string | null;
  /** Session the window opens on (absolute transcript path). */
  sessionId?: string | null;
  /** Stable per-window renderer-state id (see WindowStateStore.layoutId). */
  layoutId?: string | null;
  /** Window title (workspace name), set by the registry once it knows one. */
  title?: string;
  /** Restored geometry from the last run. Absent = place a new window. */
  bounds?: Rectangle;
  /** Restored maximized state (applied after creation). */
  maximized?: boolean;
}

export function createMainWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  // Placement: restored bounds win; otherwise open on the display the user is
  // looking at (cursor position, like VS Code) and cascade off the focused
  // window so a new window is visibly new instead of landing exactly on top.
  const placement = options.bounds ?? newWindowBounds();

  const mainWindow = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    x: placement.x,
    y: placement.y,
    minWidth: 900,
    minHeight: 600,
    title: options.title ?? APP_NAME,
    // No-op on macOS (the window takes the app's icon) and absent in packaged
    // builds; this is what puts the mark on a Linux/Windows dev window.
    icon: existsSync(DEV_ICON) ? DEV_ICON : undefined,
    // Render only once the first frame is ready — a black/white flash on
    // every new window looks like a crash in a multi-window workflow.
    show: false,
    // The renderer draws a full-width title bar. Each platform keeps its native
    // window controls a different way:
    //   macOS   — hiddenInset, traffic lights float over our bar (left inset)
    //   Windows — titleBarOverlay, caption buttons float over our bar (right inset)
    //   Linux   — frameless; the renderer draws its own controls
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const }
      : isWindows
        ? {
            titleBarStyle: 'hidden' as const,
            // Colors are provisional; the renderer pushes the resolved theme
            // colors over `pi:window:setTitleBarOverlay` on every theme change.
            titleBarOverlay: {
              color: '#ffffff',
              symbolColor: '#3f3f46',
              height: TITLE_BAR_HEIGHT,
            },
          }
        : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Identity the preload exposes synchronously as electronAPI.windowId.
      // Query parameters carry the initial workspace/session instead, because
      // those are paths and can be long or contain spaces.
      additionalArguments:
        options.windowId != null ? [`--pi-window-id=${options.windowId}`] : [],
    },
  });

  const query: Record<string, string> = {};
  if (options.windowId != null) query.piWin = String(options.windowId);
  if (options.workspaceId) query.piWs = options.workspaceId;
  if (options.sessionId) query.piSession = options.sessionId;
  // Stable across restarts (unlike windowId, which is 1..N by creation order).
  if (options.layoutId) query.piLayout = options.layoutId;

  // In development, load from vite dev server
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    mainWindow.loadURL(url.toString());
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
  }

  // The title names the workspace so Mission Control / the Window menu can
  // tell windows apart. A page-title change (the renderer's <title>) must not
  // replace it.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (mainWindow.isDestroyed()) return;
    if (options.maximized) mainWindow.maximize();
    if (!process.env.PI_E2E) mainWindow.show();
  });
  // A renderer that never reaches ready-to-show must not leave an invisible
  // app behind: show anyway, the failure is the renderer's to surface.
  const showFallback = setTimeout(() => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible() && !process.env.PI_E2E) {
      mainWindow.show();
    }
  }, 4000);
  mainWindow.once('closed', () => clearTimeout(showFallback));

  return mainWindow;
}

function newWindowBounds(): Rectangle {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const focused = BrowserWindow.getFocusedWindow();
  const focusedBounds = focused && !focused.isDestroyed() ? focused.getBounds() : null;
  if (focusedBounds) {
    return {
      x: focusedBounds.x + 28,
      y: focusedBounds.y + 28,
      width: Math.min(1400, width),
      height: Math.min(900, height),
    };
  }
  // No window to cascade from: centre on the display under the mouse.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const w = Math.min(1400, Math.max(900, area.width - 120));
  const h = Math.min(900, Math.max(600, area.height - 120));
  return { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2), width: w, height: h };
}
