import { create } from 'zustand';
import type { PermissionDecision, PermissionMode, PermissionRequest } from '@pi/types';

// Shared with main through @pi/types (it is the enforcer; the drift risk of
// two definitions is exactly what moving them there removes). Re-exported so
// the store stays the renderer's import surface for them.
export type { PermissionMode, PermissionDecision, PermissionRequest };

/**
 * Session-scoped permission modes, mirrored from main.
 *
 * Main owns the truth (mode table + pending approvals); this store is the
 * renderer's projection: the composer reads the mode for its badge, and
 * ToolCallDisplay looks up pending approvals by toolCallId to render the
 * inline approval card. The last picked mode seeds sessions with no explicit
 * choice (in-memory only — a restart resets everything); remembered 总是允许
 * approvals stay scoped to one conversation.
 */

function electronApi():
  | { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: (channel: string, cb: (...args: unknown[]) => void) => void }
  | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: ReturnType<typeof electronApi> }).electronAPI;
}

interface PermissionState {
  /** One mode for every conversation, like the model/thinking settings. */
  mode: PermissionMode;
  /** Pending approval keyed by toolCallId — matches the tool_call block in the timeline. */
  pendingByToolCall: Record<string, PermissionRequest>;

  setMode: (mode: PermissionMode) => void;
  receiveRequest: (request: PermissionRequest) => void;
  removeRequest: (requestId: string) => void;
  /** Pull the mode + this conversation's in-flight requests (session switch / reload). */
  sync: (sessionId: string) => Promise<void>;
  /** Answer an approval card: resolves on main, drops the card immediately. */
  resolve: (request: PermissionRequest, decision: PermissionDecision) => void;
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  mode: 'default',
  pendingByToolCall: {},

  setMode: (mode) => {
    set({ mode });
    // Main is the enforcer — persist there too, but never roll back the UI if
    // the round-trip fails: the toggle staying responsive matters more.
    electronApi()
      ?.invoke('pi:permission:set-mode', { mode })
      .catch(() => {});
  },

  receiveRequest: (request) =>
    set((s) => ({
      pendingByToolCall: { ...s.pendingByToolCall, [request.toolCallId]: request },
    })),

  removeRequest: (requestId) =>
    set((s) => {
      const next = { ...s.pendingByToolCall };
      for (const [key, req] of Object.entries(next)) {
        if (req.requestId === requestId) delete next[key];
      }
      return { pendingByToolCall: next };
    }),

  sync: async (sessionId) => {
    const api = electronApi();
    if (!api) return;
    try {
      const state = (await api.invoke('pi:permission:sync', sessionId)) as {
        mode: PermissionMode;
        pending: PermissionRequest[];
      } | undefined;
      if (!state) return;
      set((s) => {
        // Replace only THIS conversation's entries. A wholesale replace
        // dropped another session's pending approval from the renderer, so
        // switching back had to re-fetch before its card reappeared.
        const kept = Object.entries(s.pendingByToolCall).filter(
          ([, request]) => request.sessionId !== sessionId,
        );
        return {
          mode: state.mode,
          pendingByToolCall: {
            ...Object.fromEntries(kept),
            ...Object.fromEntries(state.pending.map((req) => [req.toolCallId, req])),
          },
        };
      });
    } catch {
      /* main not up yet — the next session switch or request re-syncs */
    }
  },

  resolve: (request, decision) => {
    // Drop the card first so the UI never shows an already-answered prompt,
    // even if the IPC round-trip is slow.
    get().removeRequest(request.requestId);
    electronApi()
      ?.invoke('pi:permission:resolve', { requestId: request.requestId, decision })
      .catch(() => {
        /* main gone mid-click — the abort path unblocks the agent anyway */
      });
  },
}));

/**
 * Wire the main → renderer channels. Called once from the app shell; a no-op
 * in the web build (no electronAPI → no enforcer → the UI stays hidden).
 */
export function initPermissionBridge(): void {
  const api = electronApi();
  if (!api?.on) return;
  api.on('pi:permission:request', (payload) => {
    usePermissionStore.getState().receiveRequest(payload as PermissionRequest);
  });
  // Resolved without the user (session aborted mid-approval) — retire the card.
  api.on('pi:permission:cancelled', (payload) => {
    const requestId = (payload as { requestId?: string } | undefined)?.requestId;
    if (requestId) usePermissionStore.getState().removeRequest(requestId);
  });
}
