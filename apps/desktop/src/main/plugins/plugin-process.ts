import { utilityProcess, MessagePortMain } from 'electron';
import type { UtilityProcess } from 'electron';
import { join } from 'path';
import type {
  CapabilityCallMessage,
  HostToPluginMessage,
  PluginCommandResultMessage,
  PluginContextResultMessage,
  PluginToolContent,
  PluginToolResultMessage,
  PluginToHostMessage,
  UiNode,
} from '@pi/types';

/** Declarative card returned alongside tool results. */
type PluginToolCard = UiNode;
import { PLUGIN_PROTOCOL_VERSION } from '@pi/types';

const READY_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000];

/**
 * Owns the UtilityProcess for one plugin backend.
 *
 * Control plane: process.parentPort (lifecycle, capability calls).
 * Data plane: MessagePortMain pairs transferred on demand for UI traffic
 * (see PluginSystem.ensureUiPort).
 */
export class PluginProcess {
  readonly pluginId: string;
  private readonly backendPath: string;
  private readonly dataDir: string;
  private readonly appVersion: string;

  private child: UtilityProcess | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyTimeout: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  /** Called for every capability call from the backend. */
  onCapabilityCall: ((msg: CapabilityCallMessage) => void) | null = null;
  /** Called on state transitions ('active' | 'crashed' | 'error'). */
  onStateChange: ((state: 'active' | 'crashed' | 'error', error?: string) => void) | null = null;

  private commandSeq = 0;
  private commandPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private toolSeq = 0;
  private toolPending = new Map<string, { resolve: (v: { content?: PluginToolContent[]; details?: unknown; card?: UiNode }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private contextPending = new Map<string, { resolve: (v: string | undefined) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(opts: { pluginId: string; backendPath: string; dataDir: string; appVersion: string }) {
    this.pluginId = opts.pluginId;
    this.backendPath = opts.backendPath;
    this.dataDir = opts.dataDir;
    this.appVersion = opts.appVersion;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Spawn the backend and wait for its `ready` handshake. */
  async start(): Promise<void> {
    if (this.child) return;

    this.child = utilityProcess.fork(this.backendPath, [], {
      serviceName: `plugin:${this.pluginId}`,
      stdio: 'pipe',
    });

    this.child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[plugin:${this.pluginId}] ${chunk}`);
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[plugin:${this.pluginId}] ${chunk}`);
    });

    this.child.on('message', (msg: PluginToHostMessage) => this.handleHostMessage(msg));
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.disposed) return;
      this.handleCrash(code);
    });

    // ready handshake with timeout
    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimeout = setTimeout(() => {
        if (this.readyResolve) {
          this.kill();
          reject(new Error(`backend did not signal ready within ${READY_TIMEOUT_MS}ms`));
        }
      }, READY_TIMEOUT_MS);
    });
  }

  private handleHostMessage(msg: PluginToHostMessage): void {
    switch (msg.type) {
      case 'ready':
        if (this.readyTimeout) clearTimeout(this.readyTimeout);
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
        }
        this.restartCount = 0;
        this.onStateChange?.('active');
        break;
      case 'call':
        this.onCapabilityCall?.(msg);
        break;
      case 'command-result':
        this.resolveCommand(msg);
        break;
      case 'tool-result':
        this.resolveTool(msg);
        break;
      case 'context-result': {
        const pending = this.contextPending.get(msg.id);
        if (pending) {
          this.contextPending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.text);
        }
        break;
      }
      case 'log':
        console.log(`[plugin:${this.pluginId}] [${msg.level}] ${msg.message}`);
        break;
    }
  }

  private handleCrash(code: number): void {
    if (this.restartCount < MAX_RESTARTS) {
      const delay = RESTART_BACKOFF_MS[Math.min(this.restartCount, RESTART_BACKOFF_MS.length - 1)];
      this.restartCount++;
      this.onStateChange?.('crashed', `exit code ${code}, restarting in ${delay}ms`);
      this.restartTimer = setTimeout(() => {
        this.start()
          .then(() => this.sendInit())
          .catch((err) => {
            console.error(`[plugin:${this.pluginId}] restart failed:`, err);
            this.onStateChange?.('error', err.message);
          });
      }, delay);
    } else {
      this.onStateChange?.('error', `exited (code ${code}) and exceeded restart budget`);
    }
  }

  /** Send the init payload right after a successful ready handshake. */
  sendInit(): void {
    this.post({
      type: 'init',
      pluginId: this.pluginId,
      apiVersion: PLUGIN_PROTOCOL_VERSION,
      appVersion: this.appVersion,
      dataDir: this.dataDir,
    });
  }

  /** Transfer a fresh UI MessagePort to the backend (replaces any previous one). */
  sendUiPort(port: MessagePortMain): void {
    this.child?.postMessage({ type: 'ui-port' } satisfies HostToPluginMessage, [port]);
  }

  sendCallResult(id: string, result?: unknown, error?: string): void {
    this.post({ type: 'call-result', id, result, error });
  }

  /** Execute a contributed command in the backend, resolves with its result. */
  executeCommand(name: string, args?: string): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error(`backend not running`));
    }
    const id = 'cmd-' + ++this.commandSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commandPending.delete(id);
        reject(new Error(`command ${name} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.commandPending.set(id, { resolve, reject, timer });
      this.post({ type: 'command', id, name, args });
    });
  }

  private resolveCommand(msg: PluginCommandResultMessage): void {
    const pending = this.commandPending.get(msg.id);
    if (!pending) return;
    this.commandPending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  }

  /**
   * Fire-and-forget: the user interacted with a declarative card this
   * plugin's tool returned into the chat timeline (ToolCallDisplay → IPC →
   * here). One-way, like host-event; the backend's onCardEvent decides what
   * to do with it. A backend written for protocol 3 simply ignores the
   * message (its pump's default case is a no-op).
   */
  sendCardEvent(toolName: string, eventId: string, kind: 'click' | 'submit', payload?: unknown): void {
    this.post({ type: 'card-event', toolName, eventId, kind, payload });
  }

  /** Fire-and-forget: a card inside a plugin-originated message was used. */
  sendMessageAction(
    messageId: string,
    eventId: string,
    kind: 'click' | 'submit',
    payload?: unknown,
    sessionId?: string,
  ): void {
    this.post({ type: 'message-action', messageId, eventId, kind, payload, sessionId });
  }

  /** Execute an agent tool in the backend; resolves with agent-facing result. */
  executeTool(
    name: string,
    params: Record<string, unknown>,
    sessionId?: string,
    workspaceId?: string,
  ): Promise<{ content?: PluginToolContent[]; details?: unknown; card?: PluginToolCard }> {
    if (!this.child) {
      return Promise.reject(new Error('backend not running'));
    }
    const id = 'tool-' + ++this.toolSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.toolPending.delete(id);
        reject(new Error(`tool ${name} timed out`));
      }, TOOL_TIMEOUT_MS);
      this.toolPending.set(id, { resolve, reject, timer });
      this.post({ type: 'tool-call', id, name, params, sessionId, workspaceId });
    });
  }

  private resolveTool(msg: PluginToolResultMessage): void {
    const pending = this.toolPending.get(msg.id);
    if (!pending) return;
    this.toolPending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve({ content: msg.content, details: msg.details, card: msg.card });
  }

  /** Collect context from the backend before a message send. */
  requestContext(providerId: string, message: string): Promise<string | undefined> {
    if (!this.child) return Promise.reject(new Error('backend not running'));
    const id = 'ctx-' + ++this.commandSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.contextPending.delete(id);
        reject(new Error(`context provider ${providerId} timed out`));
      }, 10_000);
      this.contextPending.set(id, { resolve, reject, timer });
      this.post({ type: 'context-request', id, providerId, message });
    });
  }

  /** Push a host event (e.g. browser.urlChanged) to the backend. */
  pushHostEvent(event: string, data?: unknown): void {
    this.post({ type: 'host-event', event, data });
  }

  private post(msg: HostToPluginMessage): void {
    try {
      this.child?.postMessage(msg);
    } catch (err) {
      console.error(`[plugin:${this.pluginId}] postMessage failed:`, err);
    }
  }

  kill(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    this.readyReject?.(new Error('disposed'));
    this.readyResolve = null;
    this.readyReject = null;
    for (const pending of this.commandPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('backend disposed'));
    }
    this.commandPending.clear();
    for (const pending of this.toolPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('backend disposed'));
    }
    this.toolPending.clear();
    for (const pending of this.contextPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('backend disposed'));
    }
    this.contextPending.clear();
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

/** Convenience: spawn + init in one step. */
export async function spawnBackend(opts: {
  pluginId: string;
  rootPath: string;
  backendEntry: string;
  dataDir: string;
  appVersion: string;
}): Promise<PluginProcess> {
  const proc = new PluginProcess({
    pluginId: opts.pluginId,
    backendPath: join(opts.rootPath, opts.backendEntry),
    dataDir: opts.dataDir,
    appVersion: opts.appVersion,
  });
  await proc.start();
  proc.sendInit();
  return proc;
}
