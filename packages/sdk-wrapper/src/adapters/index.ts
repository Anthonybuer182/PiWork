import { createRealWorkspaceService } from './workspace.js';
import { createRealSessionService } from './session.js';
import { createRealChatService } from './chat.js';
import { createRealFileService } from './file.js';
import { createRealConfigService } from './config.js';

export {
  createRealWorkspaceService,
  createRealSessionService,
  createRealChatService,
  createRealFileService,
  createRealConfigService,
};

export type { PluginDoc, RealChatServiceOptions, McpChatOptions, RunSettledInfo } from './chat.js';
export { formatPluginDocsForPrompt } from './chat.js';

// Model runtime plumbing (pi 1.x): the host creates one runtime at startup and
// hands it to every adapter; these let it share that instance process-wide.
export { getSharedModelRuntime, setSharedModelRuntime, createModelRegistry } from './model-runtime.js';

// Node-only helpers. Exported from the adapters entry rather than the package
// root because they import `node:fs` — the root entry is what the renderer
// bundles, so a filesystem module there would break the browser build.
export { deleteFileWithMtimeGuard, writeFileWithMtimeGuard } from '../utils/safe-write.js';
export type { DeleteResult, WriteResult } from '../utils/safe-write.js';
