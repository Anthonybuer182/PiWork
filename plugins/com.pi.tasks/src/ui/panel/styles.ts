/**
 * Panel styles, injected at boot.
 *
 * Injected from here rather than linked as a stylesheet because the build emits
 * a single JS bundle with no CSS loader — and rather than written into
 * `index.html`, which would put the layout a long way from the components that
 * depend on it.
 *
 * Colours are the host's own theme tokens, which the shell streams into every
 * plugin panel as Tailwind-style HSL components (see THEME_VARS in
 * `panel-relay.tsx`, applied inline on <html> by the injected SDK). Components
 * are not colours, so every colour usage must wrap them in hsl() — a bare
 * `var(--x)` goes invalid once the tokens arrive. The `:root` values below are
 * component fallbacks for the moment before that arrives — without them the
 * first paint is transparent-on-transparent.
 */
export const CSS = `
:root {
  --background: 222 19% 7%; --foreground: 220 21% 92%;
  --card: 222 15% 11%; --card-foreground: 220 21% 92%;
  --muted: 222 16% 14%; --muted-foreground: 217 9% 59%;
  --border: 218 14% 20%; --input: 218 14% 20%;
  --primary: 218 100% 65%; --primary-foreground: 0 0% 100%;
  --secondary: 221 19% 17%; --secondary-foreground: 220 21% 92%;
  --accent: 221 19% 17%; --accent-foreground: 220 21% 92%;
  --ring: 218 100% 65%;
  --radius: 8px;
  --font-sans: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font: 13px/1.6 var(--font-sans);
  background: hsl(var(--background, 222 19% 7%)); color: hsl(var(--foreground, 220 21% 92%));
  overflow: hidden;
}
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
input, textarea, select {
  font: inherit; color: hsl(var(--foreground, 220 21% 92%)); background: hsl(var(--background, 222 19% 7%));
  border: 1px solid hsl(var(--border, 218 14% 20%)); border-radius: 6px; padding: 5px 9px;
  outline: none; width: 100%;
}
input:focus, textarea:focus, select:focus { border-color: hsl(var(--ring, 218 100% 65%)); }
textarea { resize: vertical; min-height: 56px; }
select { cursor: pointer; }

.app { display: flex; flex-direction: column; height: 100%; }

/* ── header ── */
/*
 * The panel can be maximised to the whole window. A 1900px-wide text field or
 * to-do row is not "more room", it is unreadable — so the content column keeps
 * a readable width and centres itself, while the rules and the editor's top
 * border still span the full pane. At side-panel widths this is a no-op.
 */
.hd {
  flex-shrink: 0; border-bottom: 1px solid hsl(var(--border, 218 14% 20%));
  padding: 10px max(12px, calc((100% - 800px) / 2)) 8px;
  display: flex; flex-direction: column; gap: 8px;
}
.hd-row { display: flex; align-items: center; gap: 6px; }
.tabs { display: flex; gap: 2px; background: hsl(var(--muted, 222 16% 14%)); border-radius: 7px; padding: 2px; }
.tab {
  padding: 4px 12px; border-radius: 5px; font-size: 12.5px;
  color: hsl(var(--muted-foreground, 217 9% 59%));
}
.tab[data-on="true"] { background: hsl(var(--card, 222 15% 11%)); color: hsl(var(--foreground, 220 21% 92%)); }
.tab .n {
  display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 8px;
  background: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%));
  font-size: 10.5px; line-height: 15px; vertical-align: 1px;
}
.grow { flex: 1; }
.btn {
  padding: 5px 12px; border-radius: 6px; font-size: 12.5px;
  border: 1px solid hsl(var(--border, 218 14% 20%)); color: hsl(var(--foreground, 220 21% 92%));
}
.btn:hover { background: hsl(var(--accent, 221 19% 17%)); }
.btn.primary { background: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%)); border-color: transparent; }
.btn.primary:hover { filter: brightness(1.08); }
.btn.tiny { padding: 2px 8px; font-size: 11.5px; }
.btn:disabled { opacity: .45; cursor: default; }

/* The one thing a user must know and would otherwise have to discover. */
.caveat {
  font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%));
  display: flex; align-items: baseline; gap: 6px;
}
.caveat b { font-weight: 600; color: hsl(var(--secondary-foreground, 220 21% 92%)); }

/* ── body ── */
.body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 8px max(12px, calc((100% - 800px) / 2)) 20px;
}

.group-hd {
  display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .3px;
  color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 12px 2px 5px;
}
.group-hd[data-first="true"] { padding-top: 4px; }
.group-hd.overdue { color: #e0663f; }

.row {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 7px 8px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent;
}
.row:hover { background: hsl(var(--accent, 221 19% 17%)); }
.row[data-done="true"] .title { color: hsl(var(--muted-foreground, 217 9% 59%)); text-decoration: line-through; }
.row[data-open="true"] { background: hsl(var(--accent, 221 19% 17%)); border-color: hsl(var(--border, 218 14% 20%)); }
.tick {
  flex-shrink: 0; width: 17px; height: 17px; margin-top: 2px;
  border: 1.5px solid hsl(var(--muted-foreground, 217 9% 59%)); border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; color: transparent;
}
.tick[data-done="true"] { background: hsl(var(--primary, 218 100% 65%)); border-color: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%)); }
.tick:hover { border-color: hsl(var(--primary, 218 100% 65%)); }
.main { flex: 1; min-width: 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { font-size: 12px; color: hsl(var(--muted-foreground, 217 9% 59%)); }
.when.overdue { color: #e0663f; }
.meta {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-top: 1px;
}
.badge {
  padding: 0 5px; border-radius: 4px; background: hsl(var(--secondary, 221 19% 17%));
  color: hsl(var(--secondary-foreground, 220 21% 92%)); font-size: 10.5px; line-height: 16px;
}
.note { font-size: 12px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-top: 2px; white-space: pre-wrap; }

/* Whose item this is, when it is not the current project's. Deliberately
   quieter than the title — it is a label, not content. */
.ws-badge {
  margin-left: 6px; padding: 0 5px; border-radius: 4px;
  border: 1px solid hsl(var(--border, 220 14% 27%));
  color: hsl(var(--muted-foreground, 217 9% 59%));
  font-size: 10px; line-height: 15px; font-weight: 400; vertical-align: 1px;
  white-space: nowrap;
}

/* ── workspace filter ── */
.scope-row { display: flex; align-items: center; gap: 6px; padding: 2px 0 8px; }
.scope-label {
  font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%));
  margin-right: 1px; user-select: none;
}
.scope-chip {
  padding: 1px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid hsl(var(--border, 220 14% 27%));
  background: transparent; color: hsl(var(--muted-foreground, 217 9% 59%));
  font-size: 12px; line-height: 20px; font-family: inherit;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.scope-chip[data-on="true"] {
  background: hsl(var(--secondary, 221 19% 17%));
  border-color: hsl(var(--secondary, 221 19% 17%));
  color: hsl(var(--secondary-foreground, 220 21% 92%));
}
.scope-chip:disabled { opacity: .4; cursor: default; }

.empty { text-align: center; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 40px 20px; font-size: 12.5px; }

/* ── calendar ── */
/* The panel can be maximised to the whole window, and a 7-column grid stretched
   across 1900px reads as empty tiles rather than a calendar. The grid keeps a
   calendar's proportions and centres itself instead. */
.month-hd { display: flex; align-items: center; gap: 6px; padding: 4px 2px 10px; max-width: 680px; margin: 0 auto; }
.month-hd .label { font-size: 14px; font-weight: 600; margin-right: 2px; }

.mode-tabs { display: flex; gap: 2px; background: hsl(var(--muted, 222 16% 14%)); border-radius: 6px; padding: 2px; }
.mode-tab { padding: 2px 10px; border-radius: 4px; font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); }
.mode-tab[data-on="true"] { background: hsl(var(--card, 222 15% 11%)); color: hsl(var(--foreground, 220 21% 92%)); }

.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; max-width: 680px; margin: 0 auto; }
.dow { text-align: center; font-size: 11px; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 4px 0; }

/* A row height, not a square aspect ratio: square cells turn a maximised
   panel's month into 270px-tall boxes and push the day list off screen. */
.cell {
  position: relative; border-radius: 6px; padding: 3px 4px 4px; min-height: 76px;
  display: flex; flex-direction: column; gap: 1px; align-items: stretch;
  text-align: left; border: 1px solid transparent; overflow: hidden;
}
.cell:hover { background: hsl(var(--accent, 221 19% 17%)); }
.cell[data-out="true"] { opacity: .42; }
.cell[data-sel="true"] { background: hsl(var(--accent, 221 19% 17%)); border-color: hsl(var(--border, 218 14% 20%)); }
/* Listed after the selected-cell rule on purpose: today keeps its ring even
   while it is the selected day. */
.cell[data-today="true"] { border-color: hsl(var(--primary, 218 100% 65%)); }
.cell[data-today="true"] .dnum { color: hsl(var(--primary, 218 100% 65%)); font-weight: 700; }
.dnum { font-size: 11.5px; line-height: 16px; font-weight: 500; }
/* A day you wrote about is worth finding again even if nothing was planned. */
.cell[data-note="true"] .dnum::after {
  content: ''; display: inline-block; width: 4px; height: 4px; border-radius: 50%;
  margin-left: 4px; vertical-align: 1px; background: hsl(var(--muted-foreground, 217 9% 59%));
}

/* The selected day's list sits under the grid at the grid's own width. */
.cal-detail { max-width: 680px; margin: 0 auto; }

.evs { display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
.ev {
  display: flex; gap: 3px; align-items: baseline; padding: 0 2px; border-radius: 3px;
  font-size: 10.5px; line-height: 14px; white-space: nowrap; overflow: hidden;
  background: hsl(var(--secondary, 221 19% 17%)); color: hsl(var(--secondary-foreground, 220 21% 92%));
}
.ev-t { flex-shrink: 0; opacity: .65; font-variant-numeric: tabular-nums; }
.ev-x { overflow: hidden; text-overflow: ellipsis; }
.ev[data-done="true"] { opacity: .45; text-decoration: line-through; }
.ev-more { background: transparent; color: hsl(var(--muted-foreground, 217 9% 59%)); font-size: 10px; }

/* ── week: seven stacks, no hour axis ── */
.week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; max-width: 680px; margin: 0 auto; align-items: start; }
.wk-col { display: flex; flex-direction: column; gap: 4px; min-height: 132px; border-radius: 6px; padding: 4px; }
.wk-col:hover { background: hsl(var(--muted, 220 15% 12%)); }
.wk-hd {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 3px 0; border-radius: 5px; border: 1px solid transparent;
}
.wk-dow { font-size: 10.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); }
.wk-dnum { font-size: 13px; }
.wk-hd[data-today="true"] .wk-dnum { color: hsl(var(--primary, 218 100% 65%)); font-weight: 700; }
.wk-hd[data-sel="true"] { background: hsl(var(--accent, 221 19% 17%)); border-color: hsl(var(--border, 218 14% 20%)); }
.wk-evs { display: flex; flex-direction: column; gap: 3px; }
.wk-ev {
  display: flex; flex-direction: column; gap: 1px; text-align: left;
  padding: 3px 5px; border-radius: 4px; font-size: 10.5px; line-height: 14px; overflow: hidden;
  background: hsl(var(--secondary, 221 19% 17%)); color: hsl(var(--secondary-foreground, 220 21% 92%));
}
.wk-ev:hover { filter: brightness(1.15); }
.wk-ev-t { opacity: .65; font-variant-numeric: tabular-nums; }
.wk-ev-x { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-ev[data-done="true"] { opacity: .45; }
.wk-ev[data-done="true"] .wk-ev-x { text-decoration: line-through; }
.wk-add {
  border: 1px dashed hsl(var(--border, 218 14% 20%)); border-radius: 4px;
  color: hsl(var(--muted-foreground, 217 9% 59%)); font-size: 12px; line-height: 18px;
  opacity: 0; transition: opacity .12s;
}
.wk-col:hover .wk-add, .wk-add:focus-visible { opacity: 1; }

/* ── undated backlog ── */
.unsched { max-width: 680px; margin: 14px auto 0; }
.unsched .group-hd { padding-top: 4px; }
.unsched-hint { font-size: 10.5px; font-weight: 400; opacity: .7; }
.unsched-items { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 2px; }
.unsched-chip {
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px;
  border: 1px solid hsl(var(--border, 218 14% 20%)); color: hsl(var(--foreground, 220 21% 92%));
}
.unsched-chip:hover { background: hsl(var(--accent, 221 19% 17%)); }
.empty-lane { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 0 2px; max-width: 680px; margin: 12px auto 0; }

/* ── log ── */
.log-row {
  display: flex; gap: 9px; padding: 7px 8px; border-radius: 7px;
  border-bottom: 1px solid hsl(var(--border, 218 14% 20%));
}
.log-row:last-child { border-bottom: 0; }
.st { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; }
.st.ok { background: #3fa663; }
.st.missed { background: #d9a441; }
.st.undelivered { background: #d9a441; }
.st.failed { background: #e0663f; }
.log-main { flex: 1; min-width: 0; }
.log-title { display: flex; align-items: baseline; gap: 7px; }
.log-title .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-sub { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); }

/* ── editor ── */
.editor {
  border-top: 1px solid hsl(var(--border, 218 14% 20%)); background: hsl(var(--card, 222 15% 11%));
  padding: 12px max(12px, calc((100% - 800px) / 2));
  flex-shrink: 0; max-height: 62%; overflow-y: auto;
}
.field { margin-bottom: 9px; }
.field > label {
  display: block; font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-bottom: 3px;
}
.f2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip {
  padding: 3px 10px; border-radius: 14px; font-size: 12px;
  border: 1px solid hsl(var(--border, 218 14% 20%)); color: hsl(var(--muted-foreground, 217 9% 59%));
}
.chip[data-on="true"] { background: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%)); border-color: transparent; }
.trig {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  padding: 6px 8px; border: 1px solid hsl(var(--border, 218 14% 20%)); border-radius: 6px;
}
.trig .k { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); flex-shrink: 0; }
.trig select, .trig input { width: auto; flex: 1; min-width: 0; padding: 3px 7px; font-size: 12px; }
.editor-actions { display: flex; gap: 7px; align-items: center; margin-top: 4px; }
.danger { color: #e0663f; }
.err {
  font-size: 12px; color: #e0663f; background: rgba(224,102,63,.1);
  border: 1px solid rgba(224,102,63,.3); border-radius: 6px;
  padding: 6px 9px; margin-bottom: 9px; white-space: pre-wrap;
}
.hint { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-top: 3px; }
.warn {
  font-size: 12px; color: #d9a441; background: rgba(217,164,65,.1);
  border: 1px solid rgba(217,164,65,.3); border-radius: 6px;
  padding: 6px 9px; margin-bottom: 9px;
}

/* ── 回顾: one page per day ── */
.day-col { margin-bottom: 14px; }
.day-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .3px;
  color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 6px 2px;
}
.day-empty { font-size: 12.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 2px 2px 8px; }
.day-section { margin-bottom: 8px; }
.day-sec-hd { font-size: 11.5px; padding: 3px 2px; color: hsl(var(--muted-foreground, 217 9% 59%)); }
.day-sec-hd.done { color: #3fa663; }
.day-sec-hd.miss { color: #d9a441; }
.row .mark { width: 16px; text-align: center; color: #3fa663; flex-shrink: 0; margin-top: 2px; }
.day-note { min-height: 150px; line-height: 1.7; }
.note-other { padding: 6px 8px; margin-bottom: 6px; border-radius: 6px; background: hsl(var(--muted, 220 15% 12%)); }
.note-other-hd { font-size: 11px; font-weight: 600; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-bottom: 3px; }
.note-other-body { font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; }
.save-tag { font-size: 11px; font-weight: 400; color: hsl(var(--muted-foreground, 217 9% 59%)); }

/* ── confirm ── */
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 50;
}
.dialog {
  background: hsl(var(--card, 222 15% 11%)); border: 1px solid hsl(var(--border, 218 14% 20%)); border-radius: var(--radius, 8px);
  padding: 16px; max-width: 320px; width: 100%;
}
.dialog h3 { font-size: 14px; margin-bottom: 6px; }
.dialog p { font-size: 12.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-bottom: 14px; }
.dialog .acts { display: flex; gap: 8px; justify-content: flex-end; }
`;
