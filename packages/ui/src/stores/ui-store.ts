import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { setPanelLayoutWorkspace, usePanelStore } from './panel-store';
import { useComposerStore } from './composer-store';
import { windowScopedStorage, hasDesktopWindowApi } from '@/lib/window-identity';
import { openWithSystemApp } from '@/lib/utils';

/**
 * Route an absolute path through the filePreview contribution chain and open
 * it in the right column.
 *
 * Exported (rather than living only in `setActivePreviewFile`) so a multi-file
 * drop can await the routing in drop order — concurrent `find-preview`
 * responses would otherwise open the tabs in arbitrary order and focus the
 * wrong one.
 */
export async function openPreviewFile(path: string): Promise<void> {
  useUIStore.setState({ activePreviewFilePath: path });

  const api = (window as unknown as {
    electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };
  }).electronAPI;
  if (!api?.invoke) return;

  try {
    const res = await api.invoke('pi:plugin:find-preview', { path });
    const panelId = (res as { panelId?: string | null } | undefined)?.panelId;
    if (panelId) {
      useUIStore.setState({ rightPanelOpen: true });
      // The store routes this into the FOCUSED editor group: it reuses that
      // group's empty tab or opens a new tab there, leaving every other group
      // untouched. That is exactly the VS Code editor-group behaviour.
      usePanelStore.getState().openPanel(panelId, { focus: true, params: { file: path } });
    } else {
      // No preview plugin claims this extension — code files, and the
      // formats the file viewer deliberately leaves out (mkv/avi, Office
      // formats without a renderer). Hand it to the system instead:
      // falling through silently made the click look broken.
      openWithSystemApp(path, useUIStore.getState().activeWorkspaceId ?? undefined);
    }
  } catch {
    // A dropped file with no route is not actionable enough to toast; the
    // panel simply does not open.
  }
}

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

interface UIState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  activePreviewFilePath: string | null;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  /**
   * Centre column visibility. Hidden with CSS (`hidden`), never unmounted —
   * the centre owns the composer, and a plugin `chat.send` still has to reach
   * it while the column is hidden.
   */
  centerPanelOpen: boolean;
  /**
   * Put the chat to the RIGHT of the plugin panel in the two-column
   * workbench (sidebar closed). People who drive the panel — browser, viewer,
   * a document — read it as the primary surface and want the conversation as
   * a side column; three columns keep the standard order, because the
   * sidebar is the platform's left rail and the chat never crosses it.
   */
  chatRightOfPanels: boolean;
  /**
   * Settings is a centred dialog, not a column view: its pages need more room
   * than the 300px sidebar can give, and configuration is an interruption of
   * the workspace rather than a place to work in. Opening it also silences
   * every native panel view (see LiveSlot) — those sit above the DOM and would
   * otherwise cover the dialog and swallow its clicks.
   */
  settingsOpen: boolean;
  rightPanelWidth: number;
  leftPanelWidth: number;
  compactMode: boolean;
  /**
   * Skills switched off in Settings → Skills. This is a UI-level availability
   * list (the SDK has no global skill switch): disabled skills disappear from
   * the composer and never reach a prompt.
   */
  disabledSkills: string[];
  connectionStatus: ConnectionStatus;

  setActiveWorkspace: (id: string | null) => void;
  /**
   * Set workspace and session in one update. Use when the session for the new
   * workspace is already prepared — see `switchWorkspace()` in lib/. Setting
   * them separately renders a frame with a workspace but no session, which
   * makes the centre panel flash.
   */
  setActiveWorkspaceAndSession: (workspaceId: string | null, sessionId: string | null) => void;
  setActiveSession: (id: string | null) => void;
  setActivePreviewFile: (path: string | null) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  toggleCenterPanel: () => void;
  toggleChatSide: () => void;
  openSettings: () => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setCenterPanelOpen: (open: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setLeftPanelWidth: (width: number) => void;
  setCompactMode: (compact: boolean) => void;
  toggleSkillEnabled: (skillId: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      activeSessionId: null,
      activePreviewFilePath: null,
      sidebarOpen: true,
      rightPanelOpen: false,
      centerPanelOpen: true,
      chatRightOfPanels: false,
      settingsOpen: false,
      rightPanelWidth: 600,
      // A comfortable width for the session list and file tree, and the width
      // the column is dragged from.
      leftPanelWidth: 300,
      compactMode: false,
      disabledSkills: [],
      connectionStatus: 'connecting',

      // A workspace change also switches which saved panel layout applies —
      // layouts belong to the folder, not to the window.
      setActiveWorkspace: (id) => {
        useComposerStore.getState().enterSession(null);
        set({ activeWorkspaceId: id, activeSessionId: null });
        setPanelLayoutWorkspace(id);
      },
      setActiveWorkspaceAndSession: (workspaceId, sessionId) => {
        useComposerStore.getState().enterSession(sessionId);
        set({ activeWorkspaceId: workspaceId, activeSessionId: sessionId });
        setPanelLayoutWorkspace(workspaceId);
      },
      // Switch the panel store's session slice BEFORE the session id reaches
      // React. Child LiveSlots react to `activeSessionId` in effects that run
      // before the App's enterSession effect; if the tabs were still mounted
      // there, every stashed panel would re-report itself as belonging to the
      // NEW session (and the browser's host↔engine mapping would go stale).
      // Doing the swap synchronously makes the old tabs disappear from the
      // render before any of them can observe the new session.
      setActiveSession: (id) => {
        usePanelStore.getState().enterSession(id);
        // Swap the visible live-run slot and draft in the same synchronous
        // step, so the first frame of the new conversation is idle unless it
        // has a run of its own.
        useComposerStore.getState().enterSession(id);
        set({ activeSessionId: id });
      },
      // File selection routes through the filePreview contribution chain:
      // a plugin panel claims the extension — there is no host fallback
      // (preview is fully plugin-owned).
      setActivePreviewFile: (path) => {
        if (!path) {
          set({ activePreviewFilePath: null });
          return;
        }
        void openPreviewFile(path);
      },
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      // "Visible" means not closed AND not covered by a maximized right panel —
      // the toggle's pressed state follows the same definition, so clicking
      // while maximized reveals the chat by dropping the maximize.
      toggleCenterPanel: () => set((s) => ({ centerPanelOpen: !s.centerPanelOpen })),
      toggleChatSide: () => set((s) => ({ chatRightOfPanels: !s.chatRightOfPanels })),
      openSettings: () => set({ settingsOpen: true }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
      setCenterPanelOpen: (open) => set({ centerPanelOpen: open }),
      setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
      setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),
      setCompactMode: (compact: boolean) => set({ compactMode: compact }),
      toggleSkillEnabled: (skillId: string) =>
        set((s) => ({
          disabledSkills: s.disabledSkills.includes(skillId)
            ? s.disabledSkills.filter((id) => id !== skillId)
            : [...s.disabledSkills, skillId],
        })),
      setConnectionStatus: (status) => set({ connectionStatus: status }),
    }),
    {
      name: 'pi-ui-storage',
      // One set of layout preferences per window: two windows of the same app
      // share localStorage, so an unscoped key would make them fight.
      storage: createJSONStorage(() => windowScopedStorage('pi-ui-storage')),
      // Web (and any first launch before a window context arrives) restores
      // its workspace from this store — point the panel layout at it too.
      onRehydrateStorage: () => (state) => {
        if (state?.activeWorkspaceId) setPanelLayoutWorkspace(state.activeWorkspaceId);
      },
      partialize: (state) => ({
        // Which conversation a window shows is owned by MAIN (window state +
        // the session claim) and delivered over pi:window:context. Persisting
        // it per window would make it a second, silently diverging source of
        // truth; the web build has no main process, so it keeps persisting.
        ...(hasDesktopWindowApi()
          ? {}
          : {
              activeWorkspaceId: state.activeWorkspaceId,
              activeSessionId: state.activeSessionId,
            }),
        sidebarOpen: state.sidebarOpen,
        // rightPanelOpen is intentionally NOT persisted: the right side
        // defaults to the icon rail only — panels open on explicit action
        // (rail click) or agent event, never restored open across restarts.
        // centerPanelOpen likewise: the chat is the app's primary surface —
        // a launch that restores it hidden would read as broken.
        rightPanelWidth: state.rightPanelWidth,
        // A layout preference like the widths above, not a view state: someone
        // who reads the panel and keeps the chat on the right wants it back
        // that way after a restart.
        chatRightOfPanels: state.chatRightOfPanels,
        leftPanelWidth: state.leftPanelWidth,
        compactMode: state.compactMode,
        disabledSkills: state.disabledSkills,
      }),
    },
  ),
);
