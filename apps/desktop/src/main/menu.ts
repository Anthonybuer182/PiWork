import { app, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME } from './branding';
import type { WindowRegistry } from './windows';

export type MenuLanguage = 'zh' | 'en';

/**
 * The native menu labels, per interface language.
 *
 * They cannot come from Electron's role defaults: role labels follow the OS
 * locale, not 设置 → 通用 → 语言, so a Chinese system would keep an English
 * menu (and the reverse). Every item therefore spells out its label and keeps
 * its `role` for the behavior and accelerator.
 */
const MENU_LABELS: Record<MenuLanguage, Record<string, string>> = {
  zh: {
    about: `关于 ${APP_NAME}`,
    hide: `隐藏 ${APP_NAME}`,
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: `退出 ${APP_NAME}`,
    file: '文件',
    newWindow: '新建窗口',
    closeWindow: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    speech: '语音',
    startSpeaking: '开始朗读',
    stopSpeaking: '停止朗读',
    view: '视图',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '切换开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '切换全屏',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    bringAllToFront: '全部置于顶层',
    help: '帮助',
    reportBug: '报告问题',
    suggestFeature: '功能建议',
  },
  en: {
    about: `About ${APP_NAME}`,
    hide: `Hide ${APP_NAME}`,
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: `Quit ${APP_NAME}`,
    file: 'File',
    newWindow: 'New Window',
    closeWindow: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    speech: 'Speech',
    startSpeaking: 'Start Speaking',
    stopSpeaking: 'Stop Speaking',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    bringAllToFront: 'Bring All to Front',
    help: 'Help',
    reportBug: 'Report a Bug',
    suggestFeature: 'Suggest a Feature',
  },
};

/**
 * The language the menu is currently drawn in. The renderer owns the real
 * preference (localStorage, so it works without the backend); main keeps this
 * copy only because the menu bar exists before — and independently of — any
 * renderer.
 */
const REPO_URL = 'https://github.com/Anthonybuer182/PiWork';

/**
 * Issue forms pre-fill fields by their `id`, so the menu can hand the bug
 * form the same build details the 关于 page sends. Keep the ids in sync with
 * `.github/ISSUE_TEMPLATE/bug_report.yml`.
 */
function feedbackUrl(template: string, params: Record<string, string> = {}): string {
  // `URLSearchParams` writes spaces as `+`; GitHub's prefill expects `%20`.
  const query = new URLSearchParams({ template, ...params }).toString().replace(/\+/g, '%20');
  return `${REPO_URL}/issues/new?${query}`;
}

function platformLabel(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

function openExternal(url: string): void {
  void import('electron').then(({ shell }) => shell.openExternal(url));
}

let language: MenuLanguage = 'zh';
let windows: WindowRegistry | null = null;
/** True once a renderer has sent its language, which then outranks the file. */
let rendererReported = false;

function languageFile(): string {
  return join(app.getPath('userData'), 'menu-language.json');
}

/** Anything but an explicit `en` falls back to the app's Chinese default. */
export function normalizeMenuLanguage(value: unknown): MenuLanguage {
  return value === 'en' ? 'en' : 'zh';
}

function loadPersistedLanguage(): MenuLanguage {
  try {
    const file = languageFile();
    if (!existsSync(file)) return 'zh';
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { language?: unknown };
    return normalizeMenuLanguage(parsed?.language);
  } catch {
    return 'zh';
  }
}

function persistLanguage(next: MenuLanguage): void {
  try {
    writeFileSync(languageFile(), JSON.stringify({ language: next }), 'utf8');
  } catch (err) {
    console.warn('[menu] could not persist language:', err);
  }
}

function buildTemplate(registry: WindowRegistry, lang: MenuLanguage): MenuItemConstructorOptions[] {
  const l = MENU_LABELS[lang];
  const isMac = process.platform === 'darwin';

  return [
    ...(isMac
      ? ([
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: l.about },
              { type: 'separator' },
              { role: 'hide', label: l.hide },
              { role: 'hideOthers', label: l.hideOthers },
              { role: 'unhide', label: l.showAll },
              { type: 'separator' },
              { role: 'quit', label: l.quit },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: l.file,
      submenu: [
        {
          label: l.newWindow,
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            registry.newFromFocused();
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: l.closeWindow } : { role: 'quit', label: l.quit },
      ],
    },
    {
      label: l.edit,
      submenu: [
        { role: 'undo', label: l.undo },
        { role: 'redo', label: l.redo },
        { type: 'separator' },
        { role: 'cut', label: l.cut },
        { role: 'copy', label: l.copy },
        { role: 'paste', label: l.paste },
        ...(isMac
          ? ([
              { role: 'pasteAndMatchStyle', label: l.pasteAndMatchStyle },
              { role: 'delete', label: l.delete },
              { role: 'selectAll', label: l.selectAll },
              { type: 'separator' },
              {
                label: l.speech,
                submenu: [
                  { role: 'startSpeaking', label: l.startSpeaking },
                  { role: 'stopSpeaking', label: l.stopSpeaking },
                ],
              },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: 'delete', label: l.delete },
              { type: 'separator' },
              { role: 'selectAll', label: l.selectAll },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: l.view,
      submenu: [
        { role: 'reload', label: l.reload },
        { role: 'forceReload', label: l.forceReload },
        { role: 'toggleDevTools', label: l.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: l.resetZoom },
        { role: 'zoomIn', label: l.zoomIn },
        { role: 'zoomOut', label: l.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: l.toggleFullScreen },
      ],
    },
    {
      // Keep the `windowMenu` role (macOS registers the menu as the app's
      // window list) while supplying a localized submenu; an explicit submenu
      // overrides the role's built-in English one.
      role: 'windowMenu',
      label: l.window,
      submenu: [
        { role: 'minimize', label: l.minimize },
        ...(isMac
          ? ([
              { role: 'zoom', label: l.zoom },
              { type: 'separator' },
              { role: 'front', label: l.bringAllToFront },
            ] satisfies MenuItemConstructorOptions[])
          : ([{ role: 'close', label: l.closeWindow }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      label: l.help,
      submenu: [
        {
          label: 'GitHub',
          click: () => openExternal(REPO_URL),
        },
        {
          label: l.reportBug,
          click: () =>
            openExternal(
              feedbackUrl('bug_report.yml', { version: app.getVersion(), os: platformLabel() }),
            ),
        },
        {
          label: l.suggestFeature,
          click: () => openExternal(feedbackUrl('feature_request.yml')),
        },
      ],
    },
  ];
}

function rebuildApplicationMenu(): void {
  if (!windows) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(windows, language)));
}

/**
 * The application menu.
 *
 * Electron ships a default menu when none is set; replacing it means the
 * standard roles (Edit copy/paste, View reload, Window) have to be spelled
 * out again, otherwise macOS loses its text-editing accelerators the moment
 * we add a File menu of our own.
 *
 * The menu is app-global, so it is rebuilt (not per window) whenever the
 * renderer reports a language change through `setApplicationLanguage`.
 */
export function installApplicationMenu(registry: WindowRegistry): void {
  windows = registry;
  // The renderer may have reported its language before the plugin boot
  // finished and this ran; its localStorage is the source of truth, so never
  // let the (possibly stale) file overwrite what it just sent.
  if (!rendererReported) language = loadPersistedLanguage();
  rebuildApplicationMenu();
}

/**
 * Follow 设置 → 通用 → 语言. Called from the renderer (the setting lives in
 * localStorage there) with the values `zh` | `en`.
 */
export function setApplicationLanguage(value: unknown): void {
  const next = normalizeMenuLanguage(value);
  rendererReported = true;
  const changed = next !== language;
  language = next;
  // Persist even when unchanged: the file is how a later launch draws the
  // right menu before any renderer exists (e.g. after localStorage was reset
  // while the file still said `en`).
  persistLanguage(next);
  if (changed) rebuildApplicationMenu();
}
