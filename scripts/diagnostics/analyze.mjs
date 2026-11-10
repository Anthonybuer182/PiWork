/**
 * Session trajectory analyzer — shared by the CLI report and the diagnostics
 * plugin.
 *
 * Pure: takes session JSONL text, returns a JSON-safe report. No printing, no
 * filesystem discovery (the one convenience wrapper reads a path).
 *
 * The caller decides where the text comes from: the CLI reads ~/.pi/agent,
 * the plugin backend reads the current session through the host capability.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SCHEMA_VERSION = 1;

export function parseSessionText(text) {
  let header = null;
  const entries = [];
  let noise = 0;
  let legacy = 0;
  let previousId = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      noise++;
      continue;
    }
    if (obj && typeof obj === 'object' && obj.type === 'session' && obj.id && !header) {
      header = obj;
      continue;
    }
    if (!obj || typeof obj !== 'object') {
      noise++;
      continue;
    }
    if (!obj.id) {
      // Very old v1 sessions are a linear run of entries without ids. Give
      // them synthetic ones so the same path builder works; everything else
      // without an id is a streaming event dump and has no journal value.
      if (obj.type === 'message') {
        obj.id = `legacy-${entries.length}`;
        obj.parentId = previousId;
        obj.timestamp ??= new Date(0).toISOString();
        entries.push(obj);
        previousId = obj.id;
        legacy++;
      } else {
        noise++;
      }
      continue;
    }
    entries.push(obj);
    previousId = obj.id;
  }

  return { header, entries, noise, legacy };
}

function activePath(entries, includeBranches) {
  if (includeBranches || entries.length === 0) return entries;
  const byId = new Map();
  for (const entry of entries) byId.set(entry.id, entry);
  let current = entries[entries.length - 1];
  const path = [];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  path.reverse();
  // Broken parent links (hand-edited or pre-v2 files): trust file order.
  if (path.length === 1 && entries.length > 1) return entries;
  return path;
}

// ── Small helpers ────────────────────────────────────────────────────────

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function entryTime(entry, message) {
  if (typeof message?.timestamp === 'number') return message.timestamp;
  const parsed = Date.parse(entry?.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
  }
  return '';
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') total += block.text.length;
    if (typeof block.data === 'string') total += block.data.length;
  }
  return total;
}

export function preview(text, max = 120) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function extractToolCalls(message) {
  const calls = [];
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const type = String(block.type ?? '');
      if (type !== 'toolCall' && type !== 'tool_call') continue;
      const toolCallId = block.toolCallId ?? block.id ?? null;
      if (!toolCallId) continue;
      const args = block.arguments ?? block.input ?? block.args;
      calls.push({
        toolCallId,
        toolName: block.name ?? block.toolName ?? 'unknown',
        argsChars: args == null ? 0 : JSON.stringify(args).length,
        argsPreview: args == null ? null : preview(JSON.stringify(args), 160),
      });
    }
  }
  return calls;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const totalTokens = num(usage.totalTokens) || input + output;
  const cost = usage.cost;
  const costTotal = typeof cost === 'number' ? cost : num(cost?.total);
  const billed = Boolean(cost && typeof cost === 'object' && cost.totalFromProvider === true);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    reasoning: typeof usage.reasoning === 'number' ? usage.reasoning : null,
    cost: costTotal,
    billed,
  };
}

export function fmtMs(value) {
  if (value == null) return '—';
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function analyzeParsed(parsed, opts = {}) {
  if (!parsed.header) {
    throw new Error(`${opts.file ?? 'session'} has no session header (it looks like a raw event dump)`);
  }
  const path = activePath(parsed.entries, opts.branches);
  const header = parsed.header;
  const events = {
    modelChanges: [],
    thinkingLevelChanges: [],
    compactions: [],
    contextEdits: 0,
    custom: [],
    sessionInfo: [],
  };
  const runs = [];
  const orphanToolResults = [];
  let run = null;
  let previousActivityEnd = null;
  let lastModel = null;
  let lastThinking = null;

  const ensureRun = (ts) => {
    if (run) return run;
    run = {
      index: runs.length + 1,
      startedAt: ts,
      entryId: null,
      preview: null,
      orphanStart: true,
      turns: [],
    };
    runs.push(run);
    return run;
  };

  for (const entry of path) {
    switch (entry.type) {
      case 'model_change':
        lastModel = { provider: entry.provider ?? null, modelId: entry.modelId ?? null };
        events.modelChanges.push({
          entryId: entry.id,
          ts: entry.timestamp,
          duringRun: Boolean(run && run.turns.length > 0),
          ...lastModel,
        });
        continue;
      case 'thinking_level_change':
        lastThinking = entry.thinkingLevel ?? null;
        events.thinkingLevelChanges.push({
          entryId: entry.id,
          ts: entry.timestamp,
          duringRun: Boolean(run && run.turns.length > 0),
          level: lastThinking,
        });
        continue;
      case 'compaction':
        events.compactions.push({
          entryId: entry.id,
          ts: entry.timestamp,
          tokensBefore: numOrNull(entry.tokensBefore),
          firstKeptEntryId: entry.firstKeptEntryId ?? null,
          usage: normalizeUsage(entry.usage),
          fromHook: Boolean(entry.fromHook),
        });
        continue;
      case 'context_edit':
        events.contextEdits++;
        continue;
      case 'custom':
        events.custom.push({ entryId: entry.id, customType: entry.customType ?? null });
        continue;
      case 'session_info':
        events.sessionInfo.push({ entryId: entry.id, name: entry.name ?? null });
        continue;
      case 'message':
        break;
      default:
        continue;
    }

    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    const ts = entryTime(entry, message);

    if (message.role === 'user') {
      if (run) {
        run.endedAt = run.endedAt ?? previousActivityEnd;
        run = null;
      }
      run = {
        index: runs.length + 1,
        startedAt: ts,
        entryId: entry.id,
        preview: preview(textOf(message), 100),
        orphanStart: false,
        turns: [],
      };
      runs.push(run);
      previousActivityEnd = ts;
      continue;
    }

    if (message.role === 'assistant') {
      if (ts == null) continue;
      const activeRun = ensureRun(ts);
      const durationMs = numOrNull(message.durationMs);
      const endedAt = durationMs != null ? ts + durationMs : null;
      const toolCalls = extractToolCalls(message);
      const span = {
        kind: 'model',
        entryId: entry.id,
        startedAt: ts,
        endedAt,
        durationMs,
        provider: message.provider ?? lastModel?.provider ?? null,
        model: message.model ?? lastModel?.modelId ?? null,
        api: message.api ?? null,
        responseId: message.responseId ?? null,
        stopReason: message.stopReason ?? null,
        rawStopReason: message.rawStopReason ?? null,
        errorMessage: message.errorMessage ?? null,
        diagnostics: Array.isArray(message.diagnostics)
          ? message.diagnostics.map((diagnostic) => ({
              type: diagnostic?.type ?? 'unknown',
              error: diagnostic?.error?.message ?? null,
            }))
          : null,
        thinkingLevel: message.thinkingLevel ?? lastThinking,
        textChars: textOf(message).length,
        usage: normalizeUsage(message.usage),
        toolCalls,
      };
      const turn = {
        index: activeRun.turns.length + 1,
        startedAt: ts,
        gapBeforeMs: previousActivityEnd != null ? Math.max(0, ts - previousActivityEnd) : null,
        model: span,
        tools: [],
      };
      for (const call of toolCalls) {
        turn.tools.push({
          kind: 'tool',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          requestedAt: endedAt ?? ts,
          /** Null when the assistant had no durationMs — see the inferred/unknown split. */
          modelDurationMs: durationMs,
          startedAt: null,
          endedAt: null,
          durationMs: null,
          timing: 'pending',
          preToolGapMs: null,
          isError: null,
          argsChars: call.argsChars,
          argsPreview: call.argsPreview,
          resultChars: null,
          resultPreview: null,
          nestedCalls: 0,
          usage: null,
          entryId: null,
        });
      }
      activeRun.turns.push(turn);
      previousActivityEnd = endedAt ?? ts;
      continue;
    }

    if (message.role === 'toolResult') {
      if (ts == null) continue;
      const activeRun = ensureRun(ts);
      const toolCallId = message.toolCallId ?? null;
      let span = null;
      for (let turnIndex = activeRun.turns.length - 1; turnIndex >= 0 && !span; turnIndex--) {
        span =
          activeRun.turns[turnIndex].tools.find((tool) => tool.toolCallId === toolCallId) ?? null;
      }
      const durationMs = numOrNull(message.durationMs);
      if (!span) {
        // A result without a recorded call (older sessions, tools run outside
        // a model turn). Keep it rather than dropping the evidence.
        const turn = activeRun.turns[activeRun.turns.length - 1];
        span = {
          kind: 'tool',
          toolCallId,
          toolName: message.toolName ?? 'unknown',
          requestedAt: null,
          startedAt: null,
          endedAt: ts,
          durationMs,
          timing: durationMs != null ? 'exact' : 'unknown',
          preToolGapMs: null,
          isError: null,
          argsChars: 0,
          argsPreview: null,
          resultChars: null,
          resultPreview: null,
          nestedCalls: 0,
          usage: null,
          entryId: null,
        };
        if (durationMs != null) span.startedAt = ts - durationMs;
        if (turn) turn.tools.push(span);
        else orphanToolResults.push(span);
      }
      span.entryId = entry.id;
      span.endedAt = ts;
      span.isError = Boolean(message.isError);
      span.resultChars = contentChars(message.content);
      span.resultPreview = preview(textOf(message), 160) || null;
      span.nestedCalls = Array.isArray(message.nestedCalls?.calls)
        ? message.nestedCalls.calls.length
        : 0;
      span.usage = normalizeUsage(message.usage);
      if (durationMs != null) {
        span.durationMs = durationMs;
        span.timing = 'exact';
        span.startedAt = ts - durationMs;
        span.preToolGapMs =
          span.requestedAt != null ? Math.max(0, span.startedAt - span.requestedAt) : null;
      } else if (span.requestedAt != null && span.modelDurationMs != null) {
        // The model's generation time is known, so the gap between its end and
        // the result is (mostly) tool execution. Without that anchor the delta
        // would also contain generation time and must not be called a duration.
        span.durationMs = Math.max(0, ts - span.requestedAt);
        span.timing = 'inferred';
        span.preToolGapMs = null;
      } else {
        span.durationMs = null;
        span.timing = 'unknown';
        span.preToolGapMs = null;
      }
      previousActivityEnd = Math.max(previousActivityEnd ?? ts, ts);
      continue;
    }
  }

  if (run) run.endedAt = run.endedAt ?? previousActivityEnd;

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      kind: 'session',
      file: opts.file != null ? resolve(opts.file) : null,
      sessionId: header.id ?? null,
      cwd: header.cwd ?? null,
      version: header.version ?? null,
      createdAt: header.timestamp ?? null,
      entries: parsed.entries.length,
      activePathEntries: path.length,
      branchEntriesSkipped: Math.max(0, parsed.entries.length - path.length),
      noiseLines: parsed.noise,
      legacyEntries: parsed.legacy,
    },
    events,
    runs,
    orphanToolResults,
    summary: null,
    diagnostics: [],
  };
  report.summary = summarize(report);
  report.diagnostics = diagnose(report);
  return report;
}

function sessionEnd(report) {
  let end = null;
  for (const run of report.runs) {
    if (run.endedAt != null) end = Math.max(end ?? -Infinity, run.endedAt);
    for (const turn of run.turns) {
      const model = turn.model;
      if (model.startedAt != null)
        end = Math.max(end ?? -Infinity, model.endedAt ?? model.startedAt);
      for (const tool of turn.tools) {
        if (tool.endedAt != null) end = Math.max(end ?? -Infinity, tool.endedAt);
        else if (tool.startedAt != null) end = Math.max(end ?? -Infinity, tool.startedAt);
      }
    }
  }
  return end;
}

function summarize(report) {
  const tools = new Map();
  const errors = {
    model: 0,
    aborted: 0,
    truncated: 0,
    tool: 0,
    byTool: {},
    details: [],
  };
  let assistantCount = 0;
  let modelExact = 0;
  let modelMs = 0;
  let toolCount = 0;
  let toolExact = 0;
  let toolMs = 0;
  let unpriced = 0;
  let billed = 0;
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let turnCount = 0;

  for (const run of report.runs) {
    for (const turn of run.turns) {
      turnCount++;
      const model = turn.model;
      assistantCount++;
      if (model.durationMs != null) {
        modelMs += model.durationMs;
        modelExact++;
      }
      const usage = model.usage;
      if (usage) {
        input += usage.input;
        output += usage.output;
        cacheRead += usage.cacheRead;
        cacheWrite += usage.cacheWrite;
        totalTokens += usage.totalTokens;
        cost += usage.cost;
        if (usage.billed || usage.cost > 0) billed++;
        else unpriced++;
      }
      if (model.stopReason === 'error') {
        errors.model++;
        errors.details.push({
          kind: 'model',
          toolName: model.model,
          entryId: model.entryId,
          message: model.errorMessage ?? 'model request failed',
          diagnostics: model.diagnostics,
        });
      } else if (model.stopReason === 'aborted') {
        errors.aborted++;
      } else if (model.stopReason === 'length' || model.stopReason === 'max_tokens') {
        errors.truncated++;
        errors.details.push({
          kind: 'truncated',
          toolName: model.model,
          entryId: model.entryId,
          message: 'output hit the token limit',
        });
      }

      for (const tool of turn.tools) {
        toolCount++;
        if (tool.durationMs != null) toolMs += tool.durationMs;
        if (tool.timing === 'exact') toolExact++;
        const stat = tools.get(tool.toolName) ?? {
          name: tool.toolName,
          calls: 0,
          errors: 0,
          totalMs: 0,
          maxMs: 0,
          timed: 0,
          exact: 0,
        };
        stat.calls++;
        if (tool.durationMs != null) {
          stat.totalMs += tool.durationMs;
          stat.maxMs = Math.max(stat.maxMs, tool.durationMs);
          stat.timed++;
        }
        if (tool.timing === 'exact') stat.exact++;
        if (tool.isError) {
          stat.errors++;
          errors.tool++;
          errors.byTool[tool.toolName] = (errors.byTool[tool.toolName] ?? 0) + 1;
          errors.details.push({
            kind: 'tool',
            toolName: tool.toolName,
            entryId: tool.entryId,
            message: tool.resultPreview ?? 'tool returned an error',
          });
        }
        tools.set(tool.toolName, stat);
      }
    }
  }

  const start = report.runs.find((run) => run.startedAt != null)?.startedAt ?? null;
  const end = sessionEnd(report);
  const wallMs = start != null && end != null ? Math.max(0, end - start) : null;
  const idleMs = wallMs != null ? Math.max(0, wallMs - modelMs - toolMs) : null;
  const promptTokens = input + cacheRead + cacheWrite;

  return {
    runs: report.runs.length,
    turns: turnCount,
    toolCalls: toolCount,
    wallMs,
    timing: {
      modelMs,
      toolMs,
      idleMs,
      assistantCount,
      modelExact,
      toolCount,
      toolExact,
      modelCoverage: assistantCount ? modelExact / assistantCount : null,
      toolCoverage: toolCount ? toolExact / toolCount : null,
    },
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      totalTokens,
      cacheHitRate: promptTokens ? cacheRead / promptTokens : null,
      cost,
      billed,
      unpriced,
    },
    errors,
    tools: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls),
    events: {
      modelChanges: report.events.modelChanges.length,
      modelChangesDuringRun: report.events.modelChanges.filter((event) => event.duringRun).length,
      thinkingChanges: report.events.thinkingLevelChanges.length,
      compactions: report.events.compactions.length,
      contextEdits: report.events.contextEdits,
      custom: report.events.custom.length,
    },
  };
}

function diagnose(report) {
  const diagnostics = [];
  const summary = report.summary;
  const push = (level, code, message) => diagnostics.push({ level, code, message });

  if (
    summary.timing.assistantCount > 0 &&
    summary.timing.modelExact < summary.timing.assistantCount
  ) {
    const missing = summary.timing.assistantCount - summary.timing.modelExact;
    push(
      'info',
      'model-timing-missing',
      `${missing}/${summary.timing.assistantCount} assistant messages have no durationMs — generation time falls back or stays unknown`,
    );
  }
  if (summary.timing.toolCount > 0 && summary.timing.toolExact < summary.timing.toolCount) {
    const missing = summary.timing.toolCount - summary.timing.toolExact;
    push(
      'info',
      'tool-timing-missing',
      `${missing}/${summary.timing.toolCount} tool calls have no durationMs — spans are inferred from message timing, or unknown when generation time is also missing`,
    );
  }
  if (summary.tokens.unpriced > 0) {
    push(
      'warn',
      'unpriced-usage',
      `${summary.tokens.unpriced} assistant messages report cost.total = 0 (totalFromProvider = false) — dollar figures are incomplete`,
    );
  }
  if (summary.errors.model > 0) {
    push(
      'warn',
      'model-errors',
      `${summary.errors.model} assistant turn(s) ended with stopReason=error`,
    );
  }
  let longestFailureStreak = 0;
  for (const run of report.runs) {
    let streak = 0;
    for (const turn of run.turns) {
      streak = turn.model.stopReason === 'error' ? streak + 1 : 0;
      longestFailureStreak = Math.max(longestFailureStreak, streak);
    }
  }
  if (longestFailureStreak >= 2) {
    push(
      'warn',
      'model-retry-storm',
      `${longestFailureStreak} consecutive failed model turns in one run — the SDK retried without a new user message`,
    );
  }
  if (summary.errors.truncated > 0) {
    push(
      'warn',
      'truncated-output',
      `${summary.errors.truncated} assistant turn(s) hit the output token limit`,
    );
  }
  if (summary.errors.tool > 0) {
    const byTool = Object.entries(summary.errors.byTool)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ');
    push('warn', 'tool-errors', `${summary.errors.tool} tool error(s): ${byTool}`);
  }
  if (summary.events.compactions > 0) {
    push(
      'info',
      'compactions',
      `${summary.events.compactions} compaction entr(ies) on the active path`,
    );
  }
  if (summary.events.modelChangesDuringRun > 0) {
    push(
      'info',
      'model-changes',
      `${summary.events.modelChangesDuringRun} model change(s) while the run was in progress`,
    );
  }

  // A tool that starts long after the model requested it is often a
  // permission prompt or host scheduling, not the tool itself.
  const gaps = [];
  for (const run of report.runs) {
    for (const turn of run.turns) {
      for (const tool of turn.tools) {
        if (tool.preToolGapMs != null && tool.preToolGapMs >= 2_000) {
          gaps.push({ tool, gap: tool.preToolGapMs });
        }
      }
    }
  }
  if (gaps.length > 0) {
    const worst = gaps.sort((a, b) => b.gap - a.gap)[0];
    push(
      'warn',
      'pre-tool-gap',
      `${gaps.length} tool call(s) waited ≥2s between model end and execution; worst ${fmtMs(worst.gap)} on ${worst.tool.toolName} — likely permission wait or queueing`,
    );
  }

  // Same tool fails then succeeds in one run: the model retried it.
  const retries = new Set();
  for (const run of report.runs) {
    const failed = new Set();
    for (const turn of run.turns) {
      for (const tool of turn.tools) {
        if (tool.isError) failed.add(tool.toolName);
        else if (failed.has(tool.toolName)) retries.add(tool.toolName);
      }
    }
  }
  if (retries.size > 0) {
    push('info', 'tool-retried', `tool retried after an error: ${[...retries].join(', ')}`);
  }

  // Model error then a later successful turn inside the same run: the SDK
  // retried (or the user resent) without a new user message.
  let recovered = 0;
  for (const run of report.runs) {
    let sawError = false;
    for (const turn of run.turns) {
      if (turn.model.stopReason === 'error') sawError = true;
      else if (sawError) {
        recovered++;
        sawError = false;
      }
    }
  }
  if (recovered > 0) {
    push('info', 'model-recovered', `${recovered} run(s) recovered after a failed model turn`);
  }

  if (report.source.branchEntriesSkipped > 0) {
    push(
      'info',
      'branches-skipped',
      `${report.source.branchEntriesSkipped} entr(ies) are off the active leaf path (use --branches to include)`,
    );
  }
  return diagnostics;
}

// ── Human report ─────────────────────────────────────────────────────────

export function collectSpans(report) {
  const spans = [];
  for (const run of report.runs) {
    for (const turn of run.turns) {
      const model = turn.model;
      if (model.durationMs != null) {
        spans.push({
          kind: 'model',
          name: model.model ?? model.provider ?? 'model',
          startedAt: model.startedAt,
          durationMs: model.durationMs,
          timing: 'exact',
          status: model.stopReason ?? '—',
        });
      }
      for (const tool of turn.tools) {
        if (tool.durationMs == null) continue;
        spans.push({
          kind: 'tool',
          name: tool.toolName,
          startedAt: tool.startedAt,
          durationMs: tool.durationMs,
          timing: tool.timing,
          status: tool.isError ? 'error' : 'ok',
        });
      }
    }
  }
  return spans.sort((a, b) => b.durationMs - a.durationMs);
}


export function analyzeSessionText(text, opts = {}) {
  return analyzeParsed(parseSessionText(text), opts);
}

export function analyzeSessionFile(file, opts = {}) {
  return analyzeSessionText(readFileSync(file, 'utf8'), { ...opts, file });
}
