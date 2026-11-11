#!/usr/bin/env node
/**
 * afterPack: the last chance to shape the app directory before the installer
 * is built. Three jobs, all of them "fix what the packager got wrong":
 *
 * 1. Keep only the target platform's sherpa-onnx addon — see prune-sherpa.cjs.
 *
 * 2. **macOS only:** ad-hoc sign the bundle — see adhoc-sign-mac.cjs. Without
 *    a Developer ID the app ships unsigned, and a downloaded (quarantined)
 *    copy is reported as "已损坏" by Gatekeeper instead of the standard
 *    "无法验证开发者" prompt the user can bypass.
 *
 * 3. **Windows only:** copy the bundled plugin market into
 *    `<app>/resources/market/` ourselves.
 *
 * Why (2) exists instead of `extraResources`: electron-builder's copy of the
 * 21 MB `com.pi.files` zip fails on the Windows runners with
 * `EBUSY: resource busy or locked`. It is reproducible through retries, with
 * the source hashed as readable seconds earlier and the workspace excluded
 * from Defender — so it is the CopyFileEx path itself, not a scanner holding
 * the file. Reading the bytes and writing them out uses different Windows APIs
 * and does not hit it; the retry loop covers the genuinely transient case.
 *
 * The market is therefore NOT listed under `win.extraResources` (that list
 * overrides the top-level one). mac/linux still use the top-level entry.
 */
const fs = require('node:fs');
const path = require('node:path');

const pruneSherpa = require('./prune-sherpa.cjs');
const adhocSignMac = require('./adhoc-sign-mac.cjs');

const ATTEMPTS = 5;
/** ms between attempts; grows linearly so a slow scanner has time to let go. */
const RETRY_DELAY = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Copy `from` into `to` byte-for-byte, verifying the size that landed.
 *
 * `writeFileSync(buf)` rather than `copyFileSync`: see the header comment.
 */
async function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(to, name);

    let lastError;
    let done = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !done; attempt++) {
      try {
        const buf = fs.readFileSync(src);
        fs.writeFileSync(dst, buf);
        const written = fs.statSync(dst).size;
        if (written !== buf.length) throw new Error(`short write (${written}/${buf.length} bytes)`);
        done = true;
      } catch (err) {
        lastError = err;
        console.warn(`[after-pack] copy ${name} attempt ${attempt} failed: ${err.message}`);
        if (attempt < ATTEMPTS) await sleep(RETRY_DELAY * attempt);
      }
    }
    if (!done) throw new Error(`[after-pack] could not copy ${name}: ${lastError?.message}`);
    console.log(`[after-pack] market: ${name} (${Math.round(fs.statSync(dst).size / 1024)} KB)`);
  }
}

module.exports = async function afterPack(context) {
  await pruneSherpa(context);
  adhocSignMac(context);

  if (process.platform !== 'win32') return;

  const from = path.join(__dirname, '..', 'market-dist');
  const to = path.join(context.appOutDir, 'resources', 'market');

  if (!fs.existsSync(path.join(from, 'index.json'))) {
    throw new Error(`[after-pack] no plugin market at ${from} — run scripts/ci-build-market.mjs first`);
  }

  await copyDir(from, to);

  if (!fs.existsSync(path.join(to, 'index.json'))) {
    throw new Error('[after-pack] market index is missing from the packaged app');
  }
};
