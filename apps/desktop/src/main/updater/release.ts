/**
 * The parts of an update check that are pure — version comparison and picking
 * the right asset out of a release. Kept away from Electron and fetch so the
 * decisions that can silently be wrong (arm64 vs x64, dmg vs zip) are testable.
 */

import type { UpdateAsset } from '@pi/types';

/** The slice of GitHub's release-asset JSON this app reads. */
export interface ReleaseAssetLike {
  name: string;
  browser_download_url: string;
  size?: number;
  /** `sha256:<hex>` in GitHub's format; null/absent on older releases. */
  digest?: string | null;
}

export interface ParsedVersion {
  nums: [number, number, number];
  /** Pre-release suffix, e.g. `beta.1`; null for a final release. */
  pre: string | null;
}

/**
 * Read `v1.2.3`, `1.2.3-beta.1` and similar. Anything without a full
 * `major.minor.patch` is not a version we can compare.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = /^[\s=v]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? null,
  };
}

/** Strip a leading `v` from a release tag; other tags are returned trimmed. */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * Semver ordering for the versions this app sees. Returns 0 when either side
 * is unparseable: an unrecognisable upstream tag must not be reported as an
 * update, because the download would be offered for nothing.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  // A pre-release sorts below its final release (1.0.0-beta < 1.0.0).
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export type UpdatePlatform = 'darwin' | 'win32' | 'linux';

const PLATFORM_EXTENSIONS: Record<UpdatePlatform, string[]> = {
  darwin: ['.dmg', '.zip'],
  win32: ['.exe', '.msi'],
  linux: ['.appimage', '.deb'],
};

const ARCH_TOKENS: Record<string, string[]> = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'x86_64', 'x86-64', 'amd64'],
  // Deliberately not plain `x86`: it is a substring of `x86_64`, and treating
  // an x86_64 asset as the wrong architecture would hide the Linux build.
  ia32: ['ia32', 'i386', 'i686'],
};

function archTokens(arch: string): { own: string[]; others: string[] } {
  const own = ARCH_TOKENS[arch] ?? [arch.toLowerCase()];
  const others = Object.entries(ARCH_TOKENS)
    .filter(([name]) => name !== arch)
    .flatMap(([, tokens]) => tokens);
  return { own, others };
}

/**
 * The best asset for this platform and architecture, or null.
 *
 * Ranking, in order: the preferred package format (dmg before zip, AppImage
 * before deb), then an explicit arch match over an arch-agnostic name, and
 * never an asset that names a different architecture. The last rule is the
 * one that matters on Apple Silicon: `...-0.2.0.dmg` and `...-0.2.0-arm64.dmg`
 * sit next to each other and only the name tells them apart.
 */
export function pickAsset(
  assets: readonly ReleaseAssetLike[],
  platform: UpdatePlatform,
  arch: string,
): ReleaseAssetLike | null {
  const extensions = PLATFORM_EXTENSIONS[platform];
  if (!extensions) return null;
  const { own, others } = archTokens(arch);

  let best: { asset: ReleaseAssetLike; score: number } | null = null;

  for (const asset of assets) {
    const name = asset.name.toLowerCase();
    const extRank = extensions.findIndex((ext) => name.endsWith(ext));
    if (extRank < 0) continue;

    if (others.some((token) => name.includes(token))) continue;

    const ownRank = own.some((token) => name.includes(token)) ? 0 : 1;
    const score = extRank * 10 + ownRank;
    if (!best || score < best.score) best = { asset, score };
  }

  return best?.asset ?? null;
}

/** `sha256:<hex>` → `<hex>`; anything else is treated as "no digest". */
export function parseDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return m ? m[1].toLowerCase() : null;
}

export function toUpdateAsset(asset: ReleaseAssetLike): UpdateAsset {
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: typeof asset.size === 'number' ? asset.size : 0,
    sha256: parseDigest(asset.digest),
  };
}

export function isSupportedPlatform(platform: string): platform is UpdatePlatform {
  return platform in PLATFORM_EXTENSIONS;
}
