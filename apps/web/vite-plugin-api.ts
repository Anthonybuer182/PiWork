/**
 * Vite plugin that embeds a backend API server handling pi-coding-agent SDK calls.
 * This eliminates the need for a separate backend process during development.
 */
import type { Plugin, ViteDevServer } from 'vite';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';

function openNativeFolderPicker(): string | null {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const script = 'choose folder with prompt "Select workspace folder"';
      const result = execSync(`osascript -e 'POSIX path of (${script})'`, {
        encoding: 'utf-8',
        timeout: 60_000,
      });
      const path = result.trim();
      return path && existsSync(path) ? path : null;
    }
    if (platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Select workspace folder"
        if ($dialog.ShowDialog() -eq "OK") { $dialog.SelectedPath }
      `;
      const result = execSync(
        `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 60_000 },
      );
      const path = result.trim();
      return path && existsSync(path) ? path : null;
    }
    // Linux
    try {
      const result = execSync('zenity --file-selection --directory --title="Select workspace folder" 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 60_000,
      });
      const path = result.trim();
      return path && existsSync(path) ? path : null;
    } catch {
      // zenity not available, try kdialog
      try {
        const result = execSync('kdialog --getexistingdirectory 2>/dev/null', {
          encoding: 'utf-8',
          timeout: 60_000,
        });
        const path = result.trim();
        return path && existsSync(path) ? path : null;
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

function setupApiRoutes(server: ViteDevServer): void {
  server.middlewares.use(async (req, res, next) => {
    // Handle streaming chat endpoint
    if (req.method === 'POST' && req.url?.startsWith('/api/chat/stream')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          await loadAdapters(server);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const { method, params } = body;

          // SSE headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.flushHeaders();

          const sendSSE = (data: unknown) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          try {
            if (method === 'chat.sendMessageStream') {
              await chatService.sendMessageStream(params, (chunk) => {
                sendSSE(chunk);
              });
              // Close stream cleanly after the adapter finishes
              if (!res.writableEnded) {
                sendSSE({ type: 'done' });
                res.end();
              }
            } else {
              sendSSE({ type: 'error', error: `Unknown streaming method: ${method}` });
              res.end();
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            if (!res.writableEnded) {
              sendSSE({ type: 'error', error: message });
              res.end();
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Parse error';
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: message }));
        }
      });
      req.on('error', (err) => {
        console.error('[pi-api] SSE error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }

    // File download endpoint (web fallback for "open with system app")
    if (req.method === 'GET' && req.url?.startsWith('/api/file/download')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        const workspaceId = url.searchParams.get('workspaceId');
        const filePath = url.searchParams.get('path');
        if (!workspaceId || !filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing workspaceId or path' }));
          return;
        }
        await loadAdapters(server);
        const fileBuffer = readFileSync(filePath);
        const fileName = filePath.split(/[/\\]/).pop() ?? 'download';
        const ext = extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.pdf': 'application/pdf',
        };
        const contentType = mimeTypes[ext] ?? 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          'Content-Length': fileBuffer.length,
        });
        res.end(fileBuffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Download error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // Regular non-streaming API
    if (req.method !== 'POST' || !req.url?.startsWith('/api/request')) {
      return next();
    }

    const reqChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => reqChunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(reqChunks).toString());
        const { id, method, params } = body;

        const result = await handleRequest(server, method, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, result }));
      } catch (err) {
        console.error('[pi-api] Error:', err);
        let reqId = 'unknown';
        try {
          reqId = JSON.parse(Buffer.concat(reqChunks).toString()).id || 'unknown';
        } catch {}
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: reqId, error: { code: -1, message } }));
      }
    });
    req.on('error', (err) => {
      console.error('[pi-api] Req error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -1, message: err.message } }));
      }
    });
  });
}

let adaptersModule: any = null;
let workspaceService: any;
let sessionService: any;
let chatService: any;
let fileService: any;
let configService: any;

async function loadAdapters(server: ViteDevServer) {
  adaptersModule = await server.ssrLoadModule('@pi/sdk-wrapper/adapters');

  const cwd = process.cwd();

  // Shared SettingsManager so shell path configuration is consistent.
  // Dynamic SSR import avoids adding @earendil-works/pi-coding-agent as a web dependency.
  const sdkModule = await server.ssrLoadModule('@earendil-works/pi-coding-agent');
  const settingsManager = sdkModule.SettingsManager.create(cwd);

  workspaceService = adaptersModule.createRealWorkspaceService();
  sessionService = adaptersModule.createRealSessionService();
  chatService = adaptersModule.createRealChatService(cwd, undefined, settingsManager);
  fileService = adaptersModule.createRealFileService();
  configService = adaptersModule.createRealConfigService(cwd, undefined, undefined, settingsManager);
}

async function handleRequest(server: ViteDevServer, method: string, params: any): Promise<any> {
  await loadAdapters(server);

  const [service, action] = method.split('.');
  if (!service || !action) {
    throw new Error(`Invalid method format: ${method}`);
  }

  switch (service) {
    case 'workspace':
      switch (action) {
        case 'list': return workspaceService.list();
        case 'get': return workspaceService.get(params.id);
        case 'create': return workspaceService.create(params.name, params.path);
        case 'delete': return workspaceService.delete(params.id);
        case 'update': return workspaceService.update(params.id, params.data);
      }
      break;

    case 'session':
      switch (action) {
        case 'list': return sessionService.list(params.workspaceId);
        case 'get': return sessionService.get(params.id);
        case 'create': return sessionService.create(params.workspaceId, params.title);
        case 'delete': return sessionService.delete(params.id);
        case 'updateTitle': return sessionService.updateTitle(params.id, params.title);
        case 'getTree': return sessionService.getTree(params.id);
        case 'fork':
          if (chatService.isSessionBusy?.(params.sourceId)) {
            throw new Error('当前对话正在运行，结束后再创建分支');
          }
          return sessionService.fork(params.sourceId, params.throughEntryId, params.title);
      }
      break;

    case 'chat':
      switch (action) {
        case 'sendMessage': return chatService.sendMessage(params);
        case 'getMessages': return chatService.getMessages(params.sessionId, params.limit, params.offset);
        case 'stopGeneration': return chatService.stopGeneration(params.sessionId);
        case 'steer': return chatService.steer(params.sessionId, params.content, params.images);
        case 'followUp': return chatService.followUp(params.sessionId, params.content, params.images);
        case 'navigateTree': return chatService.navigateTree(params.sessionId, params.entryId, params.options);
        case 'switchBranch': return chatService.switchBranch(params.sessionId, params.entryId);
        case 'compact': return chatService.compact(params.sessionId, params.customInstructions);
        // Agent context. Settings → 上下文 renders here too — these routes
        // must stay in step with ipc/index.ts's handleChat, and nothing
        // enforces that, so they are the pair to check first when a page works
        // on desktop and not on web.
        case 'getAgentContextConfig': return chatService.getAgentContextConfig(params.workspacePath, params.workspaceId);
        case 'reloadAgentContext': return chatService.reloadAgentContext(params.workspacePath);
        case 'getGlobalContextInfo': return chatService.getGlobalContextInfo();
        case 'reloadAgentContextForFile': return chatService.reloadAgentContextForFile(params.filePath, params.preferredWorkspace);
        case 'writeContextFile': return chatService.writeContextFile(params);
        case 'deleteContextFile': return chatService.deleteContextFile(params);
      }
      break;

    case 'file':
      switch (action) {
        case 'read': return fileService.read(params.workspaceId, params.path);
        case 'list': return fileService.list(params.workspaceId, params.directory ?? params.dirPath);
        case 'write': return fileService.write(params.workspaceId, params.path, params.content);
        case 'delete': return fileService.delete(params.workspaceId, params.path);
        case 'readOffice': return fileService.readOffice(params.workspaceId, params.path);
        case 'search': return fileService.search(params.workspaceId, params.query, params.options);
        case 'cancelSearch': return fileService.cancelSearch(params.searchId);
      }
      break;

    case 'config':
      switch (action) {
        case 'get': return configService.get();
        case 'update': return configService.update(params.data);
        case 'listModels': return configService.listModels();
        case 'listSkills': return configService.listSkills();
        case 'getSkillPaths': return configService.getSkillPaths();
        case 'setSkillPaths': return configService.setSkillPaths(params.paths as string[]);
        case 'getModelsConfig': return configService.getModelsConfig();
        case 'saveModelsConfig': return configService.saveModelsConfig(params.config);
        case 'upsertProvider': return configService.upsertProvider(params.name as string, params.provider as any);
        case 'listRemoteModels':
          return configService.listRemoteModels(
            params as { baseUrl: string; api: string; apiKey: string },
          );
        case 'saveProvider':
          return configService.saveProvider(
            (params.originalName as string | null) ?? null,
            params.name as string,
            params.provider as any,
          );
        case 'deleteProvider': return configService.deleteProvider(params.name as string);
        case 'addModel': return configService.addModel(params.providerName as string, params.model as any);
        case 'deleteModel': return configService.deleteModel(params.providerName as string, params.modelId as string);
        case 'updateModel': return configService.updateModel(params.providerName as string, params.modelId as string, params.model as any);
      }
      break;

    case 'system':
      switch (action) {
        case 'selectDirectory': return openNativeFolderPicker();
      }
      break;

    default:
      throw new Error(`Unknown service: ${service}`);
  }

  throw new Error(`Unknown action: ${service}.${action}`);
}

export function apiPlugin(): Plugin {
  return {
    name: 'pi-api-backend',
    configureServer(server) {
      setupApiRoutes(server);
    },
  };
}
