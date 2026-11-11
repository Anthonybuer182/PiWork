#!/usr/bin/env node
/**
 * afterPack: give the macOS bundle a valid ad-hoc signature.
 *
 * Why this exists: the pipeline has no Developer ID (`mac.identity: null`), so
 * electron-builder ships the app completely unsigned. The .app then has no
 * `Contents/_CodeSignature`, and its main binary keeps only the linker-embedded
 * ad-hoc signature from the Electron release. Locally that runs fine, but once
 * the file is downloaded it carries `com.apple.quarantine`, Gatekeeper assesses
 * the unsigned bundle and macOS reports:
 *
 *   "PiWork" 已损坏，无法打开。你应该将它移到废纸篓。
 *
 * which is wrong ("damaged") and unhelpful — there is nothing wrong with the
 * bytes, the bundle just has no signature to evaluate. An ad-hoc signature
 * (`codesign --sign -`) seals the bundle, after which Gatekeeper can make a
 * normal "not notarized" call: the user can then allow the app from
 * 系统设置 → 隐私与安全性 → 仍要打开 instead of being told it is corrupted.
 *
 * This does NOT replace Developer ID + notarization: a downloaded app will
 * still prompt once. It only turns an unfixable "damaged" dialog into the
 * standard, bypassable one.
 *
 * Ordering: afterPack runs right after the app directory is assembled and
 * before electron-builder would sign. We sign here so the DMG/zip targets pick
 * up the signed bundle. If a real identity is configured, electron-builder
 * re-signs afterwards with entitlements — our ad-hoc pass is simply replaced,
 * so this hook is safe to leave enabled when a Developer ID is added later.
 *
 * Note: `electronFuses` is not configured in electron-builder.yml. Fuses are
 * flipped *after* afterPack and would invalidate this signature, so revisit
 * this hook if fuses are ever enabled.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Run codesign, streaming its output so failures are visible in CI logs. */
function codesign(args) {
  return spawnSync('codesign', args, { encoding: 'utf8' });
}

module.exports = function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return false;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] app bundle not found: ${appPath}`);
  }

  // A configured identity means electron-builder signs later with a real
  // certificate; signing ad-hoc first would only be replaced.
  const macOptions = context.packager.platformSpecificBuildOptions ?? {};
  if (typeof macOptions.identity === 'string' && macOptions.identity.length > 0) {
    console.log(`[adhoc-sign] skipping — identity "${macOptions.identity}" is configured`);
    return false;
  }

  console.log(`[adhoc-sign] signing ${appPath} (ad-hoc)`);
  const signed = codesign(['--force', '--deep', '--sign', '-', appPath]);
  if (signed.stdout) process.stdout.write(signed.stdout);
  if (signed.stderr) process.stderr.write(signed.stderr);
  if (signed.status !== 0) {
    throw new Error(`[adhoc-sign] codesign failed with exit code ${signed.status}`);
  }

  const verified = codesign(['--verify', '--deep', '--strict', appPath]);
  if (verified.stdout) process.stdout.write(verified.stdout);
  if (verified.stderr) process.stderr.write(verified.stderr);
  if (verified.status !== 0) {
    throw new Error(`[adhoc-sign] signature did not verify (exit code ${verified.status})`);
  }

  console.log('[adhoc-sign] bundle signature verified');
  return true;
};
