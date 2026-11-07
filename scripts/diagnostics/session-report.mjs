#!/usr/bin/env node
/**
 * Read-only diagnostics for pi sessions — P0 of the trajectory work.
 *
 * Why this exists before any runtime instrumentation: the session JSONL already
 * holds most of what a "why was this run slow / expensive / broken" question
 * needs — request start time, generation duration, tool duration, token and
 * cache usage, stop reasons, model/thinking changes, compactions. This script
 * reads that journal and prints runs → turns → spans, so we can see which
 * fields are actually populated before adding a live recorder.
 *
 * It never writes to the session directory and never talks to the app.
 *
 * Usage:
 *   node scripts/diagnostics/session-report.mjs                    # latest session
 *   node scripts/diagnostics/session-report.mjs --all              # aggregate (50 newest)
 *   node scripts/diagnostics/session-report.mjs --all --limit 500 --since 2026-11-01
 *   node scripts/diagnostics/session-report.mjs --session 01a1b570
 *   node scripts/diagnostics/session-report.mjs --session <file> --json trace.json
 *
 * Options:
 *   --dir <path>      sessions root (default ~/.pi/agent/sessions)
 *   --session <s>     session file path, or a unique substring of its file name
 *   --all             aggregate many sessions instead of one
 *   --limit <n>       max sessions in --all mode (default 50)
 *   --since <date>    only files modified on/after YYYY-MM-DD
 *   --top <n>         rows in "slowest spans" and aggregate tables (default 10)
 *   --branches        analyze every entry, not just the active leaf path
 *   --json <path>     also write the structured report ('-' = stdout)
 *   --quiet           suppress the human report
 *   --help            this text
 *
 * Timing notes:
 *   - assistant.durationMs is an exact generation duration when present
 *     (SDK >= the Nov 2026 build). Older sessions lack it entirely.
 *   - toolResult.durationMs is exact; when absent the span is inferred from
 *     (assistant end → toolResult timestamp), which also includes any
 *     permission wait and scheduler delay.
 *   - message_update / tool_execution_update lines (found in a few old trace
 *     dumps) are streaming noise, not journal entries, and are ignored.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  SCHEMA_VERSION,
  analyzeSessionFile as analyzeSession,
  collectSpans,
  fmtMs,
  preview,
} from './analyze.mjs';

// ── CLI ───────────────────────────────────────────────────────────────────

const HELP = `Read-only pi session diagnostics.

Usage:
  node scripts/diagnostics/session-report.mjs                    latest session
  node scripts/diagnostics/session-report.mjs --all              aggregate 50 newest
  node scripts/diagnostics/session-report.mjs --session <id>     one session by name fragment
  node scripts/diagnostics/session-report.mjs --all --limit 500 --since 2026-11-01

Options:
  --dir <path>      sessions root (default ~/.pi/agent/sessions)
  --session <s>     session file path, or a unique substring of its file name
  --all             aggregate many sessions instead of one
  --limit <n>       max sessions in --all mode (default 50)
  --since <date>    only files modified on/after YYYY-MM-DD
  --top <n>         rows in slowest/aggregate tables (default 10)
  --branches        analyze every entry, not just the active leaf path
  --json <path>     write the structured report ('-' = stdout)
  --quiet           suppress the human report
  --help            this text
`;

function parseArgs(argv) {
  const opts = {
    dir: null,
    session: null,
    all: false,
    limit: 50,
    since: null,
    top: 10,
    branches: false,
    json: null,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dir':
        opts.dir = argv[++i] ?? null;
        break;
      case '--session':
        opts.session = argv[++i] ?? null;
        break;
      case '--all':
        opts.all = true;
        break;
      case '--limit':
        opts.limit = Number(argv[++i]);
        break;
      case '--since':
        opts.since = argv[++i] ?? null;
        break;
      case '--top':
        opts.top = Number(argv[++i]);
        break;
      case '--branches':
        opts.branches = true;
        break;
      case '--json': {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts.json = next;
          i++;
        } else {
          opts.json = '-';
        }
        break;
      }
      case '--quiet':
        opts.quiet = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg} (try --help)`);
    }
  }
  if (!Number.isFinite(opts.limit) || opts.limit < 1) opts.limit = 50;
  if (!Number.isFinite(opts.top) || opts.top < 1) opts.top = 10;
  return opts;
}

// ── Discovery ────────────────────────────────────────────────────────────

function defaultSessionsRoot() {
  // PiWork's Settings → Storage can move the agent dir through this env var.
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), '.pi', 'agent');
  return join(agentDir, 'sessions');
}

function walkJsonl(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // `traces/` holds raw SDK event dumps, not sessions.
    if (entry.name === 'traces') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(path, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
  }
}

function listSessionFiles(root, opts) {
  const files = [];
  walkJsonl(root, files);
  const since = opts.since ? Date.parse(opts.since) : null;
  if (opts.since && !Number.isFinite(since)) {
    throw new Error(`--since is not a date: ${opts.since}`);
  }
  return files
    .map((file) => {
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        // Deleted between listing and stat: skip it.
      }
      return { file, mtime };
    })
    .filter((f) => f.mtime > 0 && (since == null || f.mtime >= since))
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.file);
}

function resolveSession(root, needle) {
  if (existsSync(needle)) {
    const stat = statSync(needle);
    if (stat.isFile()) return resolve(needle);
  }
  const files = [];
  walkJsonl(root, files);
  let matches = files.filter((file) => basename(file).includes(needle));
  if (matches.length === 0) {
    // A resumed/forked session can have a header id that no longer matches its
    // file name (the file was written under an earlier id). Search headers too.
    matches = files.filter((file) => readHeaderLine(file).includes(needle));
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `--session "${needle}" matches ${matches.length} files:\n` +
        matches
          .slice(0, 10)
          .map((m) => `  ${m}`)
          .join('\n'),
    );
  }
  throw new Error(`no session matching "${needle}" under ${root}`);
}

function readHeaderLine(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } catch {
    return '';
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────

function fmtNum(value) {
  if (value == null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtPct(numerator, denominator) {
  if (!denominator) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function fmtRatio(ratio) {
  return ratio == null ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

function fmtCost(value) {
  if (value == null) return '—';
  if (value > 0 && value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(4)}`;
}

function fmtTime(ts, base) {
  if (ts == null) return '—';
  if (base == null) return new Date(ts).toISOString().slice(11, 23);
  return `+${fmtMs(ts - base)}`;
}

function pad(text, width, align = 'left') {
  let value = String(text ?? '');
  if (value.length > width) value = `${value.slice(0, Math.max(1, width - 1))}…`;
  if (value.length >= width) return value;
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

function printTable(columns, rows) {
  const widths = columns.map((column) => {
    const candidates = [column.label, ...rows.map((row) => String(row[column.key] ?? '—'))];
    return Math.min(28, Math.max(...candidates.map((value) => value.length)));
  });
  const line = (cells, padder = ' ') =>
    columns.map((column, index) => pad(cells[index], widths[index], column.align)).join(padder);
  console.log(
    line(
      columns.map((column) => column.label),
      ' ',
    ).trimEnd(),
  );
  console.log(
    line(
      widths.map((width) => '─'.repeat(width)),
      ' ',
    ).trimEnd(),
  );
  for (const row of rows) {
    console.log(line(columns.map((column) => row[column.key] ?? '—')).trimEnd());
  }
}

// ── Analysis ─────────────────────────────────────────────────────────────

function printSessionReport(report, opts) {
  const { source, summary, runs } = report;
  const events = summary.events;
  console.log('');
  console.log('─'.repeat(78));
  console.log(`Session  ${source.sessionId ?? basename(source.file)}`);
  console.log(`File     ${source.file}`);
  console.log(`CWD      ${source.cwd ?? '—'}`);
  console.log(
    `Runs     ${summary.runs} · Turns ${summary.turns} · Tool calls ${summary.toolCalls} · Wall ${fmtMs(summary.wallMs)}`,
  );
  console.log(
    `Time     model ${fmtMs(summary.timing.modelMs)} (${fmtPct(summary.timing.modelExact, summary.timing.assistantCount)} exact) · tools ${fmtMs(summary.timing.toolMs)} (${fmtPct(summary.timing.toolExact, summary.timing.toolCount)} exact) · other ${fmtMs(summary.timing.idleMs)}`,
  );
  const tokens = summary.tokens;
  console.log(
    `Tokens   in ${fmtNum(tokens.input)} · out ${fmtNum(tokens.output)} · cache-read ${fmtNum(tokens.cacheRead)} (${tokens.cacheHitRate == null ? '—' : `${(tokens.cacheHitRate * 100).toFixed(1)}%`} hit) · ${fmtCost(tokens.cost)}${tokens.unpriced ? ` (${tokens.unpriced} unpriced)` : ''}`,
  );
  console.log(
    `Events   ${events.modelChanges} model changes · ${events.compactions} compactions · ${events.thinkingChanges} thinking changes · ${events.contextEdits} context edits`,
  );

  if (runs.length > 0) {
    console.log('\nRuns and turns');
    const rows = [];
    const base = runs[0]?.startedAt ?? null;
    for (const run of runs) {
      for (const turn of run.turns) {
        const model = turn.model;
        const toolMs = turn.tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
        const usage = model.usage;
        const notes = [];
        if (model.stopReason === 'error') notes.push('MODEL ERROR');
        if (model.stopReason === 'aborted') notes.push('aborted');
        if (model.stopReason === 'length' || model.stopReason === 'max_tokens')
          notes.push('TRUNCATED');
        if (turn.tools.length > 1) notes.push(`${turn.tools.length} tools parallel`);
        const toolErrors = turn.tools.filter((tool) => tool.isError).length;
        if (toolErrors) notes.push(`${toolErrors} tool error`);
        rows.push({
          run: run.index,
          turn: turn.index,
          start: fmtTime(turn.startedAt, base),
          gap: fmtMs(turn.gapBeforeMs),
          gen: fmtMs(model.durationMs),
          tools: turn.tools.length ? fmtMs(toolMs) : '—',
          tokens: usage
            ? `${fmtNum(usage.input)}/${fmtNum(usage.output)}/${fmtNum(usage.cacheRead)}`
            : '—',
          stop: model.stopReason ?? '—',
          note: notes.join(', ') || '',
        });
      }
    }
    printTable(
      [
        { key: 'run', label: 'run', align: 'right' },
        { key: 'turn', label: 'turn', align: 'right' },
        { key: 'start', label: 'start', align: 'right' },
        { key: 'gap', label: 'gap', align: 'right' },
        { key: 'gen', label: 'gen', align: 'right' },
        { key: 'tools', label: 'tools', align: 'right' },
        { key: 'tokens', label: 'tok in/out/cR', align: 'right' },
        { key: 'stop', label: 'stop' },
        { key: 'note', label: 'note' },
      ],
      rows,
    );
  }

  if (summary.tools.length > 0) {
    console.log('\nTools');
    const rows = summary.tools.map((tool) => ({
      tool: tool.name,
      calls: tool.calls,
      err: tool.errors,
      total: tool.timed ? fmtMs(tool.totalMs) : '—',
      max: tool.timed ? fmtMs(tool.maxMs) : '—',
      avg: fmtMs(tool.timed ? tool.totalMs / tool.timed : null),
      exact: `${tool.exact}/${tool.calls}`,
    }));
    printTable(
      [
        { key: 'tool', label: 'tool' },
        { key: 'calls', label: 'calls', align: 'right' },
        { key: 'err', label: 'err', align: 'right' },
        { key: 'total', label: 'total', align: 'right' },
        { key: 'max', label: 'max', align: 'right' },
        { key: 'avg', label: 'avg', align: 'right' },
        { key: 'exact', label: 'exact', align: 'right' },
      ],
      rows,
    );
  }

  const spans = collectSpans(report).slice(0, opts.top);
  if (spans.length > 0) {
    console.log(`\nSlowest spans (top ${opts.top})`);
    const rows = spans.map((span) => ({
      kind: span.kind,
      name: span.name,
      start: fmtTime(span.startedAt, runs[0]?.startedAt ?? null),
      dur: fmtMs(span.durationMs),
      timing: span.timing,
      status: span.status,
    }));
    printTable(
      [
        { key: 'kind', label: 'kind' },
        { key: 'name', label: 'name' },
        { key: 'start', label: 'start', align: 'right' },
        { key: 'dur', label: 'dur', align: 'right' },
        { key: 'timing', label: 'timing' },
        { key: 'status', label: 'status' },
      ],
      rows,
    );
  }

  printDiagnostics(report.diagnostics);
}

function printDiagnostics(diagnostics) {
  if (!diagnostics.length) return;
  console.log('\nDiagnostics');
  for (const diagnostic of diagnostics) {
    const marker = diagnostic.level === 'warn' ? '!' : '·';
    console.log(`${marker} [${diagnostic.code}] ${diagnostic.message}`);
  }
  console.log('');
}

// ── Aggregate ────────────────────────────────────────────────────────────

function aggregateReports(reports, skipped) {
  const tools = new Map();
  const models = new Map();
  const months = new Map();
  const sessions = [];
  const slowest = [];
  const errors = [];
  const totals = {
    sessions: reports.length,
    runs: 0,
    turns: 0,
    toolCalls: 0,
    modelMs: 0,
    toolMs: 0,
    modelExact: 0,
    toolExact: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    billed: 0,
    unpriced: 0,
    modelErrors: 0,
    aborted: 0,
    truncated: 0,
    toolErrors: 0,
    compactions: 0,
    modelChanges: 0,
  };

  for (const report of reports) {
    const summary = report.summary;
    totals.runs += summary.runs;
    totals.turns += summary.turns;
    totals.toolCalls += summary.toolCalls;
    totals.modelMs += summary.timing.modelMs;
    totals.toolMs += summary.timing.toolMs;
    totals.modelExact += summary.timing.modelExact;
    totals.toolExact += summary.timing.toolExact;
    totals.input += summary.tokens.input;
    totals.output += summary.tokens.output;
    totals.cacheRead += summary.tokens.cacheRead;
    totals.cacheWrite += summary.tokens.cacheWrite;
    totals.totalTokens += summary.tokens.totalTokens;
    totals.cost += summary.tokens.cost;
    totals.billed += summary.tokens.billed;
    totals.unpriced += summary.tokens.unpriced;
    totals.modelErrors += summary.errors.model;
    totals.aborted += summary.errors.aborted;
    totals.truncated += summary.errors.truncated;
    totals.toolErrors += summary.errors.tool;
    totals.compactions += summary.events.compactions;
    totals.modelChanges += summary.events.modelChangesDuringRun;

    for (const tool of summary.tools) {
      const stat = tools.get(tool.name) ?? {
        name: tool.name,
        calls: 0,
        errors: 0,
        totalMs: 0,
        maxMs: 0,
        timed: 0,
        exact: 0,
      };
      stat.calls += tool.calls;
      stat.errors += tool.errors;
      stat.totalMs += tool.totalMs;
      stat.maxMs = Math.max(stat.maxMs, tool.maxMs);
      stat.timed += tool.timed;
      stat.exact += tool.exact;
      tools.set(tool.name, stat);
    }

    for (const run of report.runs) {
      for (const turn of run.turns) {
        const model = turn.model;
        const key = `${model.provider ?? '?'}/${model.model ?? '?'}`;
        const stat = models.get(key) ?? {
          name: key,
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          errors: 0,
        };
        stat.turns++;
        if (model.usage) {
          stat.input += model.usage.input;
          stat.output += model.usage.output;
          stat.cacheRead += model.usage.cacheRead;
          stat.cacheWrite += model.usage.cacheWrite;
          stat.cost += model.usage.cost;
        }
        if (model.stopReason === 'error') stat.errors++;
        models.set(key, stat);

        const ts = model.startedAt ?? null;
        const month = ts != null ? new Date(ts).toISOString().slice(0, 7) : 'unknown';
        const bucket = months.get(month) ?? {
          month,
          assistants: 0,
          withDuration: 0,
          toolResults: 0,
          toolsWithDuration: 0,
        };
        bucket.assistants++;
        if (model.durationMs != null) bucket.withDuration++;
        bucket.toolResults += turn.tools.length;
        bucket.toolsWithDuration += turn.tools.filter((tool) => tool.durationMs != null).length;
        months.set(month, bucket);
      }
    }

    for (const span of collectSpans(report).slice(0, 10)) {
      slowest.push({ ...span, session: report.source.sessionId, file: report.source.file });
    }

    for (const error of summary.errors.details) {
      errors.push({
        ...error,
        session: report.source.sessionId,
        file: report.source.file,
      });
    }

    const firstTurn = report.runs.find((run) => run.startedAt != null);
    sessions.push({
      file: report.source.file,
      sessionId: report.source.sessionId,
      cwd: report.source.cwd,
      startedAt: firstTurn?.startedAt ?? null,
      runs: summary.runs,
      turns: summary.turns,
      toolCalls: summary.toolCalls,
      wallMs: summary.wallMs,
      tokens: summary.tokens.totalTokens,
      cost: summary.tokens.cost,
      modelErrors: summary.errors.model,
      toolErrors: summary.errors.tool,
      modelCoverage: summary.timing.modelCoverage,
      toolCoverage: summary.timing.toolCoverage,
    });
  }

  slowest.sort((a, b) => b.durationMs - a.durationMs);
  sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'aggregate',
    totals,
    coverageByMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    tools: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls),
    models: [...models.values()].sort((a, b) => b.turns - a.turns),
    slowest: slowest.slice(0, 50),
    errors: errors.slice(0, 100),
    sessions,
    skippedFiles: skipped,
  };
}

function printAggregateReport(aggregate, opts) {
  const { totals } = aggregate;
  console.log('');
  console.log('─'.repeat(78));
  console.log('Aggregate');
  console.log(
    `Sessions ${totals.sessions} · Runs ${totals.runs} · Turns ${totals.turns} · Tool calls ${totals.toolCalls}`,
  );
  console.log(
    `Time     model ${fmtMs(totals.modelMs)} (${fmtPct(totals.modelExact, totals.turns)} of turns exact) · tools ${fmtMs(totals.toolMs)} (${fmtPct(totals.toolExact, totals.toolCalls)} exact)`,
  );
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  console.log(
    `Tokens   in ${fmtNum(totals.input)} · out ${fmtNum(totals.output)} · cache-read ${fmtNum(totals.cacheRead)} (${fmtPct(totals.cacheRead, promptTokens)} hit) · ${fmtCost(totals.cost)}${totals.unpriced ? ` (${totals.unpriced} unpriced)` : ''}`,
  );
  console.log(
    `Errors   ${totals.modelErrors} model · ${totals.aborted} aborted · ${totals.truncated} truncated · ${totals.toolErrors} tool`,
  );
  console.log(
    `Events   ${totals.modelChanges} model changes · ${totals.compactions} compactions${aggregate.skippedFiles ? ` · ${aggregate.skippedFiles} file(s) skipped` : ''}`,
  );

  if (aggregate.coverageByMonth.length > 0) {
    console.log('\nTiming coverage by month');
    printTable(
      [
        { key: 'month', label: 'month' },
        { key: 'assistants', label: 'assistants', align: 'right' },
        { key: 'withDuration', label: 'gen ms', align: 'right' },
        { key: 'toolResults', label: 'tool results', align: 'right' },
        { key: 'toolsWithDuration', label: 'tool ms', align: 'right' },
        { key: 'modelCoverage', label: 'gen %', align: 'right' },
        { key: 'toolCoverage', label: 'tool %', align: 'right' },
      ],
      aggregate.coverageByMonth.map((bucket) => ({
        month: bucket.month,
        assistants: bucket.assistants,
        withDuration: bucket.withDuration,
        toolResults: bucket.toolResults,
        toolsWithDuration: bucket.toolsWithDuration,
        modelCoverage: fmtPct(bucket.withDuration, bucket.assistants),
        toolCoverage: fmtPct(bucket.toolsWithDuration, bucket.toolResults),
      })),
    );
  }

  if (aggregate.tools.length > 0) {
    console.log(`\nTop tools by total time (top ${opts.top})`);
    printTable(
      [
        { key: 'tool', label: 'tool' },
        { key: 'calls', label: 'calls', align: 'right' },
        { key: 'err', label: 'err', align: 'right' },
        { key: 'total', label: 'total', align: 'right' },
        { key: 'max', label: 'max', align: 'right' },
        { key: 'avg', label: 'avg', align: 'right' },
        { key: 'exact', label: 'exact', align: 'right' },
      ],
      aggregate.tools.slice(0, opts.top).map((tool) => ({
        tool: tool.name,
        calls: tool.calls,
        err: tool.errors,
        total: tool.timed ? fmtMs(tool.totalMs) : '—',
        max: tool.timed ? fmtMs(tool.maxMs) : '—',
        avg: fmtMs(tool.timed ? tool.totalMs / tool.timed : null),
        exact: `${tool.exact}/${tool.calls}`,
      })),
    );
  }

  if (aggregate.models.length > 0) {
    console.log('\nModels');
    printTable(
      [
        { key: 'model', label: 'model' },
        { key: 'turns', label: 'turns', align: 'right' },
        { key: 'in', label: 'in', align: 'right' },
        { key: 'out', label: 'out', align: 'right' },
        { key: 'cacheRead', label: 'cacheR', align: 'right' },
        { key: 'cost', label: 'cost', align: 'right' },
        { key: 'errors', label: 'err', align: 'right' },
      ],
      aggregate.models.slice(0, opts.top).map((model) => ({
        model: model.name,
        turns: model.turns,
        in: fmtNum(model.input),
        out: fmtNum(model.output),
        cacheRead: fmtNum(model.cacheRead),
        cost: fmtCost(model.cost),
        errors: model.errors,
      })),
    );
  }

  if (aggregate.slowest.length > 0) {
    console.log(`\nSlowest spans (top ${opts.top})`);
    printTable(
      [
        { key: 'kind', label: 'kind' },
        { key: 'name', label: 'name' },
        { key: 'session', label: 'session' },
        { key: 'dur', label: 'dur', align: 'right' },
        { key: 'timing', label: 'timing' },
        { key: 'status', label: 'status' },
      ],
      aggregate.slowest.slice(0, opts.top).map((span) => ({
        kind: span.kind,
        name: span.name,
        session: String(span.session ?? '').slice(0, 18),
        dur: fmtMs(span.durationMs),
        timing: span.timing,
        status: span.status,
      })),
    );
  }

  if (aggregate.sessions.length > 0) {
    console.log(`\nSessions by tokens (top ${opts.top})`);
    const byTokens = [...aggregate.sessions].sort((a, b) => b.tokens - a.tokens).slice(0, opts.top);
    printTable(
      [
        { key: 'session', label: 'session' },
        { key: 'turns', label: 'turns', align: 'right' },
        { key: 'wall', label: 'wall', align: 'right' },
        { key: 'tokens', label: 'tokens', align: 'right' },
        { key: 'cost', label: 'cost', align: 'right' },
        { key: 'gen', label: 'gen%', align: 'right' },
        { key: 'err', label: 'err', align: 'right' },
      ],
      byTokens.map((session) => ({
        session: String(session.sessionId ?? session.file).slice(0, 18),
        turns: session.turns,
        wall: fmtMs(session.wallMs),
        tokens: fmtNum(session.tokens),
        cost: fmtCost(session.cost),
        gen: fmtRatio(session.modelCoverage),
        err: session.modelErrors + session.toolErrors,
      })),
    );
  }

  if (aggregate.errors.length > 0) {
    console.log(`\nErrors (top ${opts.top})`);
    printTable(
      [
        { key: 'kind', label: 'kind' },
        { key: 'name', label: 'name' },
        { key: 'session', label: 'session' },
        { key: 'message', label: 'message' },
      ],
      aggregate.errors.slice(0, opts.top).map((error) => ({
        kind: error.kind,
        name: error.toolName ?? '—',
        session: String(error.session ?? '').slice(0, 18),
        message: preview(error.message, 60),
      })),
    );
  }

  if (aggregate.skippedFiles > 0) {
    console.log(
      `\n! Skipped ${aggregate.skippedFiles} .jsonl file(s) without a session header (event dumps).`,
    );
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const root = resolve(opts.dir ?? defaultSessionsRoot());
  if (!existsSync(root)) {
    throw new Error(`sessions root not found: ${root}`);
  }

  if (opts.all) {
    const files = listSessionFiles(root, opts).slice(0, opts.limit);
    if (files.length === 0) throw new Error(`no session files under ${root}`);
    const reports = [];
    let skipped = 0;
    for (const file of files) {
      try {
        const report = analyzeSession(file, opts);
        reports.push(report);
      } catch (error) {
        skipped++;
        if (process.env.DIAG_DEBUG) {
          console.error(`[skip] ${file}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    if (reports.length === 0) throw new Error('no readable sessions (all files were event dumps?)');
    const aggregate = aggregateReports(reports, skipped);

    if (opts.json) writeJson(opts.json, aggregate);
    if (!opts.quiet && opts.json !== '-') {
      console.log(`Root     ${root}`);
      printAggregateReport(aggregate, opts);
    }
    return;
  }

  const file = opts.session ? resolveSession(root, opts.session) : listSessionFiles(root, opts)[0];
  if (!file) throw new Error(`no session files under ${root}`);
  const report = analyzeSession(file, opts);

  if (opts.json) writeJson(opts.json, report);
  if (!opts.quiet && opts.json !== '-') {
    console.log(`Root     ${root}`);
    printSessionReport(report, opts);
  }
}

function writeJson(target, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (target === '-') {
    process.stdout.write(text);
    return;
  }
  const file = resolve(target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  console.error(`wrote ${file}`);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
