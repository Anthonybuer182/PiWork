import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyInitialWindowContext } from '@pi/ui';
import '@pi/ui/globals.css';

// Every BrowserWindow is told its workspace/session by main (URL query). Apply
// it before the first render so a second window never flashes the first
// window's conversation on the way in. No-op in the web build.
applyInitialWindowContext();

// ── Content Security Policy ──────────────────────────────────────────
// file:// (packaged) pages get no CSP by default and Electron warns on
// every boot. Inject a meta policy before the app mounts; dev keeps the
// Vite HMR requirements (ws + inline react-refresh preamble).
const isDev = location.protocol !== 'file:';
const csp = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: pi-plugin:",
  "font-src 'self' data:",
  // TTS playback: synthesized audio arrives as bytes and is played from a
  // Blob URL (vendor requests happen in main, so connect-src stays 'self').
  "media-src 'self' blob: data:",
  // Vite HMR (dev) + plugin panel iframes (pi-plugin:// unique origins).
  isDev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
  "frame-src pi-plugin:",
  "worker-src 'self' blob:",
].join('; ');
const meta = document.createElement('meta');
meta.httpEquiv = 'Content-Security-Policy';
meta.content = csp;
document.head.appendChild(meta);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
