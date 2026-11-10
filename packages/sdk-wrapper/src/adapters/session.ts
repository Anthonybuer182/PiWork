import type { Session, SessionWithMessages, Message, ContentBlock, AssistantMessage, SessionTreeNode, SessionTreeResult, TreeNodeToolCall, ToolCallBlock, ToolResultBlock, TokenUsage, PluginMessage, PluginMessageData } from '@pi/types';
import { PLUGIN_MESSAGE_CUSTOM_TYPE, SKILL_REFERENCE_MARKER } from '@pi/types';
import type { SessionService } from '../services/session.js';
import {
  SessionManager,
  type SessionMessageEntry,
  type SessionEntry,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import { existsSync, unlinkSync, statSync } from 'fs';
import * as path from 'path';
import { extractThinkContent } from '../utils/think-parser.js';
import { detectWrittenFiles, getMimeType } from '../utils/file-detection.js';

/**
 * The session list shows a one-line title. Use the first non-empty line of the
 * user's text, not the first 60 characters of the whole prompt: messages may
 * carry appended context (skill references, plugin context) that is not part
 * of what the user wrote.
 */
function titleFromText(text: string): string | undefined {
  const marker = text.lastIndexOf(SKILL_REFERENCE_MARKER);
  const withoutRefs = marker >= 0 ? text.slice(0, marker) : text;
  for (const line of withoutRefs.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Attachment-only sends title themselves by file name. The saved path
    // after `->` is plumbing for the reader, never something a list row
    // should show.
    const nameOnly = trimmed.replace(
      /^\[Attached:\s*(.+?)\s*\([^)]*\)(?:\s*-\s*could not decode)?\]\s*->.*$/,
      '$1',
    );
    return nameOnly.slice(0, 60);
  }
  return undefined;
}

function extractTitleFromMessage(msg: any): string | undefined {
  const content = msg.content;
  if (typeof content === 'string') {
    return titleFromText(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        return titleFromText(String(block.text));
      }
    }
  }
  if (content && typeof content === 'object' && (content as any).text) {
    return titleFromText(String((content as any).text));
  }
  return undefined;
}

// === Conversion: SessionInfo → our Session type ===
function toSession(info: SessionInfo): Session {
  return {
    id: info.path,
    workspaceId: info.cwd,
    title:
      info.name ||
      (info.firstMessage ? titleFromText(info.firstMessage) : undefined) ||
      'Untitled',
    status: 'active',
    messageCount: info.messageCount,
    lastMessageAt: info.modified.toISOString(),
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
  };
}

/** Extract readable text from a content block or array of content blocks.
 *  pi-ai ToolResultMessage.content is (TextContent | ImageContent)[], not a plain string. */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('\n');
  }
  return JSON.stringify(content);
}

// === Conversion: AgentMessage → ContentBlock[] ===
type AgentMessage = SessionMessageEntry['message'];

/**
 * Strip the attachment sections that the composer appends to the prompt before
 * sending, so the displayed user content matches what the user actually typed.
 * Also reconstructs lightweight file blocks (fileName only, no base64 data) so
 * the file preview renders consistently on reload.
 *
 * Composer appends two kinds of sections:
 *  - Text files:   `File: <name>\n```<ext>\n...\n````\n`
 *  - Binary/error: `[Attached: <name> (<type>)]` or `[Attached: <name> (<type>) - could not decode]`
 *
 * Newer sends also append ` -> <workspace-relative path>`: outside files are
 * copied under `.piwork/attachments/`, files already in the workspace are
 * referenced in place. That path is what makes the card previewable after a
 * reload and lets the model open the attachment directly.
 */
function stripAttachmentSections(text: string, cwd?: string): { content: string; files: Array<{ fileName: string; fileSize?: number; workspacePath?: string }> } {
  const files: Array<{ fileName: string; fileSize?: number; workspacePath?: string }> = [];
  let content = text;

  const recordFile = (name: string, savedPath?: string) => {
    const fileName = String(name).trim();
    const entry: { fileName: string; fileSize?: number; workspacePath?: string } = { fileName };
    // Try to resolve the file on disk. The saved-path hint wins (it is what
    // the composer wrote); older messages only carry the file name, so fall
    // back to the attachment folder and then to the workspace root.
    const candidates: string[] = [];
    if (cwd && savedPath) {
      const hinted = String(savedPath).trim();
      candidates.push(path.isAbsolute(hinted) ? hinted : path.resolve(cwd, hinted));
    }
    if (cwd) {
      candidates.push(path.resolve(cwd, '.piwork', 'attachments', fileName));
      candidates.push(path.resolve(cwd, fileName));
    }
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          const stat = statSync(candidate);
          if (stat.isFile()) {
            entry.fileSize = stat.size;
            entry.workspacePath = candidate;
            break;
          }
        }
      } catch { /* file may not exist or not be accessible */ }
    }
    files.push(entry);
  };

  // Text-file sections: `File: <name>\n```...``` ` (optionally followed by
  // ` -> <saved path>` on the closing-fence line).
  content = content.replace(
    /\n*File:\s*(.+?)\n```[\w]*\n[\s\S]*?```(?:\s*->\s*([^\n]+))?/g,
    (_m, name, savedPath) => {
      recordFile(name, savedPath);
      return '';
    },
  );

  // Binary/error placeholders: `[Attached: <name> (<type>)]`
  content = content.replace(
    /\n*\[Attached:\s*(.+?)\s*\([^)]*\)(?:\s*-\s*could not decode)?\](?:\s*->\s*([^\n]+))?/g,
    (_m, name, savedPath) => {
      recordFile(name, savedPath);
      return '';
    },
  );

  return { content: content.trim(), files };
}

/**
 * Strip the quoted-context sections an earlier version of the composer
 * appended to the outgoing prompt, so the displayed user content matches what
 * the user actually typed. The quote feature is gone, but sessions recorded
 * before its removal still contain these sections.
 *
 * Format that was produced:
 *   \n\n--- Quoted Context ---\n
 *   File: <name> | Lines: x-y | Page: z | Slide: n | Sheet: <name>\n
 *   ```<ext>\n<content>\n```  (code-editor source)
 *   — or —
 *   > <content with each line prefixed by "> ">
 *   \n\n<next section>\n
 *   --- End Quoted Context ---
 *
 * IMPORTANT: must be called BEFORE stripAttachmentSections, because the
 * quote header `File: <name> | ...` followed by a code fence would
 * otherwise be matched by the attachment text-file regex.
 */
function stripQuoteSections(text: string, cwd?: string): {
  content: string;
  quotes: Array<{
    content: string;
    fileName: string;
    filePath: string;
    source: string;
    startLine?: number;
    endLine?: number;
    pageNumber?: number;
    slideNumber?: number;
    sheetName?: string;
  }>;
} {
  const quotes: Array<{
    content: string;
    fileName: string;
    filePath: string;
    source: string;
    startLine?: number;
    endLine?: number;
    pageNumber?: number;
    slideNumber?: number;
    sheetName?: string;
  }> = [];

  // Infer QuoteSource from file extension
  const inferSource = (fileName: string, isCodeFence: boolean): string => {
    if (isCodeFence) return 'code-editor';
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      md: 'markdown',
      html: 'html',
      docx: 'docx',
      xlsx: 'xlsx',
      pptx: 'pptx',
      pdf: 'pdf-text',
    };
    return map[ext] ?? 'markdown';
  };

  // Resolve full file path from cwd + fileName
  const resolvePath = (fileName: string): string => {
    if (cwd) {
      const candidate = path.resolve(cwd, fileName);
      try {
        if (existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
    return fileName;
  };

  let content = text;

  content = content.replace(
    /\n*--- Quoted Context ---\n([\s\S]*?)\n--- End Quoted Context ---/g,
    (_m, inner: string) => {
      // Individual quote sections are separated by blank lines (\n\n)
      const sections = inner.split(/\n\n/);
      for (const section of sections) {
        if (!section.trim()) continue;

        // Header is the first line; body is everything after it
        const newlineIdx = section.indexOf('\n');
        if (newlineIdx === -1) continue;
        const headerLine = section.slice(0, newlineIdx);
        const body = section.slice(newlineIdx + 1);

        // Parse header: "File: name | Lines: 1-10 | Page: 3 | Slide: 5 | Sheet: Data"
        const parts = headerLine.split(' | ');
        let fileName = '';
        let startLine: number | undefined;
        let endLine: number | undefined;
        let pageNumber: number | undefined;
        let slideNumber: number | undefined;
        let sheetName: string | undefined;

        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed.startsWith('File: ')) {
            fileName = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('Lines: ')) {
            const linesMatch = trimmed.slice(7).match(/(\d+)-(\d+)/);
            if (linesMatch) {
              startLine = Number(linesMatch[1]);
              endLine = Number(linesMatch[2]);
            }
          } else if (trimmed.startsWith('Page: ')) {
            pageNumber = Number(trimmed.slice(6));
          } else if (trimmed.startsWith('Slide: ')) {
            slideNumber = Number(trimmed.slice(7));
          } else if (trimmed.startsWith('Sheet: ')) {
            sheetName = trimmed.slice(7).trim();
          }
        }

        if (!fileName) continue;

        // Parse body: code fence (```ext\n...\n```) or blockquote (> ...)
        let quoteContent = '';
        let isCodeFence = false;
        const fenceMatch = body.match(/^```[\w]*\n([\s\S]*?)\n```$/);
        if (fenceMatch) {
          quoteContent = fenceMatch[1];
          isCodeFence = true;
        } else if (body.startsWith('> ')) {
          // Strip "> " or ">" prefix from each line
          quoteContent = body
            .split('\n')
            .map((line) => line.replace(/^>\s?/, ''))
            .join('\n');
        }

        quotes.push({
          content: quoteContent,
          fileName,
          filePath: resolvePath(fileName),
          source: inferSource(fileName, isCodeFence),
          startLine,
          endLine,
          pageNumber,
          slideNumber,
          sheetName,
        });
      }
      return '';
    },
  );

  return { content: content.trim(), quotes };
}

export function agentMessageToBlocks(msg: any, cwd?: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      // Strip quote sections FIRST (before attachment sections) because
      // the quote header "File: name | ..." followed by a code fence
      // would otherwise be matched by the attachment text-file regex.
      const { content: afterQuotes, quotes } = stripQuoteSections(msg.content, cwd);
      const { content, files } = stripAttachmentSections(afterQuotes, cwd);
      blocks.push({
        id: `b-${msg.timestamp || Date.now()}`,
        type: 'text',
        content,
      });
      for (const f of files) {
        blocks.push({
          id: `b-file-${msg.timestamp || Date.now()}-${f.fileName}`,
          type: 'file',
          content: f.fileName,
          mimeType: getMimeType(f.fileName),
          fileName: f.fileName,
          fileSize: f.fileSize,
          workspacePath: f.workspacePath,
        });
      }
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content as any[]) {
        if (c.type === 'text') {
          const { content: afterQuotes, quotes } = stripQuoteSections(c.text || '', cwd);
          const { content, files } = stripAttachmentSections(afterQuotes, cwd);
          blocks.push({
            id: `b-text-${msg.timestamp || Date.now()}-${blocks.length}`,
            type: 'text',
            content,
          });
          for (const f of files) {
            blocks.push({
              id: `b-file-${msg.timestamp || Date.now()}-${f.fileName}`,
              type: 'file',
              content: f.fileName,
              mimeType: getMimeType(f.fileName),
              fileName: f.fileName,
              fileSize: f.fileSize,
              workspacePath: f.workspacePath,
            });
          }
        } else if (c.type === 'image') {
          blocks.push({
            id: `b-img-${msg.timestamp || Date.now()}-${blocks.length}`,
            type: 'image',
            content: '',
            mimeType: c.mimeType || 'image/png',
            data: c.data || '',
          });
        }
      }
    }
  } else if (msg.role === 'assistant') {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i] as any;
        if (block.type === 'text') {
          const rawText = block.text || '';
          const thinkResult = extractThinkContent(rawText);
          if (thinkResult.thinking !== null) {
            blocks.push({
              id: `b-think-${msg.timestamp || Date.now()}-${i}`,
              type: 'thinking',
              content: thinkResult.thinking,
              thinking: thinkResult.thinking,
            });
          }
          blocks.push({
            id: `b-text-${msg.timestamp || Date.now()}-${i}`,
            type: 'text',
            content: thinkResult.text,
          });
        } else if (block.type === 'toolCall' || block.type === 'tool_call') {
          // pi-ai uses `arguments` (not `args` or `input`) and `id` (not `toolCallId`)
          blocks.push({
            id: `b-tool-${msg.timestamp || Date.now()}-${i}`,
            type: 'tool_call',
            content: `Calling ${block.name || block.toolName || 'tool'}`,
            toolCallId: block.id || block.toolCallId || `tc-${i}`,
            toolName: block.name || block.toolName,
            args: block.arguments || block.args || block.input || {},
          });
        } else if (block.type === 'toolResult' || block.type === 'tool_result') {
          const resultContent = extractTextFromContent(block.content);
          blocks.push({
            id: `b-tr-${msg.timestamp || Date.now()}-${i}`,
            type: 'tool_result',
            content: resultContent,
            toolCallId: block.toolCallId || `tc-${i}`,
            result: resultContent,
            isError: block.isError,
          });
          // If the tool result content also contains images, produce image blocks
          if (Array.isArray(block.content)) {
            for (const c of block.content as any[]) {
              if (c.type === 'image') {
                blocks.push({
                  id: `b-tr-img-${msg.timestamp || Date.now()}-${i}`,
                  type: 'image',
                  content: c.data || '',
                  mimeType: c.mimeType || 'image/png',
                  data: c.data || '',
                });
              }
            }
          }
        } else if (block.type === 'thinking') {
          blocks.push({
            id: `b-think-${msg.timestamp || Date.now()}-${i}`,
            type: 'thinking',
            content: block.thinking || block.text || '',
            thinking: block.thinking || block.text || '',
            duration: block.duration,
          });
        } else if (block.type === 'image') {
          blocks.push({
            id: `b-img-${msg.timestamp || Date.now()}-${i}`,
            type: 'image',
            content: block.data || '',
            mimeType: block.mimeType || 'image/png',
            data: block.data || '',
            width: block.width,
            height: block.height,
          });
        }
      }
    } else if (typeof content === 'string') {
      blocks.push({
        id: `b-text-${msg.timestamp || Date.now()}-0`,
        type: 'text',
        content,
      });
    }
  } else if (msg.role === 'toolResult' || msg.role === 'tool_result') {
    const content = extractTextFromContent(msg.content);
    // The result carries the tool name and, for plugins with a
    // messageRenderer, the declarative card tree in `details.card`. Both are
    // persisted, so a reopened conversation must render the same card it
    // rendered while streaming — without them the card degrades to a bare
    // header row and its buttons lose their plugin.
    const card = msg.details?.card;
    blocks.push({
      id: `b-tr-${msg.timestamp || Date.now()}`,
      type: 'tool_result',
      content,
      toolCallId: msg.toolCallId || 'unknown',
      result: content,
      isError: msg.isError,
      ...(msg.toolName ? { toolName: msg.toolName } : {}),
      ...(card ? { card } : {}),
    });
  } else if (msg.role === 'bashExecution') {
    blocks.push({
      id: `b-bash-${msg.timestamp || Date.now()}`,
      type: 'text',
      content: `Bash: ${msg.command}\nOutput: ${msg.output}`,
    });
  } else if (msg.role === 'compactionSummary') {
    blocks.push({
      id: `b-compact-${msg.timestamp || Date.now()}`,
      type: 'text',
      content: msg.summary || '',
    });
  } else if (msg.role === 'branchSummary') {
    blocks.push({
      id: `b-branch-${msg.timestamp || Date.now()}`,
      type: 'text',
      content: msg.summary || '',
    });
  }

  return blocks;
}

// === Conversion: AgentMessage → our Message type ===

/**
 * Map the SDK's `Usage` onto our `TokenUsage`.
 *
 * `totalTokens` from the SDK already includes cached prompt tokens. The old
 * fallback (`input + output`) did not, so any payload without an explicit
 * total under-reported a cache-heavy turn by an order of magnitude.
 */
function sdkUsageToTokenUsage(usage: any): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input ?? usage.inputTokens ?? 0;
  const output = usage.output ?? usage.outputTokens ?? 0;
  const cacheRead = usage.cacheRead ?? usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWrite ?? usage.cacheWriteTokens ?? 0;
  const cost = typeof usage.cost === 'number' ? usage.cost : usage.cost?.total;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cost: typeof cost === 'number' ? cost : 0,
  };
}

/**
 * Sum one entry's usage into a merged message.
 *
 * A single UI message can contain several assistant entries (one per model
 * call in a tool loop). Keeping only the first entry's usage made a reloaded
 * conversation report a fraction of its tokens and cost.
 */
function addTokenUsage(target: TokenUsage | undefined, extra: TokenUsage | undefined): TokenUsage | undefined {
  if (!extra) return target;
  if (!target) return { ...extra };
  return {
    inputTokens: target.inputTokens + extra.inputTokens,
    outputTokens: target.outputTokens + extra.outputTokens,
    totalTokens: target.totalTokens + extra.totalTokens,
    cacheReadTokens: (target.cacheReadTokens ?? 0) + (extra.cacheReadTokens ?? 0),
    cacheWriteTokens: (target.cacheWriteTokens ?? 0) + (extra.cacheWriteTokens ?? 0),
    cost: (target.cost ?? 0) + (extra.cost ?? 0),
  };
}

function toMessage(msg: any, sessionId: string, index: number, entryId?: string, cwd?: string): Message | null {
  const blocks = agentMessageToBlocks(msg, cwd);
  if (blocks.length === 0) return null;

  const id = `msg-${sessionId}-${index}`;
  const content = blocks.filter((b) => b.type === 'text').map((b) => b.content).join('');
  const timestamp = msg.timestamp
    ? new Date(msg.timestamp).toISOString()
    : new Date().toISOString();

  if (msg.role === 'user') {
    return {
      id,
      sessionId,
      role: 'user',
      status: 'complete',
      content,
      blocks,
      createdAt: timestamp,
      updatedAt: timestamp,
      entryId,
    };
  } else if (msg.role === 'assistant') {
    return {
      id,
      sessionId,
      role: 'assistant',
      status: 'complete',
      modelId: msg.model || 'unknown',
      content,
      blocks,
      createdAt: timestamp,
      updatedAt: timestamp,
      entryId,
      usage: sdkUsageToTokenUsage(msg.usage),
    } as AssistantMessage;
  }

  // For non-standard messages (bash, system, custom, compaction, branch)
  return {
    id,
    sessionId,
    role: 'system',
    status: 'complete',
    content,
    blocks,
    createdAt: timestamp,
    updatedAt: timestamp,
    entryId,
  };
}

function isSessionMessageEntry(e: SessionEntry): e is SessionMessageEntry {
  return e.type === 'message';
}

/**
 * The plugin payload of a custom entry.
 *
 * `custom` entries keep it in `data`; `custom_message` entries (the explicit
 * agent-visible revision) keep their extension payload in `details` and their
 * model-facing text in `content`. One reader handles both so a message keeps
 * its identity across revisions.
 */
function pluginMessageDataOf(entry: SessionEntry): PluginMessageData | undefined {
  if (entry.type !== 'custom' && entry.type !== 'custom_message') return undefined;
  if ((entry as { customType?: string }).customType !== PLUGIN_MESSAGE_CUSTOM_TYPE) return undefined;
  const data =
    entry.type === 'custom'
      ? (entry as { data?: PluginMessageData }).data
      : (entry as { details?: PluginMessageData }).details;
  return data && typeof data.id === 'string' ? data : undefined;
}

/** A pi custom/custom_message entry carrying a plugin-originated message. */
function isPluginMessageEntry(
  e: SessionEntry,
): e is SessionEntry & { type: 'custom' | 'custom_message' } {
  return pluginMessageDataOf(e) !== undefined;
}

/**
 * Fold append-only plugin message entries to one message per plugin id
 * (highest revision wins, later entry breaks a tie), dropping tombstones.
 */
function foldPluginMessages(entries: readonly SessionEntry[], sessionId: string): PluginMessage[] {
  const latest = new Map<string, { entry: SessionEntry; data: PluginMessageData }>();
  for (const entry of entries) {
    const data = pluginMessageDataOf(entry);
    if (!data) continue;
    const prev = latest.get(data.id);
    if (!prev || (data.revision ?? 0) >= (prev.data.revision ?? 0)) {
      latest.set(data.id, { entry, data });
    }
  }

  const messages: PluginMessage[] = [];
  for (const { entry, data } of latest.values()) {
    if (data.removed) continue;

    const createdMs =
      typeof data.createdAt === 'number' && Number.isFinite(data.createdAt)
        ? data.createdAt
        : Date.parse(entry.timestamp) || Date.now();
    const createdAt = new Date(createdMs).toISOString();
    const updatedAt = entry.timestamp ? new Date(entry.timestamp).toISOString() : createdAt;

    const blocks: ContentBlock[] = [];
    if (data.text) {
      blocks.push({ id: `pm-text-${data.id}`, type: 'text', content: data.text });
    }
    for (const [i, file] of (data.files ?? []).entries()) {
      const name = path.basename(file.path);
      let size: number | undefined;
      try {
        size = statSync(file.path).size;
      } catch {
        /* missing file: the card still opens/下载s nothing */
      }
      blocks.push({
        id: `pm-file-${data.id}-${i}`,
        type: 'file',
        content: file.label || name,
        mimeType: getMimeType(file.path),
        fileName: name,
        fileSize: size,
        workspacePath: file.path,
      });
    }

    messages.push({
      id: `msg-${sessionId}-plugin-${data.id}`,
      sessionId,
      role: 'plugin',
      status: 'complete',
      content: data.text ?? '',
      blocks,
      card: data.card,
      files: data.files,
      pluginId: data.pluginId,
      pluginMessageId: data.id,
      revision: data.revision ?? 1,
      pluginStatus: data.status,
      agentVisible: data.agentVisible === true,
      ...(data.title ? { title: data.title } : {}),
      ...(data.quote ? { quote: data.quote } : {}),
      ...(data.source ? { source: data.source } : {}),
      ...(data.triggered ? { triggered: true } : {}),
      createdAt,
      updatedAt,
      entryId: entry.id,
    });
  }
  return messages;
}

// === Conversion: SDK SessionTreeNode → our SessionTreeNode ===
function extractPreview(entry: any): string | undefined {
  if (entry.type === 'message' && entry.message) {
    const msg = entry.message;
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((c: any) => (c.text || '')).join(' ')
        : '';
    return content.slice(0, 60);
  }
  if (entry.type === 'model_change') {
    return `${entry.provider}/${entry.modelId}`;
  }
  if (entry.type === 'thinking_level_change') {
    return entry.thinkingLevel || '';
  }
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return (entry.summary || '').slice(0, 60);
  }
  if (entry.type === 'session_info' && entry.name) {
    return entry.name;
  }
  if (entry.type === 'label') {
    return entry.label || entry.targetId;
  }
  if (entry.type === 'custom' || entry.type === 'custom_message') {
    return entry.customType || entry.type;
  }
  return undefined;
}

function extractToolAndThinking(msg: any): {
  toolCount: number;
  toolCalls: TreeNodeToolCall[];
  hasThinking: boolean;
  thinkingDuration?: number;
} {
  let toolCount = 0;
  const toolCalls: TreeNodeToolCall[] = [];
  let hasThinking = false;
  let thinkingDuration: number | undefined;

  const content = msg.content;
  if (!Array.isArray(content)) return { toolCount, toolCalls, hasThinking };

  for (const block of content) {
    if (block.type === 'toolCall' || block.type === 'tool_call') {
      toolCount++;
      // pi-ai uses `arguments` (not `args`/`input`) and `id` (not `toolCallId`)
      const args = block.arguments || block.args || block.input || {};
      const argsPreview = typeof args === 'object'
        ? JSON.stringify(args).slice(0, 80)
        : String(args).slice(0, 80);
      toolCalls.push({
        toolCallId: block.id || block.toolCallId || `tc-${toolCount}`,
        toolName: block.name || block.toolName || 'unknown',
        argsPreview,
      });
    } else if (block.type === 'toolResult' || block.type === 'tool_result') {
      // Match tool result to its call and add result info
      const matchingCall = toolCalls.find((tc) => tc.toolCallId === block.toolCallId);
      if (matchingCall) {
        const resultContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        matchingCall.resultPreview = resultContent.slice(0, 100);
        matchingCall.isError = block.isError;
      }
    } else if (block.type === 'thinking') {
      hasThinking = true;
      if (typeof block.duration === 'number') {
        thinkingDuration = (thinkingDuration ?? 0) + block.duration;
      }
    }
  }

  return { toolCount, toolCalls, hasThinking, thinkingDuration };
}

function toSessionTreeNode(node: any): SessionTreeNode {
  const entry = node.entry as any;
  const result: SessionTreeNode = {
    id: entry.id,
    parentId: entry.parentId ?? null,
    type: entry.type,
    timestamp: entry.timestamp || '',
    label: node.label,
    children: (node.children || []).map(toSessionTreeNode),
    preview: extractPreview(entry),
  };

  if (entry.type === 'message' && entry.message) {
    result.role = entry.message.role === 'user' ? 'user' : 'assistant';
    // Extract tool and thinking info from message content
    if (entry.message.role === 'assistant') {
      const info = extractToolAndThinking(entry.message);
      if (info.toolCount > 0) {
        result.toolCount = info.toolCount;
        result.toolCalls = info.toolCalls;
      }
      if (info.hasThinking) {
        result.hasThinking = true;
        result.thinkingDuration = info.thinkingDuration;
      }
    }
  }
  if (entry.type === 'model_change') {
    result.provider = entry.provider;
    result.modelId = entry.modelId;
  }
  if (entry.type === 'thinking_level_change') {
    result.thinkingLevel = entry.thinkingLevel;
  }
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    result.summary = entry.summary;
  }
  if (entry.type === 'custom' || entry.type === 'custom_message') {
    result.customType = entry.customType;
  }

  return result;
}

export function createRealSessionService(): SessionService {
  return {
    async list(workspaceId: string): Promise<Session[]> {
      try {
        const sessions = await SessionManager.list(workspaceId);
        // Order by creation, not by last activity: a long run finishing must
        // not move its conversation to the top of the list.
        return sessions
          .map(toSession)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      } catch (err) {
        // `SessionManager.list` already returns [] for a workspace whose
        // session directory is missing, so reaching here means something
        // genuinely failed (unreadable dir, corrupt store). Surface it rather
        // than reporting "no sessions", which reads as a valid empty state.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot list sessions for ${workspaceId}: ${message}`);
      }
    },

    async get(id: string): Promise<SessionWithMessages> {
      let sm: SessionManager;
      try {
        sm = SessionManager.open(id);
      } catch {
        throw new Error(`Session not found: ${id}`);
      }

      const header = sm.getHeader();
      const entries = sm.getEntries();
      const messageEntries = entries.filter(isSessionMessageEntry);

      // Resolve cwd early so it's available during message block construction
      const cwd = header?.cwd || sm.getCwd();

      // Build messages, merging tool_result entries into their preceding assistant message.
      // This ensures the renderBlocks pairing in message-bubble.tsx can correctly
      // pair tool_call blocks with their results within a single message.
      const messages: Message[] = [];
      let msgIndex = 0;

      for (const entry of messageEntries) {
        const rawMsg = entry.message;

        // Merge toolResult into the preceding assistant message
        if (rawMsg.role === 'toolResult') {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            const toolBlocks = agentMessageToBlocks(rawMsg, cwd);
            if (toolBlocks.length > 0) {
              lastMsg.blocks.push(...toolBlocks);
              // Rebuild content from text blocks only (matches streaming path)
              lastMsg.content = lastMsg.blocks
                .filter((b) => b.type === 'text')
                .map((b) => b.content)
                .join('');
              if (rawMsg.timestamp) {
                lastMsg.updatedAt = new Date(rawMsg.timestamp).toISOString();
              }
            }
          }
          continue;
        }

        // Merge consecutive assistant entries into one message
        // (SDK persists multi-turn assistant responses as separate entries)
        if (rawMsg.role === 'assistant') {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            const newBlocks = agentMessageToBlocks(rawMsg, cwd);
            lastMsg.blocks.push(...newBlocks);
            lastMsg.content = lastMsg.blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.content)
              .join('');
            // Each entry is one model call in this tool loop and carries its
            // own usage. Keep only the first and a reloaded conversation
            // reports a fraction of its tokens and cost.
            const merged = lastMsg as AssistantMessage;
            merged.usage = addTokenUsage(merged.usage, sdkUsageToTokenUsage(rawMsg.usage));
            if (rawMsg.timestamp) {
              lastMsg.updatedAt = new Date(rawMsg.timestamp).toISOString();
            }
            continue;
          }
        }

        const message = toMessage(rawMsg, id, msgIndex++, entry.id, cwd);
        if (message) messages.push(message);
      }

      // Post-process: collect file blocks from ALL tool results across all messages,
      // deduplicate globally, then append them to the LAST message only.
      // This matches the streaming behaviour where all file blocks appear at the
      // very end of the assistant response, never interleaved mid-conversation.
      //
      // Build a toolCallId → {toolName, args} map so we can use the same precise
      // detection logic as the streaming path (detectWrittenFiles), instead of
      // falling back to regex-only detection that causes false positives.
      const toolCallMap = new Map<string, { toolName: string; args: Record<string, unknown> }>();
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.type === 'tool_call') {
            const tcBlock = block as ToolCallBlock;
            toolCallMap.set(tcBlock.toolCallId, {
              toolName: tcBlock.toolName || '',
              args: tcBlock.args || {},
            });
          }
        }
      }

      const allFileBlocks: ContentBlock[] = [];
      const seenPaths = new Set<string>();
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.type === 'tool_result' && block.result) {
            const trBlock = block as ToolResultBlock;
            const tcInfo = toolCallMap.get(trBlock.toolCallId);
            const files = detectWrittenFiles(tcInfo?.toolName, tcInfo?.args, block.result, cwd);
            for (const file of files) {
              if (seenPaths.has(file.absPath)) continue;
              seenPaths.add(file.absPath);
              allFileBlocks.push({
                id: `b-file-sess-${file.absPath}`,
                type: 'file',
                content: path.basename(file.absPath),
                mimeType: file.mimeType,
                fileName: path.basename(file.absPath),
                fileSize: file.size,
                workspacePath: file.absPath,
              });
            }
          }
        }
      }
      if (allFileBlocks.length > 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        lastMsg.blocks.push(...allFileBlocks);
      }

      // Plugin-originated messages share this transcript (pi `custom` entries).
      // Fold append-only updates to the latest revision and interleave them by
      // their own createdAt — an update must stay where the message was, not
      // jump to the end.
      const pluginMessages = foldPluginMessages(entries, id);
      if (pluginMessages.length > 0) {
        messages.push(...pluginMessages);
        messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      }

      const sessionName = sm.getSessionName();
      const title = (typeof sessionName === 'string' && sessionName ? sessionName : undefined)
        || (messageEntries.length > 0 ? extractTitleFromMessage(messageEntries[0].message) : undefined)
        || 'Untitled';

      // Use header timestamp if available
      const createdAt = header?.timestamp
        ? new Date(header.timestamp).toISOString()
        : new Date().toISOString();

      return {
        id,
        workspaceId: cwd,
        title,
        status: 'active',
        messageCount: messages.length,
        lastMessageAt: messages.length > 0 ? messages[messages.length - 1].createdAt : null,
        createdAt,
        updatedAt: messages.length > 0 ? messages[messages.length - 1].createdAt : createdAt,
        messages,
      };
    },

    async create(workspaceId: string, title?: string): Promise<Session> {
      const sm = SessionManager.create(workspaceId);
      if (title) {
        sm.appendSessionInfo(title);
      }
      const file = sm.getSessionFile();
      return {
        id: file || `sess-${sm.getSessionId()}`,
        workspaceId,
        title: title ?? 'New Session',
        status: 'active',
        messageCount: 0,
        lastMessageAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },

    async delete(id: string): Promise<void> {
      if (existsSync(id)) {
        unlinkSync(id);
      }
    },

    async updateTitle(id: string, title: string): Promise<Session> {
      try {
        const sm = SessionManager.open(id);
        sm.appendSessionInfo(title);
        return this.get(id);
      } catch {
        throw new Error(`Session not found: ${id}`);
      }
    },

    async getTree(id: string): Promise<SessionTreeResult> {
      let sm: SessionManager;
      try {
        sm = SessionManager.open(id);
      } catch {
        throw new Error(`Session not found: ${id}`);
      }

      const sdkNodes = sm.getTree();
      const leafId = sm.getLeafId();
      const nodes = sdkNodes.map(toSessionTreeNode);

      return {
        sessionId: sm.getSessionId(),
        leafId,
        nodes,
      };
    },
  };
}
