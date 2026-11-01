#!/usr/bin/env node
/**
 * afterPack: keep only the target platform's sherpa-onnx addon.
 *
 * pnpm installs every platform package because the workspace pins
 * `supportedArchitectures` for cross-building. Shipping all of them would add
 * ~150 MB of foreign binaries; more importantly, a missing target package only
 * shows up as a crash when the user first presses the microphone. So this hook
 * deletes the others and asserts the target pair exists.
 */

const fs = require('fs');
const path = require('path');

const PLATFORM = { darwin: 'darwin', win32: 'win', linux: 'linux', mas: 'darwin' };
const PLATFORM_ALIAS = { mac: 'darwin', windows: 'win32', linux: 'linux' };
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function resolvePlatform(context) {
  const fromElectron = PLATFORM[context.electronPlatformName];
  if (fromElectron) return fromElectron;
  const packagerName = context.packager?.platform?.name;
  const aliased = packagerName ? PLATFORM_ALIAS[packagerName] : undefined;
  return aliased ? PLATFORM[aliased] : undefined;
}

function resolveArch(context) {
  if (typeof context.arch === 'string') return context.arch;
  if (typeof context.arch === 'number') return ARCH[context.arch];
  const match = /(arm64|x64|ia32|universal)/.exec(path.basename(context.appOutDir ?? ''));
  if (match) return match[1];
  return process.arch;
}

module.exports = async function pruneSherpa(context) {
  const platform = resolvePlatform(context);
  const arch = resolveArch(context);
  if (!platform || !arch) return;

  const target = `sherpa-onnx-${platform}-${arch}`;
  // mac: <appOutDir>/<Product>.app/Contents/Resources
  // win/linux: <appOutDir>/resources
  const appName = context.packager?.appInfo?.productFilename;
  const candidates = [
    appName
      ? path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
      : null,
    path.join(context.appOutDir, 'Contents', 'Resources'),
    path.join(context.appOutDir, 'resources'),
  ].filter(Boolean);
  const resources = candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
  const roots = [
    path.join(resources, 'app.asar.unpacked', 'node_modules'),
    path.join(resources, 'app', 'node_modules'),
  ].filter((dir) => fs.existsSync(dir));

  let found = false;
  for (const root of roots) {
    const entries = fs.readdirSync(root);
    // Directly nested (npm layout).
    for (const entry of entries) {
      if (entry !== 'sherpa-onnx-node' && entry.startsWith('sherpa-onnx-')) {
        if (entry !== target) {
          fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        } else {
          found = true;
        }
      }
    }
    // pnpm layout: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>
    const pnpmDir = path.join(root, '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      for (const entry of fs.readdirSync(pnpmDir)) {
        if (!entry.startsWith('sherpa-onnx-')) continue;
        const name = entry.split('@')[0];
        const pkgDir = path.join(pnpmDir, entry, 'node_modules', name);
        if (!fs.existsSync(pkgDir)) continue;
        if (name !== target && name !== 'sherpa-onnx-node') {
          fs.rmSync(pkgDir, { recursive: true, force: true });
        } else if (name === target) {
          found = true;
        }
      }
    }
  }

  if (!found) {
    console.log(
      `[prune-sherpa] platform=${context.electronPlatformName} arch=${String(context.arch)} target=${target}`,
    );
    for (const root of roots) console.log(`[prune-sherpa] ${root}: ${fs.readdirSync(root).filter((e) => e.startsWith('sherpa')).join(', ')}`);
    throw new Error(
      `[prune-sherpa] missing ${target}; built-in voice recognition would fail at runtime`,
    );
  }

  const addon = path.join(
    path.join(resources, 'app.asar.unpacked', 'node_modules'),
    target,
    'sherpa-onnx.node',
  );
  if (!fs.existsSync(addon)) {
    throw new Error(`[prune-sherpa] missing ${addon}`);
  }
};
