import { useMemo, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createProxySDKClient, IPCTransport } from '@pi/sdk-wrapper';
import {
  SDKProvider,
  useSDK,
  useTheme,
  useUIStore,
  TooltipProvider,
  useComposerStore,
  usePluginStore,
  usePanelStore,
  panelIdOfTab,
  useCommandStore,
  usePermissionStore,
  initPermissionBridge,
  useAskStore,
  initAskBridge,
  useTodoStore,
  initTodoBridge,
  initToolBridge,
  initPluginVoiceBridge,
  getPluginBridge,
  toast,
  useI18n,
} from '@pi/ui';
import { AppShell } from '@pi/ui';
import { LayoutToggles, PanelTabs } from '@pi/ui';
import { ThreeColumnLayout } from '@pi/ui';
import { LeftSidebar } from '@pi/ui';
import { CenterPanel } from '@pi/ui';
import { PanelHost } from '@pi/ui';
import { SettingsDialog, SettingsRailButton } from '@pi/ui';
import { WorkspaceDropdown } from '@pi/ui';
import { WorkspaceCreateButton } from '@pi/ui';
import { SessionHeader } from '@pi/ui';
import { HOST_LEFT_PANELS } from '@pi/ui';
import type { PanelEntry } from '@pi/ui';
import { ChatTimeline } from '@pi/ui';
import { Composer } from '@pi/ui';
import { UsageBar } from '@pi/ui';
import { ErrorBoundary } from '@pi/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

/**
 * The host is the zeroth panel contributor: settings / plugin-center / the
 * browser flow through the same panel registry, rail and lifecycle as plugins.
 * File preview is plugin-owned — no host fallback panel.
 */
const HOST_PANELS: PanelEntry[] = [
  { id: 'host:plugins', title: '插件中心', icon: 'puzzle', source: 'host', keepAlive: 'never', region: 'right' },
  // The browser is a plugin panel now (com.pi.browser): its page embeds the
  // host's engine view via piSDK.liveSlot. The engine and its session stay
  // host-owned — the plugin only positions and drives it.
  // Settings is NOT a panel: it opens as a centred dialog (SettingsRailButton
  // at the bottom of the left rail). A dialog has room for the side menu and
  // the provider forms, and keeps configuration out of the column layout.
  ...HOST_LEFT_PANELS,
];

function AppContent() {
  useTheme();
  const sdk = useSDK();
  const { t } = useI18n();

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const centerPanelOpen = useUIStore((s) => s.centerPanelOpen);
  const chatRightOfPanels = useUIStore((s) => s.chatRightOfPanels);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const leftPanelWidth = useUIStore((s) => s.leftPanelWidth);
  const setLeftPanelWidth = useUIStore((s) => s.setLeftPanelWidth);
  const setConnectionStatus = useUIStore((s) => s.setConnectionStatus);

  // ── Panel registry: host panels + plugin panels ──
  const setHostPanels = usePanelStore((s) => s.setHostPanels);
  const setPluginPanels = usePanelStore((s) => s.setPluginPanels);
  const openPanel = usePanelStore((s) => s.openPanel);
  const setPanelStatus = usePanelStore((s) => s.setPanelStatus);
  const setPluginCommands = useCommandStore((s) => s.setPluginCommands);

  useEffect(() => {
    setHostPanels(HOST_PANELS);
  }, [setHostPanels]);

  // Opening the right side does NOT select a panel: the tab strip is the
  // switcher, and the body stays empty until the user picks one. (It used to
  // fall back to the plugin center, which made every new window look like it
  // had opened the plugin center on its own.)

  // ── Plugin system: discovery + events + command contributions ──
  const loadPlugins = usePluginStore((s) => s.loadPlugins);
  const plugins = usePluginStore((s) => s.plugins);
  // `plugins` starts empty while discovery is in flight. Contributing that
  // empty list would make the panel registry treat every persisted plugin tab
  // as uninstalled (and write the loss to storage) — hold off until the
  // first real sync.
  const pluginsLoaded = usePluginStore((s) => s.loaded);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    if (!pluginsLoaded) return;
    setPluginPanels(plugins);
    for (const plugin of plugins) {
      setPluginCommands(plugin.id, plugin.commands ?? []);
    }
  }, [plugins, pluginsLoaded, setPluginPanels, setPluginCommands]);

  // ── Tell main which workspace is on screen ──
  // Which workspace is active is a view fact that only the renderer holds, and
  // the plugin kernel needs it to resolve the default target of `agent.*`
  // reads (which AGENTS.md chain the context plugin should show). Shares the
  // workspaces query cache with the dropdown rather than re-fetching.
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });
  useEffect(() => {
    const api = (
      window as unknown as {
        electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      }
    ).electronAPI;
    if (!api) return;
    const ws = workspaces?.find((w) => w.id === activeWorkspaceId);
    api
      .invoke('pi:agent:set-active-workspace', ws ? { id: ws.id, path: ws.path } : null)
      .catch(() => {
        /* kernel may not be up yet; the next change re-sends */
      });
  }, [workspaces, activeWorkspaceId]);

  useEffect(() => {
    const bridge = getPluginBridge();
    if (!bridge) return;
    bridge.onEvent((event) => {
      if (event.type === 'status') {
        setPanelStatus(event.status);
      } else if (event.type === 'panel-open') {
        // focus=false → pending badge only (no-focus-steal principle)
        const panelId = event.panelId
          ? `plugin:${event.pluginId}:${event.panelId}`
          : undefined;
        const target = panelId ?? usePanelStore.getState().panels.find((p) => p.source === event.pluginId)?.id;
        if (target) {
          const state = usePanelStore.getState();
          const entry = state.panels.find((p) => p.id === target);
          const region = entry?.region ?? 'right';
          const openKeys = state.openPanelIds[region].filter(
            (key) => panelIdOfTab(key) === target,
          );
          const hasParams =
            event.params !== undefined && Object.keys(event.params).length > 0;
          // Activity events (`openPanelForActivity` after every tool) carry no
          // params. In a multi-instance panel that used to create a phantom
          // empty tab and steal focus from the page the tool had just opened.
          // With an existing tab of that panel, surface THAT tab; with none,
          // fall through and let the panel open its default (favorites) tab.
          if (entry?.multiInstance && !hasParams) {
            if (event.focus === false) return;
            if (openKeys.length > 0) {
              const focused = state.focusedId[region];
              const key =
                focused && openKeys.includes(focused) ? focused : openKeys[openKeys.length - 1];
              usePanelStore.getState().setFocused(region, key);
              if (region === 'right') useUIStore.getState().setRightPanelOpen(true);
              else if (region === 'left') useUIStore.getState().setSidebarOpen(true);
              return;
            }
          }
          openPanel(target, {
            focus: event.focus,
            params: event.params,
            instanceId: event.instanceId,
          });
          // Surface the panel's own side: a backend-opened panel must not land
          // in a collapsed column the user cannot see. focus=false means
          // "badge, don't steal focus" — no reveal in that case, either region.
          if (event.focus !== false) {
            if (region === 'right') useUIStore.getState().setRightPanelOpen(true);
            else if (region === 'left') useUIStore.getState().setSidebarOpen(true);
          }
        }
      } else if (event.type === 'panel-close') {
        const target = event.panelId
          ? `plugin:${event.pluginId}:${event.panelId}`
          : usePanelStore.getState().panels.find((p) => p.source === event.pluginId)?.id;
        const entry = target
          ? usePanelStore.getState().panels.find((p) => p.id === target)
          : undefined;
        if (entry) {
          if (event.tabId) {
            usePanelStore.getState().closeTab(entry.region, event.tabId);
          } else {
            // No tab named: close every tab of that panel (the old
            // single-tab semantics).
            const keys = usePanelStore
              .getState()
              .openPanelIds[entry.region].filter((key) => panelIdOfTab(key) === entry.id);
            for (const key of keys) usePanelStore.getState().closeTab(entry.region, key);
          }
        }
      } else if (event.type === 'tab-update') {
        usePanelStore
          .getState()
          .updateTab(event.tabId, { title: event.title, params: event.params });
      } else if (event.type === 'tab-focus') {
        const panel = usePanelStore
          .getState()
          .panels.find((p) => p.id === panelIdOfTab(event.tabId));
        // focus=false is the no-focus-steal case: the tab is already open and
        // the tool only wanted the column surfaced — never move the user's
        // active tab out from under them.
        if (panel && event.focus) {
          usePanelStore.getState().setFocused(panel.region, event.tabId);
          if (panel.region === 'right') useUIStore.getState().setRightPanelOpen(true);
          else if (panel.region === 'left') useUIStore.getState().setSidebarOpen(true);
        }
      } else if (event.type === 'plugins-changed') {
        // Install/uninstall/enable/disable — refresh discovery + panels.
        usePluginStore.getState().loadPlugins();
      } else if (event.type === 'install-phase') {
        // Progress events and the install reply travel on different IPC
        // channels with no ordering guarantee — a late event can outlive its
        // install and resurrect a dead phase (a failed row stuck on its
        // spinner). A real install sets its phase optimistically before any
        // event can arrive, so an event landing on a phaseless plugin is
        // stale by definition.
        const { installPhases, setInstallPhase } = usePluginStore.getState();
        if (installPhases[event.pluginId]) setInstallPhase(event.pluginId, event.phase);
      }
    });
  }, [setPanelStatus, openPanel]);

  // ── Permission modes: bridge + per-session sync ──
  // The bridge forwards approval requests / cancellations from main into the
  // store; the sync pulls the current session's mode and any requests that
  // were already in flight (covers a renderer reload mid-approval).
  useEffect(() => {
    initPermissionBridge();
    initAskBridge();
    initTodoBridge();
    initToolBridge();
    // Plugin `voice.speak` / `voice.stop` relay (manifest permission: voice).
    initPluginVoiceBridge();
  }, []);

  const activeSessionId = useUIStore((s) => s.activeSessionId);
  useEffect(() => {
    const sessionId = activeSessionId ?? 'default';
    usePermissionStore.getState().sync(sessionId);
    // A reload loses the streaming blocks that hosted these cards; main still
    // holds the pending question / the persisted checklist, so pull both.
    useAskStore.getState().sync(sessionId);
    useTodoStore.getState().sync(sessionId);
  }, [activeSessionId]);

  // Background approvals/questions render inside that conversation's timeline.
  // When one arrives for a conversation that is not on screen, say so — the
  // run is blocked until someone answers.
  const pendingPermissions = usePermissionStore((s) => s.pendingByToolCall);
  const pendingAsks = useAskStore((s) => s.requests);
  const announcedRef = useRef(new Set<string>());
  useEffect(() => {
    const active = useUIStore.getState().activeSessionId;
    for (const request of Object.values(pendingPermissions)) {
      if (request.sessionId === active || announcedRef.current.has(request.requestId)) continue;
      announcedRef.current.add(request.requestId);
      toast(t('后台会话需要审批：{summary}', { summary: request.summary }));
    }
    for (const request of Object.values(pendingAsks)) {
      if (request.sessionId === active || announcedRef.current.has(request.requestId)) continue;
      announcedRef.current.add(request.requestId);
      toast(t('后台会话有一个问题在等你'));
    }
  }, [pendingPermissions, pendingAsks, t]);

  // ── Tell main which conversation is on screen ──
  // Same view-fact reasoning as the workspace above: only the renderer knows.
  // Session-scoped plugin backends (browser, viewer) resolve "the current
  // document/page" per conversation with it — concurrent conversations must
  // not share one.
  useEffect(() => {
    const api = (
      window as unknown as {
        electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      }
    ).electronAPI;
    if (!api) return;
    api
      .invoke('pi:agent:set-active-session', { id: activeSessionId ?? undefined })
      .catch(() => {
        /* kernel may not be up yet; the next change re-sends */
      });
  }, [activeSessionId]);

  // ── Session-scoped panels follow the conversation ──
  // enterSession is idempotent; re-running it once the plugin registry has
  // synced re-classifies tabs whose scope was unknown at first entry.
  useEffect(() => {
    usePanelStore.getState().enterSession(activeSessionId ?? null);
  }, [activeSessionId, pluginsLoaded]);

  useEffect(() => {
    sdk.connect().then(() => {
      setConnectionStatus('connected');
    }).catch(() => {
      setConnectionStatus('disconnected');
    });
  }, [sdk, setConnectionStatus]);

  // A plugin can drive the conversation via the `chat.send` capability. The
  // renderer owns the composer, so the message is relayed here and sent
  // through the same path as typing a message — which also makes it work from
  // a fullscreen plugin panel, where the composer is hidden but still mounted.
  // The plugin owns the input UI; the host only provides the ability to reach
  // the agent.
  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { on?: (channel: string, cb: (payload: unknown) => void) => void };
    }).electronAPI;
    if (!api?.on) return;
    api.on('pi:chat:send', (payload) => {
      const text = (payload as { text?: string } | undefined)?.text;
      if (text) useComposerStore.getState().setTriggerSend(text);
    });
  }, []);


  return (
    <TooltipProvider delayDuration={300}>
      <AppShell>
        <ThreeColumnLayout
          sidebarOpen={sidebarOpen}
          rightPanelOpen={rightPanelOpen}
          centerPanelOpen={centerPanelOpen}
          // Two columns (chat + panel) can be mirrored: the panel takes the
          // left edge and the chat reads on the right.
          chatRight={chatRightOfPanels}
          // Dragging a divider past a column's minimum closes that column.
          // The flag stays in the store; the layout animates and then asks.
          onSidebarCollapse={() => useUIStore.getState().setSidebarOpen(false)}
          onRightPanelCollapse={() => useUIStore.getState().setRightPanelOpen(false)}
          onCenterCollapse={() => useUIStore.getState().setCenterPanelOpen(false)}
          rightWidth={rightPanelWidth}
          onRightWidthChange={setRightPanelWidth}
          leftWidth={leftPanelWidth}
          onLeftWidthChange={setLeftPanelWidth}
          // Workspace controls: in the left segment while the sidebar is open,
          // otherwise in the centre segment's start (which then carries the
          // traffic-light inset). The centre header carries the Codex-style
          // session title (rename / session dropdown / new).
          leftHeader={
            sidebarOpen ? (
              <>
                <WorkspaceDropdown />
                <WorkspaceCreateButton />
              </>
            ) : null
          }
          centerHeader={
            <>
              {!sidebarOpen && (
                <>
                  <WorkspaceDropdown />
                  <WorkspaceCreateButton />
                </>
              )}
              <SessionHeader />
            </>
          }
          rightHeader={<PanelTabs />}
          headerTrailing={<LayoutToggles />}
          rightPanel={<PanelHost rail={false} />}
          leftSidebar={
            <LeftSidebar>
              <PanelHost region="left" railFooter={<SettingsRailButton />} />
            </LeftSidebar>
          }
          centerPanel={
            <CenterPanel>
              <ChatTimeline />
              <UsageBar />
              <Composer />
            </CenterPanel>
          }
        />
        <SettingsDialog />
      </AppShell>
    </TooltipProvider>
  );
}

export function App() {
  const sdkClient = useMemo(() => {
    const transport = new IPCTransport();
    return createProxySDKClient({ transport });
  }, []);

  return (
    <ErrorBoundary>
      <SDKProvider value={sdkClient}>
        <QueryClientProvider client={queryClient}>
          <AppContent />
        </QueryClientProvider>
      </SDKProvider>
    </ErrorBoundary>
  );
}
