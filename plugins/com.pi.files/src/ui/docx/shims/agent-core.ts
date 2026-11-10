/**
 * Stand-in for `@genoffice/agent-core`.
 *
 * Only the *type* `AgentSkill` is imported from it, by two files under `ai/`
 * that describe document skills to GenOffice's agent. The plugin runs the
 * host's agent, so nothing from this package executes — the import exists to
 * satisfy the type checker in GenOffice's own source, which we do not modify.
 */

export interface AgentSkill {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface AgentMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface AgentToolCall {
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface AgentToolDef {
  name?: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export type AgentTransport = unknown;
export type AgentImage = unknown;

/**
 * The pieces sheets' App.tsx imports at module scope.
 *
 * They belong to GenOffice's agent, which the plugin replaces — but an unused
 * import still has to resolve, so they exist and refuse to run. Constructing an
 * `AgentLoop` must fail loudly rather than silently producing an agent that
 * never calls the host.
 */
export class AgentLoop {
  /** sheets' `events` object, so `run` can report through the loop's own
   *  channel. See `run`. */
  private readonly events?: {
    onError?: (message: string) => void;
  };

  /** Constructible but inert. Throwing here was wrong: sheets' App builds one
   *  during render, so a throw took the whole editor down with it — the AI
   *  panel is optional, the spreadsheet is not. */
  constructor(options?: { events?: { onError?: (message: string) => void } }) {
    this.events = options?.events;
  }

  /**
   * Report the run as failed, through `onError`.
   *
   * This used to throw. That looked equivalent and was not: the caller is
   * `void collectImageAttachments(...).then(...).catch(...)`, so a synchronous
   * throw became an unhandled rejection and the loop's own `onError` — the only
   * thing that clears `aiBusy` — never ran. `aiBusy` is checked at the top of
   * `handleSend`, so the FIRST sheets submission went through and every one
   * after it returned silently: the panel answered once per launch.
   *
   * Reporting through `onError` is what the loop would do for a real transport
   * failure, and it lands the message in the status bar the same way.
   */
  run(): void {
    this.events?.onError?.('由宿主 AI 处理中，回复见主对话');
  }

  abort(): void {
    /* nothing to abort */
  }

  dispose(): void {
    /* nothing to dispose */
  }
}

/** GenOffice's sentinel for "the task finished by calling tools" — a literal. */
export const COMPLETED_VIA_TOOLS_TEXT = '[completed-via-tools]';

export function composeSkills(..._args: unknown[]): unknown[] {
  return [];
}

/** A skill the user attached to one message, from the composer. */
export interface AttachedSkill {
  name: string;
  body: string;
}

/**
 * Prepends attached skill text to the instruction, verbatim as upstream does.
 *
 * Pure string composition, so it is safe to keep real: sheets calls it while
 * building a message, and returning the instruction unchanged would silently
 * drop a user-picked skill. Nothing here reaches a provider — the resulting
 * text is what the host agent receives.
 */
export function withAttachedSkills(
  instruction: string,
  skills: readonly AttachedSkill[],
): string {
  if (!skills || skills.length === 0) return instruction;
  const blocks = skills
    .map((s) => `<skill name="${s.name.replace(/"/g, '')}">\n${s.body.trim()}\n</skill>`)
    .join('\n\n');
  return (
    `The user attached the following skill${skills.length > 1 ? 's' : ''} to this request. ` +
    `Follow their steps and constraints with the tools you have; where a skill and general ` +
    `guidance disagree, the skill wins.\n\n${blocks}\n\nUser request:\n${instruction}`
  );
}
