#!/usr/bin/env node
/**
 * Make a development run show the product's name in the macOS Dock.
 *
 * The Dock tooltip (and the app-menu title macOS derives from the same place)
 * comes from the *bundle being executed* — and a dev run executes Electron.app.
 * `app.setName()` fixes the menu bar and the userData directory, but it cannot
 * rename the bundle, so the tooltip keeps saying "Electron" no matter what.
 *
 * So clone the installed Electron.app, rename it in its Info.plist, drop in
 * our own icon, and run that instead. The clone is copy-on-write on APFS, so
 * it costs a directory entry rather than a second Electron download.
 *
 * electron-vite honours ELECTRON_EXEC_PATH, which is how scripts/dev.mjs points
 * a dev run here. Packaged builds need none of this: electron-builder writes
 * the name into the bundle itself.
 *
 * macOS only; returns null everywhere else (and on any failure — a dev run
 * that says "Electron" is better than one that refuses to start).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, '.dev-app');
const STAMP = path.join(OUT_DIR, '.stamp');
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** A top-level scalar from electron-builder.yml — the one place it is written down. */
function configValue(key) {
  const yml = fs.readFileSync(path.join(APP_ROOT, 'electron-builder.yml'), 'utf8');
  const match = yml.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
  if (!match) throw new Error(`electron-builder.yml has no ${key}`);
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/** Rewrite a key that may not exist yet. */
function setPlistKey(plist, key, value) {
  try {
    execFileSync(PLIST_BUDDY, ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' });
  } catch {
    execFileSync(PLIST_BUDDY, ['-c', `Add :${key} string ${value}`, plist], { stdio: 'ignore' });
  }
}

/**
 * @returns {string | null} path to the branded Electron executable, or null
 * when the current platform or setup cannot use one.
 */
function brand() {
  if (process.platform !== 'darwin') return null;

  try {
    const pkgDir = path.dirname(require.resolve('electron'));
    const version = require(path.join(pkgDir, 'package.json')).version;
    const name = configValue('productName');
    // The clone must NOT keep Electron's `com.github.Electron` identity: the
    // Dock keys its tile by bundle id, so it would keep showing the tile it
    // cached for the real Electron.app — name and all. A `.dev` suffix also
    // keeps development runs' TCC grants separate from the installed app's.
    const bundleId = `${configValue('appId')}.dev`;

    // `Electron.app/Contents/MacOS/Electron` — the same relative path the
    // electron package resolves its own binary through.
    const execRel = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
    const sourceBundle = execRel.split('/Contents/')[0];

    // Everything below is renamed, not just relabelled. The Dock takes a
    // running app's tooltip from its Launch Services record, which is cached
    // per *path* — a clone that is still `Electron.app/Contents/MacOS/Electron`
    // keeps resolving to the record macOS already had for Electron, whatever
    // CFBundleName says. A new directory name, executable name and identifier
    // make it a genuinely different bundle.
    const bundleName = `${name}.app`;
    const bundle = path.join(OUT_DIR, bundleName);
    const execPath = path.join(bundle, 'Contents', 'MacOS', name);
    const stamp = `${version} ${name} ${bundleId}`;
    if (fs.existsSync(execPath) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === stamp) {
      return execPath;
    }

    // Stale clone (Electron upgraded, or the product was renamed) — start over.
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const source = path.join(pkgDir, 'dist', sourceBundle);
    try {
      // -c = APFS clonefile; falls back to a real copy on other filesystems.
      execFileSync('cp', ['-Rc', source, bundle], { stdio: 'ignore' });
    } catch {
      execFileSync('ditto', [source, bundle], { stdio: 'ignore' });
    }

    // CFBundleExecutable must name the binary that actually sits in MacOS/.
    const oldExec = path.join(bundle, 'Contents', 'MacOS', path.basename(execRel));
    fs.renameSync(oldExec, execPath);

    const plist = path.join(bundle, 'Contents', 'Info.plist');
    setPlistKey(plist, 'CFBundleName', name);
    setPlistKey(plist, 'CFBundleDisplayName', name);
    setPlistKey(plist, 'CFBundleIdentifier', bundleId);
    setPlistKey(plist, 'CFBundleExecutable', name);

    // The Dock icon is set at runtime too (app.dock.setIcon), but the bundle
    // should not advertise Electron's icon either.
    const icon = path.join(APP_ROOT, 'build', 'icon.icns');
    const bundleIcon = path.join(bundle, 'Contents', 'Resources', 'electron.icns');
    if (fs.existsSync(icon) && fs.existsSync(bundleIcon)) fs.copyFileSync(icon, bundleIcon);

    // Drop whatever Launch Services cached for this path, then register the
    // bundle as it now stands.
    try {
      execFileSync(LSREGISTER, ['-f', bundle], { stdio: 'ignore' });
    } catch {
      /* registration happens on launch anyway */
    }

    fs.writeFileSync(STAMP, stamp, 'utf8');
    return execPath;
  } catch (err) {
    console.warn(`[brand-dev-app] skipped (${err.message}) — the Dock will say "Electron"`);
    return null;
  }
}

module.exports = { brand };

if (require.main === module) {
  const execPath = brand();
  if (execPath) console.log(`[brand-dev-app] ${execPath}`);
}
