export { UpdateService } from './service';
export type { UpdateServiceOptions } from './service';
export { registerUpdateIpc } from './ipc';
export {
  compareVersions,
  isSupportedPlatform,
  normalizeVersion,
  parseDigest,
  parseVersion,
  pickAsset,
  toUpdateAsset,
} from './release';
export type { ReleaseAssetLike, UpdatePlatform } from './release';
