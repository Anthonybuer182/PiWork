/**
 * Whole-page translation runtime, injected into the page as ONE self-contained
 * IIFE string — the same pattern as the selection popup (INJECT_SOURCE in
 * index.ts). The plugin hears no page events and holds no page-side state; this
 * script is the only state, and the backend drives it through browser.evaluate.
 *
 * Contract (v1):
 *   segment()         rescan the DOM, return how many new units were added
 *   takeVisible(n)    pending units near the viewport -> [{ id, kind, text }]
 *   apply(map)        { id: translation } -> rendered, returns the count
 *   units()           every unit (read-aloud queue)
 *   setMode(mode)     'dual' | 'replace' | 'source'
 *   highlight(id)     mark + scroll one unit (read-aloud)
 *   extractArticle()  title + blocks for explain / read / save
 *   status()          counters for the backend poll
 *   restore()         undo every DOM change, keep the runtime installed
 *   disable()         restore + remove the runtime
 *
 * Rules: block units get a sibling node (or a child when their parent is a
 * flex/grid container, so the item count never changes); inline UI text gets a
 * span appended inside the element; attributes are replaced and restored.
 * Translations copy the source element's computed font and colour; Latin-only
 * typographic properties are reset in the injected style sheet.
 *
 * No backticks or ${} below: the bundle is a template literal.
 */
export const IMT_SOURCE = String.raw`
(function () {
  'use strict';
  var VERSION = 1;
  var existing = window.__piImt;
  if (existing && existing.__v === VERSION) return 'already';
  if (!document.body) return 'no-body';

  var MAX_UNITS = 1200;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, CANVAS: 1, SVG: 1, VIDEO: 1, AUDIO: 1, PRE: 1, CODE: 1, KBD: 1, SAMP: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1 };
  var TEXT_BLOCK = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, LI: 1, TD: 1, TH: 1, DT: 1, DD: 1, BLOCKQUOTE: 1, FIGCAPTION: 1, CAPTION: 1, SUMMARY: 1, ADDRESS: 1 };
  var INLINE_UI = { A: 1, BUTTON: 1, LABEL: 1 };

  var seq = 0;
  var units = {};
  var list = [];
  var byEl = new WeakMap();
  var attrMap = new WeakMap();
  var visible = new Set();
  var mode = 'dual';
  var io = null;
  var mo = null;
  var rescanTimer = null;
  var styleEl = null;

  // ── helpers ────────────────────────────────────────────────────────────

  function isOwn(el) {
    return !!(el.closest && el.closest('[data-pi-imt]'));
  }

  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP[el.tagName]) return true;
    if (el.hasAttribute('data-pi-imt') || isOwn(el)) return true;
    var tr = el.getAttribute('translate');
    if (tr && tr.toLowerCase() === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    return false;
  }

  // Attribute text lives on elements our walk skips (input, textarea), so the
  // attribute pass gets its own skip test — same rules minus the tag blocklist.
  function isSkippedForAttr(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.hasAttribute('data-pi-imt') || isOwn(el)) return true;
    var tr = el.getAttribute('translate');
    if (tr && tr.toLowerCase() === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    return false;
  }

  /** Screen-reader-only text (clip, 1px, opacity 0) must never be surfaced. */
  function isVisuallyHidden(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return true;
    if (r.right <= 0) return true;
    var cs = getComputedStyle(el);
    if (parseFloat(cs.fontSize) <= 0) return true;
    if (cs.opacity === '0') return true;
    if (cs.clip && cs.clip !== 'auto') return true;
    if (cs.clipPath && cs.clipPath !== 'none') return true;
    if (cs.textIndent && parseFloat(cs.textIndent) < -1000) return true;
    // Sprite text (logo over an image) is often fully transparent. Gradient
    // text also has a transparent fill but paints a background, so keep that.
    var gradientText = String(cs.backgroundClip || cs.webkitBackgroundClip || '').indexOf('text') >= 0;
    if (!gradientText && (cs.color === 'rgba(0, 0, 0, 0)' || cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)')) return true;
    return false;
  }

  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    if (isVisuallyHidden(el)) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function inViewport(el) {
    var r = el.getBoundingClientRect();
    var h = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > -120 && r.top < h + 240;
  }

  function textOf(el) {
    var parts = [];
    var root = el;
    (function walkText(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          // Screen-reader-only text inside a visible element must not become
          // the unit's text (a 1px span inside a logo link or a paragraph).
          var owner = c.parentElement;
          var hidden = false;
          while (owner && owner !== root) {
            if (isVisuallyHidden(owner)) { hidden = true; break; }
            owner = owner.parentElement;
          }
          if (hidden) continue;
          parts.push(c.nodeValue);
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'BR') { parts.push(' '); continue; }
        if (c.hasAttribute('data-pi-imt')) continue;
        if (SKIP[c.tagName]) continue;
        walkText(c);
      }
    })(el);
    return parts.join('').replace(/[ \t\r\n]+/g, ' ').trim();
  }

  function scriptCounts(text) {
    var cjk = 0;
    var latin = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
          (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x3040 && c <= 0x30FF) ||
          (c >= 0xAC00 && c <= 0xD7AF)) cjk++;
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xC0 && c <= 0x24F)) latin++;
    }
    return { cjk: cjk, latin: latin };
  }

  /** Chinese/Japanese/Korean text needs no Chinese translation. */
  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isMostlyCjk(text) {
    var n = scriptCounts(text);
    if (n.cjk < 2) return false;
    return n.cjk / (n.cjk + n.latin) > 0.35;
  }

  function hasLetters(text) {
    return /[A-Za-zÀ-ɏЀ-ӿ぀-ヿ㐀-䶿一-鿿가-힯]/.test(text);
  }

  function directTextLen(el) {
    var n = 0;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) n += c.nodeValue.trim().length;
    }
    return n;
  }

  function interactiveCount(el) {
    var n = 0;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.tagName === 'A' || c.tagName === 'BUTTON' || c.tagName === 'LABEL') n++;
      else if (c.querySelector && c.querySelector('a,button,[role=button]')) n++;
    }
    return n;
  }

  function hasBlockChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (SKIP[c.tagName]) continue;
      if (c.hasAttribute('data-pi-imt')) continue;
      var d = getComputedStyle(c).display;
      if (d && d.indexOf('inline') !== 0 && d !== 'contents') return true;
    }
    return false;
  }

  function isRestrictive(el) {
    var cs = getComputedStyle(el);
    return cs.whiteSpace === 'nowrap' || cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden';
  }

  // ── units ──────────────────────────────────────────────────────────────

  function makeUnit(el, kind, text, added) {
    var u = {
      id: 'u' + (++seq),
      el: el,
      kind: kind,
      src: text,
      tr: '',
      state: 'pending',
      node: null,
      origHtml: el.innerHTML,
      replaced: false,
      attr: null,
      orig: null,
    };
    units[u.id] = u;
    list.push(u);
    byEl.set(el, u);
    if (io) io.observe(el);
    if (added) added.push(u.id);
    return u;
  }

  function addBlock(el, added) {
    if (list.length >= MAX_UNITS) return;
    if (!isVisible(el)) return;
    var text = textOf(el);
    if (text.length < 2 || !hasLetters(text) || isMostlyCjk(text)) return;
    makeUnit(el, 'block', text, added);
  }

  function addInline(el, added) {
    if (list.length >= MAX_UNITS) return;
    if (!isVisible(el)) return;
    var text = textOf(el);
    if (text.length < 2 || text.length > 240 || !hasLetters(text) || isMostlyCjk(text)) return;
    makeUnit(el, 'inline', text, added);
  }

  function addAttr(el, attr, added) {
    if (list.length >= MAX_UNITS) return;
    var rec = attrMap.get(el);
    if (!rec) { rec = {}; attrMap.set(el, rec); }
    if (rec[attr]) return;
    var val = el.getAttribute(attr);
    if (!val) return;
    val = val.trim();
    if (val.length < 2 || val.length > 160 || !hasLetters(val) || isMostlyCjk(val)) return;
    var u = {
      id: 'a' + (++seq),
      el: el,
      kind: 'attribute',
      attr: attr,
      src: val,
      tr: '',
      state: 'pending',
      node: null,
      replaced: false,
      orig: el.getAttribute(attr),
    };
    rec[attr] = u;
    units[u.id] = u;
    list.push(u);
    if (added) added.push(u.id);
    return u;
  }

  // ── scanning ───────────────────────────────────────────────────────────

  function walk(el, added) {
    if (!el || el.nodeType !== 1) return;
    if (list.length >= MAX_UNITS) return;
    if (isSkipped(el)) return;
    if (byEl.has(el)) return;

    var tag = el.tagName;
    // Open shadow roots are a separate subtree: scan them alongside the light
    // DOM (some component libraries put all their text there).
    if (el.shadowRoot) {
      var shadowKids = el.shadowRoot.children;
      for (var sh = 0; sh < shadowKids.length; sh++) walk(shadowKids[sh], added);
    }

    if (TEXT_BLOCK[tag]) { addBlock(el, added); return; }
    // A link/button that wraps block content is a card, not UI chrome: recurse
    // instead of taking its whole (often >240 char) text as one inline unit.
    if (INLINE_UI[tag] && !hasBlockChild(el)) { addInline(el, added); return; }

    if (hasBlockChild(el)) {
      for (var i = 0; i < el.children.length; i++) walk(el.children[i], added);
      return;
    }

    // A row of links/buttons with little own text is a toolbar, not a paragraph.
    if (interactiveCount(el) >= 2 && directTextLen(el) < 20) {
      for (var j = 0; j < el.children.length; j++) walk(el.children[j], added);
      return;
    }

    if (textOf(el).length >= 2) { addBlock(el, added); return; }
    for (var k = 0; k < el.children.length; k++) walk(el.children[k], added);
  }

  function scanAttributes(root, added) {
    var els = root.querySelectorAll('input[placeholder],textarea[placeholder],[title],img[alt],[aria-label]');
    for (var i = 0; i < els.length && list.length < MAX_UNITS; i++) {
      var el = els[i];
      if (isSkippedForAttr(el)) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') addAttr(el, 'placeholder', added);
      if (el.hasAttribute('title') && el.tagName !== 'BODY' && el.tagName !== 'HTML') addAttr(el, 'title', added);
      if (el.tagName === 'IMG') addAttr(el, 'alt', added);
      if (el.hasAttribute('aria-label') && !hasLetters(textOf(el))) addAttr(el, 'aria-label', added);
    }
  }

  function scan(root) {
    if (!root) return [];
    ensureObservers();
    var added = [];
    for (var i = 0; i < root.children.length && list.length < MAX_UNITS; i++) {
      walk(root.children[i], added);
    }
    scanAttributes(root, added);
    return added;
  }

  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(function () {
      rescanTimer = null;
      scan(document.body);
    }, 300);
  }

  // ── rendering ──────────────────────────────────────────────────────────

  function copyType(src, dst) {
    var cs = getComputedStyle(src);
    dst.style.fontFamily = cs.fontFamily;
    dst.style.fontSize = cs.fontSize;
    dst.style.fontWeight = cs.fontWeight;
    dst.style.fontStyle = cs.fontStyle;
    dst.style.lineHeight = cs.lineHeight;
    dst.style.color = cs.color;
    dst.style.textAlign = cs.textAlign;
    dst.style.letterSpacing = 'normal';
    dst.style.wordSpacing = 'normal';
    dst.style.textTransform = 'none';
    dst.style.fontVariant = 'normal';
    dst.style.fontFeatureSettings = 'normal';
    dst.style.webkitTextFillColor = 'currentColor';
  }

  function renderBlock(u) {
    if (u.node && u.node.isConnected) return;
    var el = u.el;
    var node = document.createElement('div');
    node.className = 'pi-imt-block';
    node.setAttribute('data-pi-imt', '1');
    node.setAttribute('data-pi-imt-for', u.id);
    node.textContent = u.tr;
    copyType(el, node);

    var parent = el.parentElement;
    var display = parent ? getComputedStyle(parent).display : '';
    if (parent && (display.indexOf('flex') >= 0 || display.indexOf('grid') >= 0 || display === 'table-row')) {
      // Stay one flex/grid item (and keep table rows intact): grow the block
      // instead of adding a sibling the layout would treat as a new cell.
      el.appendChild(node);
    } else if (el.parentNode) {
      el.parentNode.insertBefore(node, el.nextSibling);
    }
    u.node = node;
  }

  function renderInline(u) {
    if (u.node && u.node.isConnected) return;
    if (isRestrictive(u.el)) { replaceUnit(u); return; }
    var node = document.createElement('span');
    node.className = 'pi-imt-inline';
    node.setAttribute('data-pi-imt', '1');
    node.setAttribute('data-pi-imt-for', u.id);
    node.textContent = u.tr;
    u.el.appendChild(node);
    u.node = node;
  }

  function replaceUnit(u) {
    u.replaced = true;
    u.el.textContent = u.tr;
    u.node = null;
  }

  function render(u) {
    if (!u.tr) return;
    if (u.kind === 'attribute') {
      if (u.orig === null) u.orig = u.el.getAttribute(u.attr);
      u.el.setAttribute(u.attr, u.tr);
      return;
    }
    if (mode === 'replace') { replaceUnit(u); return; }
    if (u.kind === 'inline') renderInline(u);
    else renderBlock(u);
  }

  function unrender(u) {
    if (u.node && u.node.parentNode) u.node.parentNode.removeChild(u.node);
    u.node = null;
    if (u.el && u.el.removeAttribute) u.el.removeAttribute('data-pi-imt-failed');
    if (u.kind === 'attribute') {
      if (u.orig !== null && u.el.getAttribute(u.attr) === u.tr) u.el.setAttribute(u.attr, u.orig);
      return;
    }
    if (u.replaced) {
      u.el.innerHTML = u.origHtml;
      u.replaced = false;
    }
  }

  function setMode(next) {
    if (next !== 'dual' && next !== 'replace' && next !== 'source') next = 'dual';
    mode = next;
    for (var i = 0; i < list.length; i++) unrender(list[i]);
    if (mode !== 'source') {
      for (var j = 0; j < list.length; j++) if (list[j].tr) render(list[j]);
    }
    return mode;
  }

  // ── backend-facing API ─────────────────────────────────────────────────

  function takeVisible(n) {
    var out = [];
    var h = window.innerHeight || 0;
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.state !== 'pending') continue;
      if (!u.src) continue;
      if (!inViewport(u.el)) continue;
      out.push(u);
    }
    out.sort(function (a, b) {
      var ra = a.el.getBoundingClientRect();
      var rb = b.el.getBoundingClientRect();
      var ca = Math.abs(ra.top + ra.height / 2 - h / 2);
      var cb = Math.abs(rb.top + rb.height / 2 - h / 2);
      return ca - cb;
    });
    var lim = Math.max(1, n || 12);
    out = out.slice(0, lim);
    for (var j = 0; j < out.length; j++) out[j].state = 'queued';
    return out.map(function (u) {
      return { id: u.id, kind: u.kind, text: u.src };
    });
  }

  function apply(map) {
    var n = 0;
    if (!map || typeof map !== 'object') return 0;
    for (var id in map) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
      var u = units[id];
      if (!u) continue;
      var text = String(map[id] == null ? '' : map[id]).trim();
      u.tr = text;
      var identical = text.length > 0 && normalizeText(text) === normalizeText(u.src);
      if (text && !identical) {
        u.state = 'done';
        if (u.el && u.el.removeAttribute) u.el.removeAttribute('data-pi-imt-failed');
        render(u);
      } else if (text) {
        // The model returned the source unchanged (names, brand + Chinese
        // labels): rendering it again would just duplicate the line.
        u.state = 'done';
        unrender(u);
      } else {
        unrender(u);
        u.state = 'failed';
        if (u.kind !== 'attribute' && u.el && u.el.setAttribute) u.el.setAttribute('data-pi-imt-failed', '1');
      }
      n++;
    }
    return n;
  }

  function fail(ids) {
    if (!Array.isArray(ids)) return 0;
    var n = 0;
    for (var i = 0; i < ids.length; i++) {
      var u = units[ids[i]];
      if (!u) continue;
      u.state = 'failed';
      if (u.kind !== 'attribute' && u.el && u.el.setAttribute) u.el.setAttribute('data-pi-imt-failed', '1');
      n++;
    }
    return n;
  }

  /** Put failed units back in the queue (the panel's retry button). */
  function retryFailed() {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.state !== 'failed') continue;
      u.state = 'pending';
      u.tr = '';
      if (u.el && u.el.removeAttribute) u.el.removeAttribute('data-pi-imt-failed');
      n++;
    }
    return n;
  }

  function unitsApi() {
    return list.map(function (u) {
      return { id: u.id, kind: u.kind, src: u.src, tr: u.tr, visible: inViewport(u.el) };
    });
  }

  /**
   * Highlight the layer being read: 'tr' marks the appended translation node
   * (or the source element in replace mode, where the translation lives there),
   * 'src' marks the source block.
   */
  function highlight(id, layer) {
    clearHighlight();
    var u = units[id];
    if (!u) return false;
    var target = layer === 'tr' && u.node && u.node.isConnected ? u.node : u.el;
    if (!target) return false;
    target.setAttribute('data-pi-imt-hl', '1');
    try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (e) { target.scrollIntoView(); }
    return true;
  }

  function clearHighlight() {
    var els = document.querySelectorAll('[data-pi-imt-hl]');
    for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-pi-imt-hl');
  }

  // ── in-page overlay: explain drawer, read bar, toast ───────────────────
  //
  // Lives in a closed shadow root of the same host the page cannot reach, so
  // site CSS cannot restyle it and our own scanner ignores it. Buttons do not
  // act directly: they drop an action here and the backend polls it — the page
  // still has no way to push.

  var overlay = null;
  var pendingAction = null;
  var toastTimer = null;

  function overlayMarkup() {
    var css = [
      ':host{all:initial}',
      '.panel{position:fixed;top:0;right:0;bottom:0;width:min(380px,100vw);z-index:2147483647;',
      'background:#fff;color:#222;font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
      'box-shadow:-24px 0 48px rgba(0,0,0,.18);display:flex;flex-direction:column;padding:18px 20px;box-sizing:border-box;overflow-y:auto}',
      '.panel[hidden]{display:none}',
      '.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}',
      '.t{font-weight:600;font-size:15px}',
      '.x{border:0;background:none;font-size:18px;line-height:1;color:#888;cursor:pointer}',
      '.h{margin:18px 0 6px;font-size:11px;letter-spacing:.08em;color:#888;text-transform:uppercase}',
      '.sum{margin:8px 0 0}',
      'ul{margin:0;padding-left:18px} li{margin:6px 0}',
      '.term{display:inline-block;margin:4px 6px 0 0;padding:2px 8px;border:1px solid #ddd;border-radius:6px;font-size:12px;color:#666}',
      '.foot{display:flex;gap:8px;margin-top:auto;padding-top:18px}',
      '.b{border:1px solid #ddd;background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}',
      '.b.primary{background:#b5621f;border-color:#b5621f;color:#fff}',
      '.toast{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:2147483647;',
      'background:#1f1f22;color:#eee;padding:8px 14px;border-radius:999px;font:12.5px/1.4 -apple-system,sans-serif}',
      '.toast[hidden]{display:none}',
      '@media (prefers-color-scheme: dark){',
      '.panel{background:#1b1b1e;color:#eee;box-shadow:-24px 0 48px rgba(0,0,0,.5)}',
      '.x{color:#999}.term{border-color:#3a3a40;color:#aaa}',
      '.b{background:#242429;border-color:#3a3a40;color:#eee}',
      '.b.primary{background:#b5621f;border-color:#b5621f;color:#fff}',
      '}'
    ].join('');
    return '<style>' + css + '</style>' +
      '<div class="panel" hidden>' +
        '<div class="head"><div class="t"></div><button class="x" data-a="explain-close" aria-label="关闭">×</button></div>' +
        '<div class="body"></div>' +
        '<div class="foot"><button class="b primary" data-a="explain-read">朗读要点</button><button class="b" data-a="explain-save">收藏</button></div>' +
      '</div>' +
      '<div class="toast" hidden></div>';
  }

  function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    var host = document.createElement('div');
    host.setAttribute('data-pi-imt', '1');
    var root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = overlayMarkup();
    document.documentElement.appendChild(host);
    overlay = {
      host: host,
      root: root,
      panel: root.querySelector('.panel'),
      title: root.querySelector('.t'),
      body: root.querySelector('.body'),
      toast: root.querySelector('.toast')
    };
    root.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
      if (!b) return;
      pendingAction = { action: b.getAttribute('data-a'), at: Date.now() };
    });
    return overlay;
  }

  function showExplain(p) {
    var o = ensureOverlay();
    o.title.textContent = p && p.title ? p.title : '整页解释';
    o.body.textContent = '';
    if (p && p.summary) {
      var sum = document.createElement('p');
      sum.className = 'sum';
      sum.textContent = p.summary;
      o.body.appendChild(sum);
    }
    if (p && p.bullets && p.bullets.length) {
      var h = document.createElement('div');
      h.className = 'h';
      h.textContent = '要点';
      o.body.appendChild(h);
      var ul = document.createElement('ul');
      for (var i = 0; i < p.bullets.length; i++) {
        var li = document.createElement('li');
        li.textContent = String(p.bullets[i]);
        ul.appendChild(li);
      }
      o.body.appendChild(ul);
    }
    if (p && p.terms && p.terms.length) {
      var th = document.createElement('div');
      th.className = 'h';
      th.textContent = '术语';
      o.body.appendChild(th);
      for (var j = 0; j < p.terms.length; j++) {
        var term = p.terms[j] || {};
        var chip = document.createElement('span');
        chip.className = 'term';
        chip.textContent = String(term.en || '') + (term.zh ? ' · ' + String(term.zh) : '');
        o.body.appendChild(chip);
      }
    }
    o.panel.hidden = false;
    return true;
  }

  function hideExplain() {
    if (overlay) overlay.panel.hidden = true;
    return true;
  }

  function showToast(text) {
    var o = ensureOverlay();
    o.toast.textContent = String(text || '');
    o.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (overlay) overlay.toast.hidden = true;
    }, 2200);
    return true;
  }

  function pollOverlay() {
    var a = pendingAction;
    pendingAction = null;
    return {
      action: a,
      panel: !!(overlay && overlay.panel && !overlay.panel.hidden)
    };
  }

  function pickRoot() {
    var direct = document.querySelector('article') || document.querySelector('[role="main"]') || document.querySelector('main');
    if (direct) return direct;
    var best = null;
    var bestScore = 0;
    var cands = document.querySelectorAll('div,section');
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var t = textOf(el);
      if (t.length < 240) continue;
      var links = el.querySelectorAll('a');
      var linkText = 0;
      for (var j = 0; j < links.length; j++) linkText += textOf(links[j]).length;
      var score = t.length - linkText * 2;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best || document.body;
  }

  function extractArticle() {
    var root = pickRoot();
    var titleEl = document.querySelector('h1');
    var title = (titleEl ? textOf(titleEl) : document.title) || '';
    var nodes = root.querySelectorAll('h1,h2,h3,p,li,blockquote,figcaption,td');
    var blocks = [];
    var chars = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var t = textOf(el);
      if (!t || t.length < 2) continue;
      if (!/^H[1-3]$/.test(el.tagName) && t.length < 24) continue;
      if (chars + t.length > 30000) break;
      chars += t.length;
      blocks.push({ tag: el.tagName.toLowerCase(), text: t });
    }
    return { title: title.trim(), blocks: blocks, chars: chars, truncated: chars >= 30000 };
  }

  function status() {
    var done = 0;
    var failed = 0;
    var pendingVisible = 0;
    var sample = String((document.body && document.body.innerText) || '').slice(0, 3000);
    var script = scriptCounts(sample);
    var pageCjk = script.cjk + script.latin > 0 ? script.cjk / (script.cjk + script.latin) : 0;
    var frames = document.querySelectorAll('iframe');
    var blocked = 0;
    for (var f = 0; f < frames.length; f++) {
      try { if (!frames[f].contentDocument) blocked++; }
      catch (e) { blocked++; }
    }
    for (var i = 0; i < list.length; i++) {
      var s = list[i].state;
      if (s === 'done') done++;
      else if (s === 'failed') failed++;
      else if (s === 'pending' && inViewport(list[i].el)) pendingVisible++;
    }
    return {
      alive: true,
      version: VERSION,
      mode: mode,
      total: list.length,
      done: done,
      failed: failed,
      pending: list.length - done - failed,
      pendingVisible: pendingVisible,
      visible: visible.size,
      frames: frames.length,
      blockedFrames: blocked,
      pageCjk: pageCjk,
      htmlLang: String((document.documentElement && document.documentElement.lang) || '').toLowerCase(),
    };
  }

  // ── observers / stylesheet ─────────────────────────────────────────────

  function ensureObservers() {
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var u = byEl.get(entries[i].target);
          if (!u) continue;
          if (entries[i].isIntersecting) visible.add(u.id);
          else visible.delete(u.id);
        }
      }, { rootMargin: '160px 0px' });
      for (var k = 0; k < list.length; k++) io.observe(list[k].el);
    }
    if (!mo) {
      mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var nodes = records[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (n.nodeType === 1 && !n.hasAttribute('data-pi-imt')) {
              scheduleRescan();
              return;
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.querySelector('style[data-pi-imt-style]');
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-pi-imt-style', '1');
    styleEl.textContent = [
      '[data-pi-imt-hl]{outline:2px solid rgba(196,120,44,.85);outline-offset:2px;border-radius:3px}',
      '.pi-imt-block{display:block;margin:.4em 0 .7em;padding:0;',
      'text-transform:none;letter-spacing:normal;',
      'word-spacing:normal;font-variant:normal;font-feature-settings:normal;',
      '-webkit-text-fill-color:currentColor}',
      '.pi-imt-inline{text-transform:none;letter-spacing:normal;word-spacing:normal;font-variant:normal}',
      '[data-pi-imt-failed]{text-decoration:underline dotted rgba(200,60,50,.65);text-underline-offset:3px}',
      '.pi-imt-inline::before{content:"·";margin:0 .4em;opacity:.45}',
    ].join('');
    document.head.appendChild(styleEl);
  }

  // ── teardown ───────────────────────────────────────────────────────────

  function restore() {
    if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    pendingAction = null;
    if (overlay && overlay.host.parentNode) overlay.host.parentNode.removeChild(overlay.host);
    overlay = null;
    for (var i = 0; i < list.length; i++) unrender(list[i]);
    clearHighlight();
    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    units = {};
    list = [];
    byEl = new WeakMap();
    attrMap = new WeakMap();
    visible = new Set();
    seq = 0;
    return true;
  }

  function disable() {
    restore();
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    try { delete window.__piImt; }
    catch (e) { window.__piImt = undefined; }
    return true;
  }

  // ── install ────────────────────────────────────────────────────────────

  var api = {
    __v: VERSION,
    segment: function () { return scan(document.body).length; },
    takeVisible: takeVisible,
    apply: apply,
    fail: fail,
    retryFailed: retryFailed,
    units: unitsApi,
    setMode: setMode,
    mode: function () { return mode; },
    highlight: highlight,
    clearHighlight: clearHighlight,
    extractArticle: extractArticle,
    showExplain: showExplain,
    hideExplain: hideExplain,
    showToast: showToast,
    pollOverlay: pollOverlay,
    hasUnit: function (el) { return byEl.has(el); },
    status: status,
    restore: restore,
    disable: disable,
  };

  ensureStyle();
  ensureObservers();
  scan(document.body);
  window.__piImt = api;
  return 'installed';
})();
`;
