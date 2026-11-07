'use strict';

/**
 * Diagnostics panel.
 *
 * Everything rendered here comes from the session journal through the backend
 * (`trace.report`). The page never touches the filesystem itself — panels do
 * not have host capabilities, and a session-scoped panel's backend only reads
 * the session the host bound it to.
 *
 * Text from the session (prompts, tool args, errors) is always inserted with
 * textContent, never innerHTML: a session is user-controlled data.
 */

const REFRESH_MS = 3000;

const byId = (id) => document.getElementById(id);
const state = { report: null, inflight: false, timer: null };

// ── Formatting ───────────────────────────────────────────────────────────

function fmtMs(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 60000) return `${(value / 60000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function fmtNum(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function fmtPct(ratio) {
  return ratio == null || !Number.isFinite(ratio) ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

function fmtCost(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(4)}`;
}

function fmtClock(ts) {
  if (ts == null) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtOffset(ts, base) {
  if (ts == null) return '—';
  if (base == null) return fmtClock(ts);
  return `+${fmtMs(Math.max(0, ts - base))}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function cell(text, className) {
  const td = el('td', className, text);
  return td;
}

// ── Transport ────────────────────────────────────────────────────────────

function setStatus(message, kind) {
  const node = byId('status');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    node.className = 'status';
    return;
  }
  node.hidden = false;
  node.textContent = message;
  node.className = `status${kind === 'error' ? ' error' : ''}`;
}

async function refresh() {
  if (state.inflight) return;
  state.inflight = true;
  if (!state.report) setStatus('正在读取会话…');
  try {
    const result = await window.piSDK.request('trace.report');
    if (!result || result.ok === false) {
      setStatus(result?.message ?? '读取失败', 'error');
      return;
    }
    state.report = result.report;
    setStatus('');
    render(result.report);
  } catch (error) {
    setStatus(`读取会话失败：${error?.message ?? error}`, 'error');
  } finally {
    state.inflight = false;
  }
}

// ── Render: header + cards ───────────────────────────────────────────────

function renderMeta(report) {
  const source = report.source ?? {};
  const id = source.sessionId ?? source.file ?? '未知会话';
  const meta = byId('meta');
  meta.textContent = '';
  const short = el('span', 'mono', String(id).slice(0, 8));
  short.title = String(id);
  meta.append(short, document.createTextNode(` · ${source.cwd ?? '未知工作区'}`));
  if (source.activePathEntries != null) {
    meta.append(document.createTextNode(` · ${report.summary?.turns ?? 0} 轮`));
  }
}

function card(label, value, sub, title) {
  const node = el('div', 'card');
  node.append(el('div', 'label', label), el('div', 'value', value));
  if (sub) node.append(el('div', 'sub', sub));
  if (title) node.title = title;
  return node;
}

function renderSummary(report) {
  const summary = report.summary;
  const timing = summary.timing;
  const tokens = summary.tokens;
  const errors = summary.errors;
  const events = summary.events;
  const wrap = byId('summary');
  wrap.textContent = '';

  wrap.append(
    card('墙钟', fmtMs(summary.wallMs), `${summary.runs} 次运行 · ${summary.turns} 轮`),
    card(
      '模型生成',
      fmtMs(timing.modelMs),
      `覆盖率 ${fmtPct(timing.modelCoverage)} · ${timing.assistantCount} 次调用`,
      'durationMs 来自 SDK 的单调时钟',
    ),
    card(
      '工具执行',
      fmtMs(timing.toolMs),
      `精确 ${timing.toolExact}/${timing.toolCount} · 其余为推导值`,
    ),
    card(
      'Tokens',
      `${fmtNum(tokens.input)} / ${fmtNum(tokens.output)}`,
      `缓存读 ${fmtNum(tokens.cacheRead)} · 命中 ${fmtPct(tokens.cacheHitRate)}`,
      '输入 / 输出；缓存读单独统计',
    ),
    card(
      '错误',
      `${errors.model} 模型 · ${errors.tool} 工具`,
      `${errors.aborted} 取消 · ${errors.truncated} 截断`,
    ),
    card(
      '事件',
      `${events.compactions} 压缩 · ${events.modelChangesDuringRun} 模型切换`,
      `${events.thinkingChanges} 思考等级 · ${events.contextEdits} 上下文编辑`,
    ),
  );

  if (tokens.unpriced) {
    const sub = el('div', 'sub bad', `${tokens.unpriced} 条消息未定价（cost.total=0）`);
    wrap.querySelectorAll('.card')[3]?.append(sub);
  }
}

// ── Render: diagnostics ──────────────────────────────────────────────────

function renderDiagnostics(report) {
  const list = report.diagnostics ?? [];
  const section = byId('diagnostics');
  const wrap = byId('diagnostic-list');
  wrap.textContent = '';
  section.hidden = list.length === 0;
  for (const item of list) {
    const li = el('li', item.level === 'warn' ? 'warn' : 'info');
    li.append(el('code', null, item.code), document.createTextNode(` ${item.message}`));
    wrap.append(li);
  }
}

// ── Render: runs / turns ────────────────────────────────────────────────

function turnNotes(turn) {
  const notes = [];
  const model = turn.model ?? {};
  if (model.stopReason === 'error') notes.push('模型错误');
  if (model.stopReason === 'aborted') notes.push('已取消');
  if (model.stopReason === 'length' || model.stopReason === 'max_tokens') notes.push('被截断');
  if (Array.isArray(model.diagnostics) && model.diagnostics.length) {
    notes.push(`${model.diagnostics.length} 条诊断`);
  }
  const tools = turn.tools ?? [];
  if (tools.length > 1) notes.push(`并行 ${tools.length}`);
  const toolErrors = tools.filter((tool) => tool.isError).length;
  if (toolErrors) notes.push(`${toolErrors} 个工具错误`);
  const inferred = tools.filter((tool) => tool.timing === 'inferred').length;
  if (inferred) notes.push(`${inferred} 个耗时推导`);
  return notes.join(' · ');
}

function toolChip(tool) {
  const chip = el('span', `chip${tool.isError ? ' error' : ''}`);
  chip.append(el('span', null, tool.toolName ?? 'unknown'));
  if (tool.durationMs != null) {
    chip.append(document.createTextNode(' '), el('span', 'dur', fmtMs(tool.durationMs)));
  }
  const details = [];
  if (tool.argsPreview) details.push(`参数: ${tool.argsPreview}`);
  if (tool.resultPreview) details.push(`结果: ${tool.resultPreview}`);
  if (tool.preToolGapMs != null && tool.preToolGapMs >= 2000) {
    details.push(`执行前等待: ${fmtMs(tool.preToolGapMs)}（审批/排队）`);
  }
  if (tool.timing) details.push(`耗时来源: ${tool.timing}`);
  chip.title = details.join('\n') || tool.toolName;
  return chip;
}

function renderRuns(report) {
  const section = byId('timeline');
  const wrap = byId('runs');
  wrap.textContent = '';
  const runs = report.runs ?? [];
  const base = runs[0]?.startedAt ?? null;
  if (runs.length === 0) {
    section.hidden = false;
    wrap.append(el('div', 'empty', '这个会话还没有运行记录'));
    return;
  }
  section.hidden = false;

  for (const run of runs) {
    const node = el('div', 'run');
    const head = el('div', 'run-head');
    head.append(
      el('span', 'run-index', `#${run.index}`),
      el('span', 'run-preview', run.preview || '（无用户消息）'),
      el(
        'span',
        'run-time',
        `${fmtOffset(run.startedAt, base)} · ${fmtMs(
          run.endedAt != null && run.startedAt != null ? run.endedAt - run.startedAt : null,
        )}`,
      ),
    );
    node.append(head);

    const table = el('table');
    const thead = el('thead');
    const header = el('tr');
    for (const label of ['#', '开始', '生成', '工具', 'tokens in/out/cache', '停止', '备注']) {
      header.append(el('th', null, label));
    }
    thead.append(header);
    table.append(thead);

    const tbody = el('tbody');
    for (const turn of run.turns ?? []) {
      const model = turn.model ?? {};
      const usage = model.usage;
      const toolMs = (turn.tools ?? []).reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
      const rows = el('tr');
      rows.append(
        cell(`#${turn.index}`, 'num'),
        cell(fmtOffset(turn.startedAt, base), 'num muted'),
        cell(fmtMs(model.durationMs), 'num'),
        cell(turn.tools?.length ? fmtMs(toolMs) : '—', 'num'),
        cell(
          usage
            ? `${fmtNum(usage.input)}/${fmtNum(usage.output)}/${fmtNum(usage.cacheRead)}`
            : '—',
          'num',
        ),
        cell(model.stopReason ?? '—', model.stopReason === 'error' ? 'bad' : 'muted'),
        cell(turnNotes(turn), 'muted'),
      );
      tbody.append(rows);

      if (turn.tools?.length) {
        const chipRow = el('tr');
        const td = el('td');
        td.colSpan = 7;
        const chips = el('div', 'chips');
        for (const tool of turn.tools) chips.append(toolChip(tool));
        td.append(chips);
        chipRow.append(td);
        tbody.append(chipRow);
      }
    }
    table.append(tbody);
    node.append(table);
    wrap.append(node);
  }
}

// ── Render: tool + span tables ──────────────────────────────────────────

function renderTable(headers, rows) {
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of headers) headRow.append(el('th', null, label));
  thead.append(headRow);
  table.append(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const value of row) tr.append(cell(value.text ?? value, value.className));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function renderTools(report) {
  const tools = report.summary.tools ?? [];
  const section = byId('tools');
  const wrap = byId('tool-table');
  wrap.textContent = '';
  section.hidden = tools.length === 0;
  if (tools.length === 0) return;
  wrap.append(
    renderTable(
      ['工具', '调用', '错误', '总耗时', '最大', '平均', '精确/调用'],
      tools.map((tool) => [
        { text: tool.name },
        { text: String(tool.calls) },
        { text: String(tool.errors), className: tool.errors ? 'bad' : '' },
        { text: tool.timed ? fmtMs(tool.totalMs) : '—' },
        { text: tool.timed ? fmtMs(tool.maxMs) : '—' },
        { text: tool.timed ? fmtMs(tool.totalMs / tool.timed) : '—' },
        { text: `${tool.exact}/${tool.calls}` },
      ]),
    ),
  );
}

function collectSpans(report) {
  const spans = [];
  for (const run of report.runs ?? []) {
    for (const turn of run.turns ?? []) {
      const model = turn.model ?? {};
      if (model.durationMs != null) {
        spans.push({
          kind: 'model',
          name: model.model ?? model.provider ?? 'model',
          durationMs: model.durationMs,
          timing: 'exact',
          status: model.stopReason ?? '—',
        });
      }
      for (const tool of turn.tools ?? []) {
        if (tool.durationMs == null) continue;
        spans.push({
          kind: 'tool',
          name: tool.toolName ?? 'tool',
          durationMs: tool.durationMs,
          timing: tool.timing ?? '—',
          status: tool.isError ? 'error' : 'ok',
        });
      }
    }
  }
  return spans.sort((a, b) => b.durationMs - a.durationMs);
}

function renderSlowest(report) {
  const spans = collectSpans(report).slice(0, 10);
  const section = byId('slowest');
  const wrap = byId('slowest-table');
  wrap.textContent = '';
  section.hidden = spans.length === 0;
  if (spans.length === 0) return;
  wrap.append(
    renderTable(
      ['类型', '名称', '耗时', '来源', '状态'],
      spans.map((span) => [
        { text: span.kind },
        { text: span.name },
        { text: fmtMs(span.durationMs) },
        { text: span.timing },
        { text: span.status, className: span.status === 'error' ? 'bad' : '' },
      ]),
    ),
  );
}

function render(report) {
  renderMeta(report);
  renderSummary(report);
  renderDiagnostics(report);
  renderRuns(report);
  renderTools(report);
  renderSlowest(report);
}

// ── Actions ──────────────────────────────────────────────────────────────

function setLive(on) {
  byId('live').classList.toggle('off', !on);
}

function exportReport() {
  if (!state.report) return;
  const id = String(state.report.source?.sessionId ?? 'session').slice(0, 8);
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `diagnostics-${id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

byId('refresh').addEventListener('click', () => refresh());
byId('export').addEventListener('click', exportReport);

document.addEventListener('visibilitychange', () => {
  const visible = !document.hidden;
  setLive(visible);
  if (visible) refresh();
});

setLive(!document.hidden);
refresh();
state.timer = window.setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);
