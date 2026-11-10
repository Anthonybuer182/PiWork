import { ipcMain, dialog, app } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createRealWorkspaceService,
  createRealSessionService,
  createRealFileService,
  createRealConfigService,
  createRealChatService,
} from '@pi/sdk-wrapper/adapters';
import type { PluginDoc, RealChatServiceOptions } from '@pi/sdk-wrapper/adapters';
import type { WorkspaceService, SessionService, FileService, ConfigService, ChatService, SendMessageParams, FileSearchOptions } from '@pi/sdk-wrapper';
import { windows } from '@main/windows';
import { hostWindowOf } from './guard';

// Services are created during registerIpcHandlers() (called from app.whenReady)
// to avoid module-load-time initialization in packaged builds.
let workspaceService: WorkspaceService;
let sessionService: SessionService;
let fileService: FileService;
let configService: ConfigService;
let chatService: ChatService;

interface SdkRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface RegisterIpcHandlersOptions {
  /** Supplies plugin-contributed agent tools (customTools for the SDK). */
  customToolsProvider?: () => unknown[];
  /** Supplies the installed-plugins index (each plugin's PLUGIN.md) for the system prompt. */
  pluginDocsProvider?: () => PluginDoc[];
  /** Per-session host hook (e.g. the permission gate) — see RealChatServiceOptions. */
  onSessionCreated?: RealChatServiceOptions['onSessionCreated'];
  /** Settings → 工具 switches, merged into every session's tool denylist. */
  getGlobalDisabledTools?: RealChatServiceOptions['getGlobalDisabledTools'];
  /** Called after the run is aborted and before the session file is removed. */
  onSessionDeleted?: (sessionId: string) => void;
  /** MCP servers — see RealChatServiceOptions.mcp. */
  mcp?: RealChatServiceOptions['mcp'];
}

let onSessionDeletedHook: ((sessionId: string) => void) | undefined;

export function registerIpcHandlers(
  settingsManager: SettingsManager,
  modelRuntime?: ModelRuntime,
  options?: RegisterIpcHandlersOptions,
): { chatService: ChatService } {
  // One ModelRuntime for the whole process: config writes and chat's visible
  // model list must read the same catalog. When the host does not pass one in,
  // the adapters lazily create (and share) their own.
  // app.getPath('home') is stable across platforms and never points inside
  // the app bundle (unlike process.cwd() in packaged builds).
  const defaultCwd = app.getPath('home');

  workspaceService = createRealWorkspaceService();
  sessionService = createRealSessionService();
  fileService = createRealFileService();
  configService = createRealConfigService(defaultCwd, undefined, modelRuntime, settingsManager);
  onSessionDeletedHook = options?.onSessionDeleted;
  chatService = createRealChatService(defaultCwd, modelRuntime, settingsManager, {
    customToolsProvider: options?.customToolsProvider,
    pluginDocsProvider: options?.pluginDocsProvider,
    onSessionCreated: options?.onSessionCreated,
    getGlobalDisabledTools: options?.getGlobalDisabledTools,
    mcp: options?.mcp,
  });

  // The renderer owns "which workspace is on screen" — a view fact, not a
  // session one — so main has no other way to learn it. Each window reports
  // into its own context: with several windows open, "the active workspace"
  // is the focused window's, never a module-level global.
  ipcMain.handle(
    'pi:agent:set-active-workspace',
    (event, workspace: { id?: string; path?: string } | null) => {
      const ctx = hostWindowOf(event);
      if (!ctx) return;
      windows.setWorkspace(
        ctx.windowId,
        workspace?.path ? { id: workspace.id ?? '', path: workspace.path } : null,
      );
    },
  );

  // Same view-fact reasoning for the conversation: the renderer switches
  // sessions, main has no other way to learn it. The handler lives with the
  // other plugin IPC (registerPluginIpcHandlers), which holds the PluginSystem.

  // ── Standard request/response ──
  ipcMain.handle('pi:sdk:request', async (event, request: SdkRequest) => {
    const { id, method, params } = request;
    try {
      if (!hostWindowOf(event)) throw new Error('untrusted IPC sender');
      enforceSessionOwnership(event, method, params);
      const result = await routeRequest(method, params, event);
      return { id, result };
    } catch (error) {
      return {
        id,
        error: {
          code: -1,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  });

  // ── Streaming request ──
  ipcMain.handle('pi:sdk:stream', async (event, { method, params, streamId }) => {
    const [service, action] = (method as string).split('.');
    if (service !== 'chat' || action !== 'sendMessageStream') {
      event.sender.send('pi:stream:chunk:' + streamId, {
        type: 'error',
        error: `Unsupported streaming method: ${method}`,
      });
      return;
    }

    const p = params as unknown as SendMessageParams;

    try {
      if (!hostWindowOf(event)) throw new Error('untrusted IPC sender');
      enforceSessionOwnership(event, method, params);
      await chatService.sendMessageStream(
        p,
        (chunk) => {
          event.sender.send('pi:stream:chunk:' + streamId, chunk);
        },
      );
      event.sender.send('pi:stream:chunk:' + streamId, { type: 'done' });
    } catch (err) {
      event.sender.send('pi:stream:chunk:' + streamId, {
        type: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // ── Stream abort (for AbortSignal-based cancellation from renderer) ──
  ipcMain.handle('pi:sdk:stream:abort', async (_event, { streamId }) => {
    await chatService.stopGeneration(streamId);
  });

  return { chatService };
}

/**
 * Chat actions that write to a conversation's transcript or run. A session is
 * claimed by exactly one window, so a call for a session owned by a window
 * other than the caller's is refused — otherwise two windows could steer (or
 * abort) one live AgentSession.
 */
const WRITE_CHAT_ACTIONS = new Set([
  'sendMessage',
  'sendMessageStream',
  'steer',
  'followUp',
  'navigateTree',
  'compact',
  'stopGeneration',
]);

function enforceSessionOwnership(event: IpcMainInvokeEvent, method: string, params: unknown): void {
  const [service, action] = method.split('.');
  if (service !== 'chat' || !WRITE_CHAT_ACTIONS.has(action)) return;
  const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;

  const caller = windows.byWebContents(event.sender);
  if (!caller) return; // plugin view / unknown sender: legacy behaviour
  const owner = windows.activeOwnerOf(sessionId);
  if (owner && owner.windowId !== caller.windowId) {
    throw new Error('该会话已在另一个窗口打开，请在那个窗口里继续');
  }
  // A run belongs to the window that started it, even after the user
  // navigates that window to another conversation.
  windows.touchRunOwner(sessionId, caller.windowId);
}

async function routeRequest(
  method: string,
  params: unknown,
  event?: IpcMainInvokeEvent,
): Promise<unknown> {
  const [service, action] = method.split('.');
  if (!service || !action) {
    throw new Error(`Invalid method format: ${method}`);
  }

  switch (service) {
    case 'workspace': return handleWorkspace(action, params);
    case 'session': return handleSession(action, params);
    case 'chat': return handleChat(action, params);
    case 'file': return handleFile(action, params);
    case 'config': return handleConfig(action, params);
    case 'system': return handleSystem(action, event);
    default:
      throw new Error(`Unknown service: ${service}`);
  }
}

async function handleWorkspace(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'list': return workspaceService.list();
    case 'get': return workspaceService.get(p.id as string);
    case 'create': return workspaceService.create(p.name as string, p.path as string);
    case 'delete': return workspaceService.delete(p.id as string);
    case 'update': return workspaceService.update(p.id as string, p.data as Record<string, unknown>);
    default: throw new Error(`Unknown workspace action: ${action}`);
  }
}

async function handleSession(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'list': return sessionService.list(p.workspaceId as string);
    case 'get': return sessionService.get(p.id as string);
    case 'create': return sessionService.create(p.workspaceId as string, p.title as string | undefined);
    case 'delete': {
      const id = p.id as string;
      // Stop first: the run may be blocked inside asktool (holding a promise
      // and a card), and deleting the file under a live writer is worse.
      try { await chatService.stopGeneration(id); } catch { /* best-effort */ }
      onSessionDeletedHook?.(id);
      // No window owns a deleted conversation any more; if it was open
      // elsewhere, that window falls back to the workspace's next session.
      windows.releaseActiveSession(id);
      return sessionService.delete(id);
    }
    case 'updateTitle': return sessionService.updateTitle(p.id as string, p.title as string);
    case 'getTree': return sessionService.getTree(p.id as string);
    default: throw new Error(`Unknown session action: ${action}`);
  }
}

async function handleChat(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'sendMessage':
      return chatService.sendMessage(p as unknown as SendMessageParams);
    case 'getMessages':
      return chatService.getMessages(p.sessionId as string, p.limit as number | undefined, p.offset as number | undefined);
    case 'stopGeneration':
      return chatService.stopGeneration(p.sessionId as string);
    case 'steer':
      return chatService.steer(p.sessionId as string, p.content as string, p.images as any);
    case 'followUp':
      return chatService.followUp(p.sessionId as string, p.content as string, p.images as any);
    case 'navigateTree':
      return chatService.navigateTree(p.sessionId as string, p.entryId as string, p.options as any);
    case 'compact':
      return chatService.compact(p.sessionId as string, p.customInstructions as string | undefined);
    // ── agent context (Settings → 上下文 and host tools) ──
    case 'getAgentContextConfig':
      return chatService.getAgentContextConfig(
        p.workspacePath as string,
        p.workspaceId as string | undefined,
        p.sessionId as string | undefined,
      );
    case 'reloadAgentContext':
      return chatService.reloadAgentContext(p.workspacePath as string);
    case 'getGlobalContextInfo':
      return chatService.getGlobalContextInfo();
    case 'reloadAgentContextForFile':
      return chatService.reloadAgentContextForFile(
        p.filePath as string,
        p.preferredWorkspace as string | undefined,
      );
    case 'writeContextFile':
      return chatService.writeContextFile(p as unknown as Parameters<typeof chatService.writeContextFile>[0]);
    case 'deleteContextFile':
      return chatService.deleteContextFile(p as unknown as Parameters<typeof chatService.deleteContextFile>[0]);
    default: throw new Error(`Unknown chat action: ${action}`);
  }
}

async function handleFile(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'read': return fileService.read(p.workspaceId as string, p.path as string);
    case 'list': return fileService.list(p.workspaceId as string, (p.directory ?? p.dirPath) as string | undefined);
    case 'write': return fileService.write(p.workspaceId as string, p.path as string, p.content as string);
    case 'delete': return fileService.delete(p.workspaceId as string, p.path as string);
    case 'readOffice': return fileService.readOffice(p.workspaceId as string, p.path as string);
    case 'search': return fileService.search(p.workspaceId as string, p.query as string, p.options as FileSearchOptions | undefined);
    case 'cancelSearch': return fileService.cancelSearch(p.searchId as string);
    default: throw new Error(`Unknown file action: ${action}`);
  }
}

async function handleConfig(action: string, params: unknown): Promise<unknown> {
  const p = params as Record<string, unknown>;
  switch (action) {
    case 'get': return configService.get();
    case 'update': return configService.update(p.data as any);
    case 'listModels': return configService.listModels();
    case 'listSkills': return configService.listSkills();
    case 'getSkillPaths': return configService.getSkillPaths();
    case 'setSkillPaths': return configService.setSkillPaths(p.paths as string[]);
    case 'getModelsConfig': return configService.getModelsConfig();
    case 'saveModelsConfig': return configService.saveModelsConfig(p.config as any);
    case 'upsertProvider': return configService.upsertProvider(p.name as string, p.provider as any);
    case 'listRemoteModels':
      return configService.listRemoteModels(
        p as { baseUrl: string; api: string; apiKey: string },
      );
    case 'saveProvider':
      return configService.saveProvider(
        (p.originalName as string | null) ?? null,
        p.name as string,
        p.provider as any,
      );
    case 'deleteProvider': return configService.deleteProvider(p.name as string);
    case 'addModel': return configService.addModel(p.providerName as string, p.model as any);
    case 'deleteModel': return configService.deleteModel(p.providerName as string, p.modelId as string);
    case 'updateModel': return configService.updateModel(p.providerName as string, p.modelId as string, p.model as any);
    default: throw new Error(`Unknown config action: ${action}`);
  }
}

async function handleSystem(action: string, event?: IpcMainInvokeEvent): Promise<unknown> {
  switch (action) {
    case 'selectDirectory': {
      // Parent the picker to the window that asked; an unparented dialog on
      // macOS floats free of the window it belongs to.
      const parent = event ? windows.byWebContents(event.sender)?.win : undefined;
      const options: Electron.OpenDialogOptions = {
        title: 'Select workspace folder',
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    }
    default: throw new Error(`Unknown system action: ${action}`);
  }
}
