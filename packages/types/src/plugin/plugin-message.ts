/**
 * Plugin-originated messages in the conversation timeline.
 *
 * A plugin posts one of these through the host's `messages` capability. The
 * host persists it as a pi `custom` session entry (customType below): it is
 * part of the session transcript and replays with the conversation, but it is
 * NOT sent to the model (no token cost, no context pollution). A plugin that
 * needs the model to see something must use `custom_message` / chat.send
 * instead — that is deliberately a separate, explicit choice.
 *
 * Updates are append-only: the same `id` is posted again with a higher
 * `revision`, and readers fold to the latest revision. `removed: true` is a
 * tombstone.
 */
import type { UiNode } from './ui-tree.js';

/** The pi custom-entry type. Stable: session readers filter on it. */
export const PLUGIN_MESSAGE_CUSTOM_TYPE = 'piwork.plugin-message';

export type PluginMessageStatus = 'info' | 'success' | 'warning' | 'error' | 'loading';

/** A file the message should render as a host file-attachment card. */
export interface PluginMessageFile {
  /** Absolute path on disk (validated by the host). */
  path: string;
  label?: string;
}

/** Payload stored in the pi CustomEntry's `data` field. */
export interface PluginMessageData {
  /** Plugin-scoped id, stable across updates. */
  id: string;
  pluginId: string;
  sessionId: string;
  /** Monotonic; the reader keeps the highest revision per id. */
  revision: number;
  /** Declarative card tree, rendered by the host's chat card renderer. */
  card?: UiNode;
  /** Plain notification text when a full card is unnecessary. */
  text?: string;
  files?: PluginMessageFile[];
  status?: PluginMessageStatus;
  /**
   * When true, this revision is appended as a pi `custom_message` entry and
   * reaches the model as context (the `text`, or a short synthesized line).
   * Default false: kept in the transcript, never sent to the model.
   */
  agentVisible?: boolean;
  /** Epoch ms, used to place the message among agent messages. */
  createdAt: number;
  updatedAt?: number;
  /** Tombstone: the message was withdrawn. */
  removed?: boolean;
}

/** Fields an update may change. Omitted keys keep the previous value; `null`/'' clears. */
export interface PluginMessagePatch {
  card?: UiNode | null;
  text?: string;
  status?: PluginMessageStatus;
  files?: PluginMessageFile[] | null;
  /** This revision also enters model context (pi custom_message entry). */
  agentVisible?: boolean;
}

/** Live signal sent to the renderer after a plugin message changes. */
export interface PluginMessageSignal {
  sessionId: string;
}
