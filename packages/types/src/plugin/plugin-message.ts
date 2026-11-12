/**
 * Plugin-originated messages in the conversation timeline.
 *
 * A plugin posts one of these through the host's `messages` capability. The
 * host persists it as a pi `custom` session entry (customType below): it is
 * part of the session transcript and replays with the conversation, but it is
 * NOT sent to the model (no token cost, no context pollution). A plugin that
 * needs the model to see something uses `chat.send`, which stores the same
 * data on a `custom_message` entry and starts the turn there.
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

/**
 * Where the content a request is about came from — the page a selection was
 * taken from, the document an edit belongs to. Purely presentational: the host
 * renders it as one small origin line on the card.
 */
export interface PluginMessageSource {
  /** Human-readable origin, e.g. a page or document title. */
  label?: string;
  /** A URL/link the origin can be reopened from, when there is one. */
  url?: string;
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
  /**
   * Model-facing text when it differs from the visible copy. `chat.send`
   * requests put the instruction here while `text` stays what the user reads;
   * without it `text` serves both purposes.
   */
  agentText?: string;
  /** Short headline for a request card, e.g. 「解释网页内容」. */
  title?: string;
  /** The passage the request is about, rendered as a quote block. */
  quote?: string;
  /** Where that passage came from (page, document, file). */
  source?: PluginMessageSource;
  /**
   * This message started an agent turn (posted through `chat.send`). The card
   * says so, because "the AI has been handed this" is the useful fact — not
   * that the model can see it.
   */
  triggered?: boolean;
  files?: PluginMessageFile[];
  status?: PluginMessageStatus;
  /**
   * When true, this revision is appended as a pi `custom_message` entry and
   * reaches the model as context (the `agentText`, else the `text`, else a
   * short synthesized line). Default false: kept in the transcript, never sent
   * to the model.
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
