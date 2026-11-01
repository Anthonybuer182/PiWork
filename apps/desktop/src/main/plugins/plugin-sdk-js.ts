/**
 * Source of the SDK script injected into plugin panels.
 *
 * Served at `pi-plugin://<pluginId>/__pi_sdk.js` with the plugin id
 * substituted into `__PI_PLUGIN_ID__`. Provides `window.piSDK`:
 *
 *   piSDK.pluginId
 *   piSDK.panelId                                    (read-only; which panel)
 *   piSDK.request(method, params) → Promise<result>  (backend round-trip)
 *   piSDK.emit(event, data)                          (fire-and-forget)
 *   piSDK.onMessage(cb)                              (backend → UI events)
 *   piSDK.liveSlot(name, element) → { detach }       (bind a host engine view
 *                                                     into the page layout;
 *                                                     native view panels only)
 *
 * THE PANEL ID IS NOT THE AUTHOR'S PROBLEM. `panelId` rides on the panel URL
 * (see panelUrl in @pi/types), the pi-plugin:// handler turns it into
 * `window.__piPanelId`, and this script stamps it onto every outbound message.
 * A plugin with one panel can ignore it entirely; a plugin with several gets
 * routing for free, which is the point — the previous convention required the
 * author to place it by hand, in the right nesting level, and getting it wrong
 * failed silently on both ends.
 *
 * TWO CONTAINERS, ONE SDK. A panel may be hosted either as an iframe inside the
 * shell renderer (the web build, and panels on hosts without native views) or
 * as a top-level `WebContentsView`. The difference matters here:
 *
 *   - In an iframe, `window.parent` is the shell — the natural transport.
 *   - In a view, `window.parent` IS this window. Posting to it would loop the
 *     message straight back, so the transport is the preload bridge
 *     (`window.__piViewBridge`, see apps/desktop/src/preload/plugin-view.ts).
 *
 * Rather than making every plugin aware of that, this script installs a
 * `window.parent` stand-in inside a view whose `postMessage` forwards over the
 * bridge. Every first-party plugin sends with
 * `window.parent.postMessage({__piPlugin:true, direction:'ui', payload}, '*')`
 * verbatim, so they keep working with no changes at all.
 */
export const PI_SDK_FILENAME = '__pi_sdk.js';

export function buildPluginSdkJs(pluginId: string): string {
  return PLUGIN_SDK_SOURCE.replaceAll('__PI_PLUGIN_ID__', pluginId);
}

/**
 * The SDK source is a String.raw template literal. A backtick or a
 * dollar-brace sequence anywhere inside it — including inside a comment —
 * terminates the template early and fails the build with a confusing
 * "Expected ; but found ..." pointing at an innocent-looking line.
 * Describe code references in plain words down there.
 */
const PLUGIN_SDK_SOURCE = String.raw`
(function () {
  'use strict';

  var PLUGIN_ID = '__PI_PLUGIN_ID__';

  // Which panel this page is. The host writes it into the HTML it serves (see
  // protocol.ts injectSdk) because a pi-plugin:// request carries no caller
  // identity — without it a plugin with several panels could not tell its own
  // messages apart, and the backend could not route a reply back to the right
  // one. Stamped onto every outbound message, so a plugin author never
  // writes it.
  var PANEL_ID = window.__piPanelId || '';

  if (!PANEL_ID) {
    // Only reachable if the page was opened outside the host (a file:// or
    // direct pi-plugin:// load). Say so loudly: every message this page sends
    // arrives at the backend with no panel to attribute it to.
    console.error('[pi-sdk] no panel id on this page. It was not served as a ' +
      'plugin panel, so the backend cannot tell where its messages come from. ' +
      'Open the panel through the app instead.');
  }

  /** How long a piSDK.request waits before giving up. 90s: 深页邮件列表
   * (大量信封+结构)在大邮箱上会超过 30s,等待上限放宽而不是失败。 */
  var REQUEST_TIMEOUT_MS = 90000;

  var seq = 0;
  var pending = new Map();
  var handlers = [];

  // ── Transport ──────────────────────────────────────────────────────
  // Set by the plugin-view preload when this panel is a native view.
  var VIEW = window.__piViewBridge || null;
  var IN_VIEW = !!VIEW;

  // ── Workspace (protocol 7) ─────────────────────────────────────────
  // Which workspace this panel is serving. Pushed by the preload (one value
  // per view, which is why it cannot come through the backend — that is one
  // process shared by every window). Null until the shell reports one.
  var workspaceId = null;
  var workspaceHandlers = [];

  /** Backend traffic: requests and events. */
  function postToHost(payload) {
    if (IN_VIEW) { VIEW.send(payload); return; }
    window.parent.postMessage({
      __piPlugin: true,
      pluginId: PLUGIN_ID,
      direction: 'ui',
      payload: payload
    }, '*');
  }

  function applyThemeTokens(tokens) {
    try {
      for (var k in tokens) {
        if (Object.prototype.hasOwnProperty.call(tokens, k)) {
          document.documentElement.style.setProperty(k, tokens[k]);
        }
      }
    } catch (e) { /* best-effort */ }
  }

  /** Backend → UI. Reaches here over a window message (iframe) or the port (view). */
  function handleBackendMessage(payload) {
    if (!payload) return;

    if (payload.kind === 'response') {
      var entry = pending.get(payload.id);
      if (entry) {
        pending.delete(payload.id);
        // ok is the authority. An error field alone is still honoured, so a
        // backend written against the older shape keeps working.
        if (payload.ok === false || payload.error) {
          entry.reject(new Error(payload.error || 'request failed'));
        } else {
          entry.resolve(payload.result);
        }
      }
      return;
    }

    if (payload.kind === 'event' && payload.event === 'pi.probe') {
      // The pong for the backend's ctx.panelAlive. SDK-level, like panel.mounted
      // is on the backend side: an author asking "is the panel there" should not
      // have to also write the reply. Echo the probe's data (it carries the id)
      // and do not forward the probe to plugin handlers — nothing to handle.
      postToHost({
        kind: 'event', id: 'probe-reply-' + (++seq), panelId: PANEL_ID,
        event: 'pi.probe.reply', data: payload.data
      });
      return;
    }

    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](payload); } catch (e) { console.error('[pi-sdk] handler error:', e); }
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__piPlugin !== true) return;
    if (data.direction === 'theme' && data.payload && data.payload.tokens) {
      applyThemeTokens(data.payload.tokens);
      return;
    }
    if (data.pluginId !== PLUGIN_ID || data.direction !== 'backend') return;
    handleBackendMessage(data.payload);
  });

  if (IN_VIEW) {
    // Re-dispatch with the envelope an iframe parent would have sent.
    //
    // Every first-party plugin listens on window for the frame
    // {__piPlugin:true, direction:'backend', payload} rather than calling
    // piSDK.onMessage — in a view nothing posts to the window, so without this
    // re-wrap their handlers never fire and panels stay empty. The SDK's own
    // window listener handles the re-dispatched frame and does not post again,
    // so this cannot loop.
    VIEW.onMessage(function (payload) {
      window.postMessage({
        __piPlugin: true,
        pluginId: PLUGIN_ID,
        direction: 'backend',
        payload: payload
      }, '*');
    });
    VIEW.onTheme(function (tokens) { applyThemeTokens(tokens); });
    if (VIEW.onWorkspace) {
      VIEW.onWorkspace(function (id) {
        workspaceId = id || null;
        for (var i = 0; i < workspaceHandlers.length; i++) {
          try { workspaceHandlers[i](workspaceId); } catch (e) { console.error('[pi-sdk] workspace handler error:', e); }
        }
      });
    }

    // Present a window.parent that behaves like an iframe parent, so plugin
    // code that posts to it directly keeps working. The property is an own,
    // configurable accessor on Window in a top-level frame (verified), so this
    // redefine succeeds; if a future Chromium makes it non-configurable the
    // catch leaves piSDK as the only transport, which is still functional.
    try {
      var parentShim = {
        postMessage: function (frame) {
          if (!frame || frame.__piPlugin !== true) return;
          if (frame.direction === 'ui') VIEW.send(frame.payload);
        }
      };
      Object.defineProperty(window, 'parent', { configurable: true, get: function () { return parentShim; } });
    } catch (e) { /* keep piSDK as the transport */ }
  }

  // ── Public surface ─────────────────────────────────────────────────
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'ui-' + (++seq);
      // Without this a backend that never answers leaves the promise pending
      // forever, and the panel just sits there. Silence is the failure mode
      // this SDK exists to remove.
      var timer = setTimeout(function () {
        if (pending.delete(id)) {
          reject(new Error('piSDK.request timed out after ' + REQUEST_TIMEOUT_MS +
            'ms: ' + method + ' — did the backend handle this method?'));
        }
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      });
      postToHost({
        kind: 'request', id: id, panelId: PANEL_ID,
        method: method, params: params || {}
      });
    });
  }

  function emit(event, data) {
    postToHost({
      kind: 'event', id: 'ev-' + (++seq), panelId: PANEL_ID,
      event: event, data: data
    });
  }

  // ── Live slots ─────────────────────────────────────────────────────
  // Bind a host engine view into this page's layout: the element becomes the
  // rectangle where the host positions a native view (today: the embedded
  // browser, for plugins holding the browser permission). Only meaningful
  // in a native view — an iframe/web panel has no native layer to position.
  //
  // getTag (optional) names WHICH engine view the slot wants — the multi-tab
  // browser's active tab id. It rides on every bounds report, so a tab switch
  // (which changes no DOM size, so no observer fires) is one refresh() call
  // away, and the host always knows the rect AND its target atomically.
  function liveSlot(name, element, getTag) {
    var noop = { detach: function () {} };
    if (!IN_VIEW || !VIEW.liveAttach) {
      console.error('[pi-sdk] liveSlot needs a native view container (a desktop panel hosted in a WebContentsView).');
      return noop;
    }
    if (!element) {
      console.error('[pi-sdk] liveSlot: element is required.');
      return noop;
    }

    var stopped = false;
    var lastKey = null;
    var observer = null;

    function tagOf() {
      try { return getTag ? String(getTag() || '') : ''; } catch (e) { return ''; }
    }

    function report() {
      if (stopped) return;
      var rect = element.getBoundingClientRect();
      var bounds = {
        x: Math.round(rect.x + (window.scrollX || 0)),
        y: Math.round(rect.y + (window.scrollY || 0)),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
      // Report even when degenerate: 0×0 is the "hide the view" signal — a
      // display:none slot must not leave a stale engine rectangle up there,
      // invisibly eating real mouse clicks. The tag is part of the key: a tab
      // switch keeps the rect but must still re-report.
      var key = bounds.x + ',' + bounds.y + ',' + bounds.width + ',' + bounds.height + ',' + tagOf();
      if (key === lastKey) return;
      lastKey = key;
      VIEW.liveBounds(name, bounds, tagOf()).then(function (res) {
        if (res && res.ok === false) {
          console.error('[pi-sdk] live slot "' + name + '" rejected by host: ' + (res.error || 'unknown reason'));
        }
      }).catch(function (e) { console.error('[pi-sdk] live slot bounds failed:', e); });
    }

    // No debounce: ResizeObserver already batches to layout frames and the
    // lastKey check dedups reports. A trailing debounce made the engine view
    // trail a panel drag by 50ms steps — the resize looked choppy instead of
    // tracking the pointer. No feedback loop exists: the engine view lives
    // outside this page's DOM, so repositioning it never re-fires the observer.

    VIEW.liveAttach(name).then(function (res) {
      if (res && res.ok === false) {
        // The host refused — say why (no browser permission, slot name
        // colliding with a panel id, plugin disabled…), loudly.
        console.error('[pi-sdk] live slot "' + name + '" not available: ' + (res.error || 'unknown reason'));
      }
    }).catch(function (e) { console.error('[pi-sdk] live slot attach failed:', e); });

    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(report);
      observer.observe(element);
    }
    window.addEventListener('resize', report);

    return {
      detach: function () {
        stopped = true;
        if (observer) { observer.disconnect(); observer = null; }
        window.removeEventListener('resize', report);
        lastKey = null;
        VIEW.liveDetach(name).catch(function () {});
      },
      // Re-report immediately (bounds + current tag). The switch-tabs case:
      // DOM size unchanged, so no observer fires — refresh() is the signal.
      refresh: function () {
        lastKey = null;
        report();
      }
    };
  }

  window.piSDK = {
    pluginId: PLUGIN_ID,
    request: request,
    emit: emit,
    liveSlot: liveSlot,
    // The workspace this panel is showing (absolute path), or null. Read it on
    // demand; subscribe with onWorkspace to react to a workspace switch.
    get workspace() {
      return workspaceId;
    },
    onWorkspace: function (cb) {
      if (workspaceHandlers.indexOf(cb) < 0) workspaceHandlers.push(cb);
      // Replay: the mount report usually lands before the page subscribes.
      cb(workspaceId);
    },
    onMessage: function (cb) {
      if (handlers.indexOf(cb) < 0) handlers.push(cb);
    },
    // Native popup menu with custom items (OS-level — floats above engine
    // views). Native views only; resolves the clicked item id or null.
    showPopupMenu: function (items, x, y) {
      if (!IN_VIEW || !VIEW.showPopupMenu) {
        console.error('[pi-sdk] showPopupMenu needs a native view container (a desktop panel hosted in a WebContentsView).');
        return Promise.resolve(null);
      }
      return VIEW.showPopupMenu(items, x, y);
    },
    // Automated-test seam: resolve the popup choice without the OS menu.
    __setPopupMenuOverride: function (fn) {
      if (VIEW && VIEW.__setPopupMenuOverride) VIEW.__setPopupMenuOverride(fn);
    }
  };
})();
`;
