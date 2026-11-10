/**
 * Regression: a navigation that fails must say why, and a page that rendered
 * late must not be called a failure.
 *
 * The embedded browser inherits the app's network proxy. When that proxy is
 * down or half-working, Chromium knows the reason in milliseconds — but the
 * old code polled `document.readyState` for 30s and then reported every case
 * as "Page load timed out". One real session spent 30.5s there and then read
 * the fully rendered Baidu page 55ms later.
 *
 * These tests pin the pure helpers the manager now uses to tell those two
 * situations apart (apps/desktop/src/main/browser/navigation.ts).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAbortedNavigation,
  isDocumentUsable,
  navigationFailureMessage,
  navigationTimeoutMessage,
  netErrorOf,
  proxyOf,
} from '../src/main/browser/navigation.ts';

const BAIDU = 'https://www.baidu.com/';

test('redirect aborts are not failures; everything else is', () => {
  assert.equal(isAbortedNavigation(-3), true);
  assert.equal(isAbortedNavigation(-130), false);
  assert.equal(isAbortedNavigation(-105), false);
  assert.equal(isAbortedNavigation(null), false);
});

test('the proxy Chromium resolves is named, so the message can point at it', () => {
  assert.equal(proxyOf('PROXY 127.0.0.1:3213'), '127.0.0.1:3213');
  // Ranked list: the first usable entry is the one that would be used.
  assert.equal(proxyOf('PROXY 127.0.0.1:3213; DIRECT'), '127.0.0.1:3213');
  assert.equal(proxyOf('DIRECT'), null);
  assert.equal(proxyOf('DIRECT; PROXY 127.0.0.1:3213'), null);
  assert.equal(proxyOf('SOCKS5 127.0.0.1:7891'), 'socks5://127.0.0.1:7891');
  assert.equal(proxyOf(undefined), null);
});

test('a failed navigation carries the net error, the url and the proxy', () => {
  const message = navigationFailureMessage({
    code: -130,
    netError: 'ERR_PROXY_CONNECTION_FAILED',
    url: BAIDU,
    proxyRule: 'PROXY 127.0.0.1:3213',
  });
  assert.equal(
    message,
    `Navigation failed: ERR_PROXY_CONNECTION_FAILED (-130) loading '${BAIDU}' via proxy 127.0.0.1:3213`,
  );
});

test('a failure without a proxy stays honest about that', () => {
  const message = navigationFailureMessage({
    code: -105,
    netError: 'ERR_NAME_NOT_RESOLVED',
    url: BAIDU,
    proxyRule: 'DIRECT',
  });
  assert.equal(message, `Navigation failed: ERR_NAME_NOT_RESOLVED (-105) loading '${BAIDU}'`);
  assert.ok(!message.includes('via proxy'));
});

test('an unnamed failure still says something a reader can act on', () => {
  const message = navigationFailureMessage({ code: null, netError: null, url: BAIDU });
  assert.match(message, /^Navigation failed: ERR_FAILED /);
});

test('the timeout message names the proxy the load was going through', () => {
  const message = navigationTimeoutMessage({
    url: BAIDU,
    proxyRule: 'PROXY 127.0.0.1:3213',
    elapsedMs: 20_000,
  });
  assert.equal(
    message,
    `Navigation timed out after 20s loading '${BAIDU}' via proxy 127.0.0.1:3213`,
  );
});

test('a rendered page on the target host counts as loaded, however late', () => {
  // The observed real case: did-finish-load never arrived, but the document
  // was Baidu's, titled and populated — the agent could have acted on it.
  assert.equal(
    isDocumentUsable(
      {
        readyState: 'loading',
        href: 'https://www.baidu.com/',
        title: '百度一下，你就知道',
        nodes: 12,
      },
      BAIDU,
    ),
    true,
  );
  assert.equal(
    isDocumentUsable(
      { readyState: 'complete', href: BAIDU, title: '', nodes: 0 },
      BAIDU,
    ),
    true,
  );
});

test('a blank, empty or foreign document does not', () => {
  // Nothing committed yet: the old about:blank is still the live document.
  assert.equal(
    isDocumentUsable({ readyState: 'loading', href: 'about:blank', title: '', nodes: 0 }, BAIDU),
    false,
  );
  // Chromium's own error page lives on a different host and proves nothing.
  assert.equal(
    isDocumentUsable(
      { readyState: 'complete', href: 'chrome-error://chromewebdata/', title: '', nodes: 4 },
      BAIDU,
    ),
    false,
  );
  // A still-loading document with no title and no content is not usable yet.
  assert.equal(
    isDocumentUsable({ readyState: 'loading', href: BAIDU, title: '', nodes: 0 }, BAIDU),
    false,
  );
  assert.equal(isDocumentUsable(null, BAIDU), false);
});

test('an Electron loadURL rejection is read back into a net error', () => {
  const err = Object.assign(new Error(`ERR_FAILED (-2) loading '${BAIDU}'`), {
    errno: -2,
    code: 'ERR_FAILED',
  });
  assert.deepEqual(netErrorOf(err), { code: -2, name: 'ERR_FAILED' });

  const proxyErr = Object.assign(new Error(`ERR_PROXY_CONNECTION_FAILED (-130) loading '${BAIDU}'`), {
    errno: -130,
    code: 'ERR_PROXY_CONNECTION_FAILED',
  });
  assert.deepEqual(netErrorOf(proxyErr), { code: -130, name: 'ERR_PROXY_CONNECTION_FAILED' });

  // Only the message available (older Electron): the name still parses.
  assert.deepEqual(netErrorOf(new Error(`ERR_CONNECTION_REFUSED (-102) loading '${BAIDU}'`)), {
    code: null,
    name: 'ERR_CONNECTION_REFUSED',
  });
  assert.deepEqual(netErrorOf(new Error('something else')), { code: null, name: null });
});
