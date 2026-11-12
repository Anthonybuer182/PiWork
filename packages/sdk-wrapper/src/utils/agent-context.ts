/**
 * Pure formatting for the agent's standing context.
 *
 * Lives here, not in the renderer or in main, because both need it: main
 * renders the `context_audit` report an agent reads, and the host's context
 * panel renders the same numbers for a person. Two copies would drift, and the
 * numbers they produce are exactly the ones a user acts on.
 *
 * Dependency-free by design — the same reason `think-parser` and
 * `file-detection` live in this package.
 */

import type { AgentContextConfig, ContextFileScope, PromptFileInfo } from '@pi/types';

/** Thousands separators. Hand-rolled so output never varies by locale. */
export function formatCount(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return sign + out;
}

/** Compact character count: 834 → "834", 12345 → "12k". */
export function formatChars(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Estimated tokens. The "≈" is not decoration — no API attributes real token
 * cost per prompt section, so every per-section figure is derived from
 * characters and must never be presented as a measurement.
 */
export function formatTokens(n: number): string {
  return `≈${formatChars(n)}`;
}

export function scopeLabel(scope: ContextFileScope): string {
  switch (scope) {
    case 'global':
      return '全局';
    case 'workspace':
      return '工作区';
    default:
      return '上级目录';
  }
}

/**
 * Human wording for what a context-file save did, and when it applies.
 *
 * The `error` case is the one that has to be got right: the file *was* written,
 * and saying "保存失败" would send the user hunting for a problem that does not
 * exist — and probably re-editing a file that is already correct.
 */
export function reloadNote(result: { applied: boolean; reason?: string; message?: string }): string {
  if (result.applied) return '已保存并生效，下一条消息就会带上新内容。';
  if (result.reason === 'busy') return '已保存；正在生成回复，将在下一个新会话生效。';
  if (result.reason === 'no-session') return '已保存；尚未建立会话，将在新会话建立时生效。';
  if (result.reason === 'error') {
    return `文件已保存，但让改动生效时出错了 —— 改动会在新会话建立时生效。\n（${result.message ?? '未知错误'}）`;
  }
  return '已保存，将在下一次建立会话时生效。';
}

/** Every section's character cost, largest first — "who is eating the budget". */
export function budgetRows(config: AgentContextConfig): Array<{ label: string; chars: number }> {
  const { sections } = config;
  return [
    { label: '基础系统提示词', chars: sections.base.chars ?? 0 },
    { label: '追加段', chars: sections.appended.reduce((n, s) => n + s.chars, 0) },
    { label: '上下文文件', chars: sections.contextFiles.reduce((n, f) => n + f.chars, 0) },
    { label: '技能索引', chars: sections.skills.chars },
    { label: '工具定义', chars: sections.tools.reduce((n, t) => n + t.schemaBytes, 0) },
  ]
    .filter((row) => row.chars > 0)
    .sort((a, b) => b.chars - a.chars);
}

/** The denominator for per-section proportion bars. */
export function budgetTotal(config: AgentContextConfig): number {
  return budgetRows(config).reduce((n, row) => n + row.chars, 0);
}

// ── prompt files (SYSTEM.md / APPEND_SYSTEM.md) ──

/**
 * What a prompt file is currently doing.
 *
 * `shadowed` is the state worth being loud about: the file is on disk, reads
 * fine, and has no effect, because a file of the same kind in the other scope
 * wins. Without this the panel would show an edited file that silently does
 * nothing.
 */
export type PromptFileStatus = 'active' | 'shadowed' | 'missing';

export function promptFileStatus(file: Pick<PromptFileInfo, 'exists' | 'active'>): PromptFileStatus {
  if (file.active) return 'active';
  return file.exists ? 'shadowed' : 'missing';
}

export function promptStatusLabel(status: PromptFileStatus): string {
  switch (status) {
    case 'active':
      return '生效中';
    case 'shadowed':
      return '被遮住';
    default:
      return '未创建';
  }
}

/**
 * Prompt files grouped by kind, project row before global, each kind's pair
 * intact so a shadowed file is visible next to the file shadowing it.
 */
export function promptFileGroups(
  files: PromptFileInfo[],
): Array<{ kind: PromptFileInfo['kind']; files: PromptFileInfo[] }> {
  const kinds: Array<PromptFileInfo['kind']> = ['system', 'append'];
  return kinds.map((kind) => ({
    kind,
    files: files
      .filter((f) => f.kind === kind)
      .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1)),
  }));
}

// ── the agent-facing report ──

/**
 * The plain-text standing-context report handed to the agent by
 * `context_audit`.
 *
 * Written for a model to read: absolute numbers first, every token figure
 * explicitly marked as an estimate so it is never relayed to the user as a
 * measured value, and paths given in full because the agent may want to read
 * them.
 */
export function formatAuditText(config: AgentContextConfig): string {
  const { sections, totals, workspace } = config;
  const lines: string[] = [];

  lines.push(`Standing context for workspace ${workspace.path}`);
  lines.push(
    `Total ${formatCount(totals.chars)} chars ~${formatCount(totals.tokensEst)} tokens (estimated)` +
      (totals.windowTokens
        ? ` — model window ${formatCount(totals.windowTokens)}, about ${Math.round((totals.share ?? 0) * 100)}%`
        : ' — model window unknown'),
  );
  lines.push('Sent on every request, before any conversation.');

  lines.push('');
  lines.push('By section (chars):');
  for (const row of budgetRows(config)) {
    lines.push(`  ${row.label.padEnd(16)} ${formatCount(row.chars)}`);
  }

  lines.push('');
  if (sections.base.text === null) {
    lines.push(`Base system prompt: text unavailable — ${sections.base.note}`);
  } else if (sections.base.overridden) {
    lines.push(
      `Base system prompt: REPLACED by a SYSTEM.md — ${formatCount(sections.base.chars ?? 0)} chars. ` +
        'The SDK built-in prompt is not in effect.',
    );
  } else {
    lines.push(`Base system prompt: ${formatCount(sections.base.chars ?? 0)} chars (SDK built-in)`);
  }

  if (config.promptFiles.length > 0) {
    lines.push('');
    lines.push('Prompt files (SYSTEM.md replaces the prompt, APPEND_SYSTEM.md adds to it):');
    for (const file of config.promptFiles) {
      const state = file.active
        ? 'IN EFFECT'
        : file.exists
          ? 'present but shadowed by the other scope — has no effect'
          : 'does not exist';
      lines.push(
        `  [${file.scope === 'global' ? '全局' : '工作区'}] ${file.path} — ${state}` +
          (file.exists ? ` (${formatCount(file.chars)} chars)` : ''),
      );
    }
  }

  if (sections.appended.length > 0) {
    lines.push('');
    lines.push('Appended segments:');
    for (const segment of sections.appended) {
      lines.push(`  ${segment.label} (${segment.source}) — ${formatCount(segment.chars)} chars`);
    }
  }

  if (sections.contextFiles.length > 0) {
    lines.push('');
    lines.push('Context files:');
    for (const file of sections.contextFiles) {
      lines.push(`  [${scopeLabel(file.scope)}] ${file.path} — ${formatCount(file.chars)} chars`);
    }
    lines.push("  These are the user's standing instructions and are editable from the Context panel.");
  } else {
    lines.push('');
    lines.push('Context files: none found (no AGENTS.md / CLAUDE.md in the agent dir or above the workspace).');
  }

  if (config.pluginDocs.length > 0) {
    lines.push('');
    lines.push('Installed plugins, by their PLUGIN.md index cost:');
    for (const doc of [...config.pluginDocs].sort((a, b) => b.chars - a.chars)) {
      lines.push(`  ${doc.name} (${doc.pluginId}) — ${formatCount(doc.chars)} chars — ${doc.path}`);
    }
  }

  if (sections.skills.items.length > 0) {
    lines.push('');
    lines.push(
      `Skills (${sections.skills.items.length}): ${sections.skills.items.map((s) => s.name).join(', ')}`,
    );
  }

  const pluginTools = sections.tools.filter((t) => t.source !== 'builtin');
  lines.push('');
  lines.push(
    `Tools: ${sections.tools.length} total` +
      (pluginTools.length > 0
        ? `; ${pluginTools.length} from plugins (${pluginTools.map((t) => t.name).join(', ')})`
        : ''),
  );

  return lines.join('\n');
}
