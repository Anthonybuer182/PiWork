/**
 * The selection popup, as it is injected into the page.
 *
 * Everything the user sees and clicks is in here, because the page is the only
 * place it can be: the engine view covers this plugin's DOM, and a cross-origin
 * page cannot be reached from the panel either. The script therefore owns its
 * own composite popup, fallback card and toast, and talks to the backend
 * through globals:
 *
 *   __piSelAction    written on a button click or Enter; polled AND cleared by
 *                    the backend — the only page→plugin channel there is
 *   __piNoteShow     the backend calls this with a pending / final / timed-out
 *                    result; it renders inline while the popup is open, and
 *                    falls back to the bottom-right card when it is not
 *   __piRenderClips  the backend calls this with the saved clips (and the id
 *                    of the one just kept) to draw the list under the input
 *   __piToast        one-line confirmation for the rare failure path
 *   __piSelTheme     the panel's palette (HSL components) pushed from the
 *                    backend, so the popup matches the shell in light/dark
 *
 * The popup pins itself on the first interaction (focus in the input, any
 * button) — before that it follows the selection and disappears when the
 * selection collapses; pinned, only × / Esc / a new selection closes it, so a
 * half-typed question or an in-flight translation cannot be lost to a stray
 * click. The textarea is the single source of truth for what every action
 * acts on: it is pre-filled with the selection, and the user can trim it
 * before 翻译 or append a question before 发送.
 *
 * The shadow root is `closed` and the stylesheet is constructable (CSSOM),
 * so site CSS cannot bleed in and a site CSP cannot refuse the popup its
 * appearance — a `<style>` element would be blocked by `style-src 'none'`.
 * Re-running it is a no-op (`already`), which is what makes the per-navigation
 * injection and the self-heal in the poll cheap.
 *
 * No backticks or ${} below beyond the seed: the bundle is a template literal.
 */

export type SelThemeSeed = {
  dark: boolean;
  tokens: Record<string, string>;
};

export function selSource(seed: SelThemeSeed | null): string {
  const seedJson = JSON.stringify(seed ?? null);
  return String.raw`(function () {
  var seed = ${seedJson};

  if (window.__piSelInstalled) {
    if (seed && window.__piSelTheme) {
      try { window.__piSelTheme(seed); } catch (e) {}
    }
    return 'already';
  }
  try {
    var host = document.createElement('div');
    host.setAttribute('data-pi-sel-host', '');
    var root = host.attachShadow({ mode: 'closed' });

    // ── shell palette ──
    // The app's tokens arrive as HSL components ("0 0% 16%") over sel.theme;
    // everything below is written against hsl(var(--t-x)), so the popup follows
    // the shell's light/dark theme instead of guessing. The fallbacks are the
    // shell's own neutral palette for the case where no push has landed yet.
    var THEME_VARS = {
      'background': '--t-bg',
      'foreground': '--t-fg',
      'card': '--t-card',
      'card-foreground': '--t-card-fg',
      'muted': '--t-muted',
      'muted-foreground': '--t-muted-fg',
      'accent': '--t-accent',
      'accent-foreground': '--t-accent-fg',
      'border': '--t-border',
      'ring': '--t-ring',
      'primary': '--t-primary',
      'primary-foreground': '--t-primary-fg',
      'radius': '--t-radius',
      'font-sans': '--t-font'
    };
    function applyTheme(next) {
      if (!next) return;
      if (typeof next.dark === 'boolean') host.setAttribute('data-dark', next.dark ? '1' : '0');
      var tokens = next.tokens || {};
      for (var key in THEME_VARS) {
        if (!Object.prototype.hasOwnProperty.call(THEME_VARS, key)) continue;
        var value = tokens[key];
        if (typeof value === 'string' && value) {
          try { host.style.setProperty(THEME_VARS[key], value); } catch (e) {}
        }
      }
    }
    applyTheme(seed);
    if (host.getAttribute('data-dark') === null) {
      var darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      host.setAttribute('data-dark', darkMq && darkMq.matches ? '1' : '0');
    }
    window.__piSelTheme = function (next) {
      try { applyTheme(next); } catch (e) {}
    };

    // ── stylesheet ──
    // One constructable sheet: pseudo-classes (hover, focus-visible) are what
    // make the popup feel like part of the app, and CSSOM-set rules are immune
    // to the page's CSP. A style element is only the last-resort fallback.
    var CSS = [
      ':host{all:initial;--t-bg:0 0% 100%;--t-fg:0 0% 5%;--t-card:0 0% 100%;--t-card-fg:0 0% 5%;',
      '--t-muted:0 0% 96%;--t-muted-fg:0 0% 45%;--t-accent:0 0% 94%;--t-accent-fg:0 0% 5%;',
      '--t-border:0 0% 91%;--t-ring:0 0% 9%;--t-primary:0 0% 9%;--t-primary-fg:0 0% 98%;',
      '--t-radius:0.625rem;',
      '--t-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      ':host([data-dark="1"]){color-scheme:dark;--t-bg:0 0% 13%;--t-fg:0 0% 92%;--t-card:0 0% 17%;--t-card-fg:0 0% 92%;',
      '--t-muted:0 0% 21%;--t-muted-fg:0 0% 66%;--t-accent:0 0% 24%;--t-accent-fg:0 0% 92%;',
      '--t-border:0 0% 27%;--t-ring:0 0% 65%;--t-primary:0 0% 93%;--t-primary-fg:0 0% 9%}',
      '[hidden]{display:none!important}',

      '.popup{position:fixed;z-index:2147483647;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;',
      'width:380px;max-width:calc(100vw - 24px);max-height:calc(100vh - 16px);overflow:auto;padding:8px;',
      'border:1px solid hsl(var(--t-border));border-radius:calc(var(--t-radius,10px) + 2px);',
      'background:hsl(var(--t-card));color:hsl(var(--t-card-fg));',
      'font-family:var(--t-font,sans-serif);font-size:13px;line-height:1.5;text-align:left;',
      '-webkit-font-smoothing:antialiased;',
      'box-shadow:0 16px 40px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.12);',
      'animation:piSelIn .13s cubic-bezier(.2,.7,.3,1)}',
      ':host([data-dark="1"]) .popup{box-shadow:0 16px 44px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4)}',
      '@keyframes piSelIn{from{opacity:0;transform:translateY(-3px) scale(.985)}to{opacity:1;transform:none}}',
      '*,*::before,*::after{box-sizing:border-box}',

      '.actions{display:flex;align-items:center;gap:2px;padding:0 2px 0 0}',
      '.act{display:inline-flex;align-items:center;gap:5px;height:32px;padding:0 9px;border:0;',
      'border-radius:calc(var(--t-radius,10px) - 3px);background:transparent;color:hsl(var(--t-muted-fg));',
      'font:500 13px/1 var(--t-font,sans-serif);cursor:pointer;white-space:nowrap;',
      'transition:background .12s ease,color .12s ease,transform .06s ease}',
      '.act svg{width:15px;height:15px;flex:none;stroke:currentColor;fill:none;stroke-width:1.9;',
      'stroke-linecap:round;stroke-linejoin:round}',
      '@media (hover:hover){.act:hover{background:hsl(var(--t-accent));color:hsl(var(--t-accent-fg))}}',
      '.act:active{transform:scale(.97)}',
      '.act:focus-visible{outline:2px solid hsl(var(--t-ring));outline-offset:1px}',
      '.act[aria-disabled="true"]{opacity:.38;cursor:default}',
      '@media (hover:hover){.act[aria-disabled="true"]:hover{background:transparent;color:hsl(var(--t-muted-fg))}}',
      '.close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;',
      'margin-left:auto;padding:0;border:0;border-radius:6px;background:transparent;color:hsl(var(--t-muted-fg));',
      'cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.close svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round}',
      '@media (hover:hover){.close:hover{background:hsl(var(--t-accent));color:hsl(var(--t-accent-fg))}}',
      '.close:focus-visible{outline:2px solid hsl(var(--t-ring));outline-offset:1px}',

      '.composer{display:flex;align-items:flex-end;gap:6px}',
      '.field{flex:1;min-width:0;padding:2px;border:1px solid hsl(var(--t-border));',
      'border-radius:calc(var(--t-radius,10px) - 2px);background:hsl(var(--t-muted));',
      'transition:border-color .12s ease,box-shadow .12s ease}',
      '.field:focus-within{border-color:hsl(var(--t-ring));box-shadow:0 0 0 2px hsl(var(--t-ring)/.16)}',
      '.quote{display:flex;align-items:center;gap:6px;margin:2px 2px 0;padding:4px 4px 4px 8px;',
      'border-radius:calc(var(--t-radius,10px) - 4px);background:hsl(var(--t-accent));',
      'color:hsl(var(--t-accent-fg));font-size:12px;line-height:1.4}',
      '.quote-label{flex:none;color:hsl(var(--t-muted-fg));font-size:11px;letter-spacing:.02em}',
      '.quote-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.quote-count{flex:none;color:hsl(var(--t-muted-fg));font-variant-numeric:tabular-nums}',
      '.quote-x{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;',
      'padding:0;border:0;border-radius:4px;background:transparent;color:hsl(var(--t-muted-fg));',
      'font:13px/1 var(--t-font,sans-serif);cursor:pointer}',
      '@media (hover:hover){.quote-x:hover{background:hsl(var(--t-muted-fg)/.18);color:hsl(var(--t-card-fg))}}',
      'textarea{display:block;width:100%;min-height:32px;max-height:96px;resize:none;margin:0;',
      'padding:6px 8px;border:0;outline:none;background:transparent;color:hsl(var(--t-card-fg));',
      'font:13px/1.5 var(--t-font,sans-serif)}',
      'textarea::placeholder{color:hsl(var(--t-muted-fg))}',
      '.send{flex:none;height:36px;padding:0 14px;border:0;border-radius:calc(var(--t-radius,10px) - 2px);',
      'background:hsl(var(--t-primary));color:hsl(var(--t-primary-fg));',
      'font:600 13px/1 var(--t-font,sans-serif);cursor:pointer;white-space:nowrap;',
      'transition:opacity .12s ease,transform .06s ease}',
      '@media (hover:hover){.send:hover{opacity:.88}}',
      '.send:active{transform:scale(.98)}',
      '.send:focus-visible{outline:2px solid hsl(var(--t-ring));outline-offset:1px}',
      '.send[aria-disabled="true"]{opacity:.4;cursor:default}',

      '.results{max-height:42vh;overflow:auto;padding:8px 4px 2px;border-top:1px solid hsl(var(--t-border))}',
      '.results-head{display:flex;align-items:center;gap:8px;margin-bottom:5px}',
      '.results-title{flex:1;min-width:0;font:600 12px/1.4 var(--t-font,sans-serif);',
      'color:hsl(var(--t-muted-fg));letter-spacing:.01em}',
      '.results-title.busy::before{content:"";display:inline-block;width:6px;height:6px;margin-right:7px;',
      'border-radius:50%;background:hsl(var(--t-muted-fg));vertical-align:1px;',
      'animation:piPulse 1s ease-in-out infinite}',
      '@keyframes piPulse{0%,100%{opacity:.3}50%{opacity:1}}',
      '.results-body{font:13px/1.65 var(--t-font,sans-serif);color:hsl(var(--t-card-fg));',
      'white-space:pre-wrap;word-break:break-word}',

      '.icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;',
      'padding:0;border:1px solid hsl(var(--t-border));border-radius:6px;background:transparent;',
      'color:hsl(var(--t-muted-fg));cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}',
      '.icon-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.9;',
      'stroke-linecap:round;stroke-linejoin:round}',
      '@media (hover:hover){.icon-btn:hover{background:hsl(var(--t-accent));color:hsl(var(--t-accent-fg))}}',
      '.icon-btn:focus-visible{outline:2px solid hsl(var(--t-ring));outline-offset:1px}',
      '.icon-btn.playing{background:hsl(var(--t-accent));color:hsl(var(--t-accent-fg));',
      'border-color:hsl(var(--t-ring)/.55)}',

      '.clip{position:relative;margin-bottom:4px;padding:7px 26px 7px 10px;',
      'border-radius:calc(var(--t-radius,10px) - 3px);background:hsl(var(--t-muted));',
      'border-left:2px solid hsl(var(--t-border))}',
      '.clip.new{border-left-color:hsl(var(--t-fg))}',
      '.clip-text{font:12.5px/1.5 var(--t-font,sans-serif);color:hsl(var(--t-card-fg));',
      'white-space:pre-wrap;word-break:break-word;max-height:3.6em;overflow:hidden}',
      '.clip-src{margin-top:3px;font:11px/1.3 var(--t-font,sans-serif);color:hsl(var(--t-muted-fg))}',
      '.clip-x{position:absolute;top:5px;right:4px;width:18px;height:18px;padding:0;border:0;border-radius:4px;',
      'background:transparent;color:hsl(var(--t-muted-fg));font:11px/1 var(--t-font,sans-serif);cursor:pointer}',
      '@media (hover:hover){.clip-x:hover{background:hsl(var(--t-muted-fg)/.18);color:hsl(var(--t-card-fg))}}',
      '.clip-empty{padding:4px 0;font:12px/1.4 var(--t-font,sans-serif);color:hsl(var(--t-muted-fg))}',

      '.card{position:fixed;right:14px;bottom:14px;z-index:2147483647;box-sizing:border-box;',
      'display:flex;flex-direction:column;gap:4px;max-width:360px;max-height:44vh;overflow:auto;',
      'padding:12px 36px 12px 14px;border:1px solid hsl(var(--t-border));',
      'border-radius:calc(var(--t-radius,10px) + 2px);background:hsl(var(--t-card));color:hsl(var(--t-card-fg));',
      'font:13px/1.65 var(--t-font,sans-serif);',
      'box-shadow:0 16px 40px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.12)}',
      ':host([data-dark="1"]) .card{box-shadow:0 16px 44px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4)}',
      '.card-head{display:flex;align-items:center;gap:8px}',
      '.card-title{flex:1;min-width:0;font:600 12px/1.4 var(--t-font,sans-serif);',
      'color:hsl(var(--t-muted-fg));letter-spacing:.01em}',
      '.card-body{white-space:pre-wrap;word-break:break-word}',
      '.card-close{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;',
      'justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;',
      'background:transparent;color:hsl(var(--t-muted-fg));cursor:pointer}',
      '.card-close svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round}',

      '.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;',
      'max-width:calc(100vw - 32px);padding:8px 16px;border-radius:999px;',
      'background:hsl(var(--t-primary));color:hsl(var(--t-primary-fg));text-align:center;',
      'font:500 12.5px/1.3 var(--t-font,sans-serif);box-shadow:0 8px 24px rgba(0,0,0,.28)}'
    ].join('');
    var sheet = null;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      var styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      root.appendChild(styleEl);
    }

    var ICON = {
      translate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
      explain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z"/></svg>',
      speak: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
      clip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>',
      stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
    };

    function whenLabel(ts) {
      var d = new Date(ts || 0);
      if (isNaN(d.getTime())) return '';
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    function el(tag, cls) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      return n;
    }

    // ── the composite popup ──
    var popup = el('div', 'popup');
    popup.hidden = true;
    var pinned = false;
    var anchorRect = null;

    var actions = el('div', 'actions');
    function actionBtn(label, icon) {
      var b = el('button', 'act');
      b.type = 'button';
      b.innerHTML = icon + '<span class="act-label"></span>';
      b.querySelector('.act-label').textContent = label;
      b.setAttribute('aria-disabled', 'true');
      actions.appendChild(b);
      return b;
    }
    var btnTranslate = actionBtn('翻译', ICON.translate);
    var btnExplain = actionBtn('解释', ICON.explain);
    var btnSpeak = actionBtn('朗读', ICON.speak);
    var btnClip = actionBtn('收藏', ICON.clip);
    var btnClose = el('button', 'close');
    btnClose.type = 'button';
    btnClose.innerHTML = ICON.close;
    btnClose.title = '关闭';
    btnClose.setAttribute('aria-label', '关闭');
    actions.appendChild(btnClose);

    var composer = el('div', 'composer');
    var field = el('div', 'field');
    // The quote is a chip, not textarea text: a long selection stays one line,
    // and the question field below belongs to the user's words alone.
    var quoteRow = el('div', 'quote');
    quoteRow.hidden = true;
    var quoteLabel = el('span', 'quote-label');
    quoteLabel.textContent = '引用';
    var chipText = el('span', 'quote-text');
    var chipCount = el('span', 'quote-count');
    var chipX = el('button', 'quote-x');
    chipX.type = 'button';
    chipX.textContent = '×';
    chipX.title = '移除引用';
    chipX.setAttribute('aria-label', '移除引用');
    quoteRow.appendChild(quoteLabel);
    quoteRow.appendChild(chipText);
    quoteRow.appendChild(chipCount);
    quoteRow.appendChild(chipX);
    var question = el('textarea');
    question.rows = 1;
    question.placeholder = '问点什么，或直接回车发送引用…';
    field.appendChild(quoteRow);
    field.appendChild(question);
    var btnSend = el('button', 'send');
    btnSend.type = 'button';
    btnSend.textContent = '发送';
    btnSend.setAttribute('aria-disabled', 'true');
    composer.appendChild(field);
    composer.appendChild(btnSend);

    // The full quoted text lives here — the chip only shows a preview of it.
    var quoteText = null;
    function setQuote(text) {
      quoteText = text;
      if (quoteText) {
        chipText.textContent = quoteText.length > 42 ? quoteText.slice(0, 42) + '…' : quoteText;
        chipCount.textContent = quoteText.length > 42 ? quoteText.length + ' 字' : '';
        quoteRow.hidden = false;
      } else {
        quoteRow.hidden = true;
      }
      syncButtons();
    }
    // 翻译/解释/收藏 act on the quote; 发送 needs the quote or a question.
    function syncButtons() {
      var hasQuote = !!quoteText;
      var hasQuestion = !!question.value.trim();
      var quoteActions = [btnTranslate, btnExplain, btnSpeak, btnClip];
      for (var i = 0; i < quoteActions.length; i++) {
        quoteActions[i].setAttribute('aria-disabled', hasQuote ? 'false' : 'true');
      }
      btnSend.setAttribute('aria-disabled', (hasQuote || hasQuestion) ? 'false' : 'true');
    }
    question.addEventListener('input', syncButtons);
    chipX.addEventListener('click', function () { setQuote(null); });

    // ── the results area (and the clips list) ──
    var results = el('div', 'results');
    results.hidden = true;
    var resultsHeadRow = el('div', 'results-head');
    var resultsHead = el('div', 'results-title');
    var lastResultText = '';
    var btnReadResult = el('button', 'icon-btn');
    btnReadResult.type = 'button';
    btnReadResult.innerHTML = ICON.speak;
    btnReadResult.title = '朗读结果（再次点击停止）';
    btnReadResult.setAttribute('aria-label', '朗读结果');
    btnReadResult.hidden = true;
    btnReadResult.addEventListener('click', function () {
      if (!lastResultText) return;
      pin();
      report('朗读结果', { text: lastResultText.slice(0, 8000) });
      setReadUI(!readPlaying);
    });
    resultsHeadRow.appendChild(resultsHead);
    resultsHeadRow.appendChild(btnReadResult);
    var resultsBody = el('div', 'results-body');
    results.appendChild(resultsHeadRow);
    results.appendChild(resultsBody);

    popup.appendChild(actions);
    popup.appendChild(composer);
    popup.appendChild(results);

    // ── the fallback card, for results that arrive after the popup is gone ──
    var card = el('div', 'card');
    card.hidden = true;
    var cardHeadRow = el('div', 'card-head');
    var cardTitle = el('div', 'card-title');
    var cardRead = el('button', 'icon-btn');
    cardRead.type = 'button';
    cardRead.innerHTML = ICON.speak;
    cardRead.title = '朗读结果（再次点击停止）';
    cardRead.setAttribute('aria-label', '朗读结果');
    cardRead.hidden = true;
    cardRead.addEventListener('click', function () {
      var text = String(cardBody.textContent || '');
      if (!text.trim()) return;
      report('朗读结果', { text: text.slice(0, 8000) });
      setReadUI(!readPlaying);
    });
    var cardBody = el('div', 'card-body');
    var cardClose = el('button', 'card-close');
    cardClose.type = 'button';
    cardClose.innerHTML = ICON.close;
    cardClose.title = '关闭';
    cardClose.setAttribute('aria-label', '关闭');
    cardClose.addEventListener('click', function () { card.hidden = true; });
    cardHeadRow.appendChild(cardTitle);
    cardHeadRow.appendChild(cardRead);
    card.appendChild(cardHeadRow);
    card.appendChild(cardBody);
    card.appendChild(cardClose);

    var readPlaying = false;
    function setReadUI(playing) {
      readPlaying = !!playing;
      var icon = readPlaying ? ICON.stop : ICON.speak;
      btnReadResult.innerHTML = icon;
      cardRead.innerHTML = icon;
      var title = readPlaying ? '停止朗读' : '朗读结果（再次点击停止）';
      btnReadResult.title = title;
      cardRead.title = title;
      btnReadResult.classList.toggle('playing', readPlaying);
      cardRead.classList.toggle('playing', readPlaying);
    }
    // The backend pushes the host's real playback state here, so the icon
    // resets when a clip finishes on its own.
    window.__piReadState = function (playing) { setReadUI(!!playing); };

    // ── one-line toast, for the failure paths only ──
    var toast = el('div', 'toast');
    toast.hidden = true;
    var toastTimer = null;

    root.appendChild(popup);
    root.appendChild(card);
    root.appendChild(toast);
    document.documentElement.appendChild(host);

    // ── popup lifecycle ──
    function hidePopup() {
      popup.hidden = true;
      pinned = false;
    }
    function place() {
      var w = popup.offsetWidth || 380;
      var h = popup.offsetHeight || 150;
      var left = anchorRect ? Math.round(anchorRect.left) : 12;
      left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 12));
      // Below the selection; flip above when the popup would run off the
      // bottom and there is more room up there.
      var top = anchorRect ? Math.round(anchorRect.bottom + 8) : 12;
      if (anchorRect && top + h > window.innerHeight - 8) {
        var above = Math.round(anchorRect.top - h - 8);
        if (above > 8) top = above;
      }
      top = Math.max(8, Math.min(top, window.innerHeight - h - 12));
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }
    function showPopup(text) {
      pinned = false;
      card.hidden = true;
      results.hidden = true;
      resultsBody.textContent = '';
      resultsHead.textContent = '';
      resultsHead.classList.remove('busy');
      setQuote(text && text.trim() ? String(text) : null);
      question.value = '';
      // No autofocus: selecting-to-copy must keep working like on any page.
      popup.hidden = false;
      place();
    }
    // The popup grows when results arrive; re-clamp it inside the viewport.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        if (!popup.hidden) place();
      }).observe(popup);
    }

    function pin() { pinned = true; }
    function report(action, extra) {
      window.__piSelAction = {
        action: action,
        text: '',
        url: location.href,
        title: document.title,
        at: Date.now()
      };
      if (extra) {
        for (var k in extra) window.__piSelAction[k] = extra[k];
      }
    }
    function showResult(title, body, readable, pending) {
      resultsHead.textContent = title;
      resultsHead.classList.toggle('busy', !!pending);
      resultsBody.textContent = body || '';
      results.hidden = false;
      lastResultText = body ? String(body) : '';
      if (!readable) setReadUI(false);
      btnReadResult.hidden = !(readable && lastResultText.trim());
    }

    // ── selection tracking ──
    function onMouseUp(e) {
      // Mouseups inside our own popup are interactions, not selections.
      if (e && e.composedPath && e.composedPath().indexOf(host) >= 0) return;
      setTimeout(function () {
        var s = document.getSelection();
        var text = String(s || '').trim();
        if (!text) {
          // A plain click elsewhere: dismiss only if nothing was started here.
          if (!pinned && !popup.hidden) hidePopup();
          return;
        }
        // Fresh selection — new popup, even over a pinned one.
        anchorRect = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
        showPopup(String(s));
      }, 0);
    }
    function onSelectionChange() {
      if (pinned) return;
      if (!String(document.getSelection() || '').trim() && !popup.hidden) hidePopup();
    }
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    // The popup must stay under its text: whenever the page moves under it —
    // scroll, panel resize, fullscreen transitions, zoomFactor changes — the
    // anchor is re-derived from the live selection (which survives all of
    // those) and the popup is re-placed. Without this the popup hangs where
    // the layout used to put the text.
    function reanchor() {
      if (popup.hidden) return;
      var s = document.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) anchorRect = r;
      }
      if (anchorRect) place();
    }
    function onScroll() {
      if (popup.hidden) return;
      var s = document.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) { anchorRect = r; place(); return; }
      }
      // The text is gone (cleared selection): a pinned popup stays put — the
      // user pinned it on purpose; an unpinned one has no reason to exist.
      if (!pinned) hidePopup();
    }
    function onResize() {
      reanchor();
      // Fullscreen/maximize transitions animate; the final layout settles
      // after the resize event, so place once more when it has.
      setTimeout(reanchor, 250);
    }
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    // zoomFactor changes (auto-fit and manual zoom) relayout the page WITHOUT
    // firing a window resize — matchMedia sees the device pixel ratio move.
    var zoomMq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
    var onZoomMq = function () {
      zoomMq.removeEventListener('change', onZoomMq);
      reanchor();
      zoomMq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
      zoomMq.addEventListener('change', onZoomMq);
    };
    zoomMq.addEventListener('change', onZoomMq);

    // ── actions ──
    question.addEventListener('focus', pin);
    question.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hidePopup();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    btnClose.addEventListener('click', hidePopup);

    btnTranslate.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('翻译', { text: quoteText.slice(0, 8000) });
      showResult('翻译中', '', false, true);
    });
    btnExplain.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('解释', { text: quoteText.slice(0, 8000) });
      showResult('解释中', '', false, true);
    });
    btnSpeak.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('朗读', { text: quoteText.slice(0, 8000) });
      showResult('朗读', '用宿主语音朗读选中内容；再点一次停止。');
    });
    btnClip.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('收藏', { text: quoteText.slice(0, 8000) });
      showResult('收藏', '…');
    });

    function doSend() {
      var q = String(question.value || '').trim();
      if (!quoteText && !q) return;
      pin();
      // Question and quote travel separately: the backend composes the message.
      report('chat', { text: q, quote: quoteText ? quoteText.slice(0, 8000) : null });
      // The reply lands in the conversation — the popup is a launcher, not a chat.
      showResult('已发送 →', '回答在对话里，继续追问也在对话进行。');
    }
    btnSend.addEventListener('click', doSend);

    // ── the backend's handles into this UI ──
    window.__piNoteShow = function (payload) {
      if (!payload) return;
      var kind = payload.kind || '';
      var inPopup = !popup.hidden;
      var pendingText = '';
      if (payload.state === 'pending-hint') {
        pendingText = '还没回来 — 多半是第一次调用在等授权：去对话里点「总是允许」，本次会话就不再问了。';
      }
      if (payload.state === 'pending' || payload.state === 'pending-hint') {
        var head = kind === 'explain' ? '解释中' : kind === 'chat' ? '思考中' : '翻译中';
        if (inPopup) {
          showResult(head, pendingText, false, true);
        } else {
          cardTitle.textContent = head;
          cardBody.textContent = pendingText;
          cardRead.hidden = true;
          card.hidden = false;
        }
        return;
      }
      if (payload.state === 'timeout') {
        var tmsg = '等得有点久了 — 去对话里看看进度。';
        if (inPopup) {
          showResult('还在等结果', tmsg);
        } else {
          cardTitle.textContent = '还在等结果';
          cardBody.textContent = tmsg;
          cardRead.hidden = true;
          card.hidden = false;
        }
        return;
      }
      var title = payload.title || (kind === 'explain' ? '解释' : kind === 'translate' ? '译文' : kind === 'chat' ? '回答' : '结果');
      if (inPopup) {
        setReadUI(false);
        showResult(title, payload.text || '', true);
      } else {
        cardTitle.textContent = title;
        cardBody.textContent = payload.text || '';
        setReadUI(false);
        cardRead.hidden = !(payload.text || '').trim();
        card.hidden = false;
      }
    };
    window.__piRenderClips = function (clips, newestId) {
      resultsHead.textContent = '收藏的文字';
      resultsHead.classList.remove('busy');
      resultsBody.textContent = '';
      var list = Array.isArray(clips) ? clips : [];
      for (var i = 0; i < list.length; i++) {
        (function (clip) {
          var item = el('div', 'clip' + (clip.id === newestId ? ' new' : ''));
          var t = el('div', 'clip-text');
          t.textContent = clip.text && clip.text.length > 120 ? clip.text.slice(0, 120) + '…' : (clip.text || '');
          var src = el('div', 'clip-src');
          src.textContent = (clip.kind === 'page' ? '整页 · ' : '') +
            (clip.title || clip.url || '') + (clip.at ? ' · ' + whenLabel(clip.at) : '');
          var x = el('button', 'clip-x');
          x.type = 'button';
          x.textContent = '×';
          x.title = '删除这条收藏';
          x.setAttribute('aria-label', '删除这条收藏');
          x.addEventListener('click', function () {
            window.__piSelAction = { action: 'removeClip', id: clip.id, at: Date.now() };
          });
          item.appendChild(t);
          item.appendChild(src);
          item.appendChild(x);
          resultsBody.appendChild(item);
        })(list[i]);
      }
      if (!list.length) {
        var empty = el('div', 'clip-empty');
        empty.textContent = '还没有收藏的文字';
        resultsBody.appendChild(empty);
      }
      results.hidden = false;
    };
    window.__piToast = function (msg) {
      toast.textContent = String(msg || '');
      toast.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.hidden = true; }, 1800);
    };
    window.__piSelDisable = function () {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      zoomMq.removeEventListener('change', onZoomMq);
      if (host.parentNode) host.parentNode.removeChild(host);
      window.__piSelInstalled = false;
      window.__piSelAction = null;
    };

    window.__piSelInstalled = true;
    window.__piSelAction = null;
    return 'installed';
  } catch (e) {
    return 'failed: ' + (e && e.message ? e.message : String(e));
  }
})()`;
}
