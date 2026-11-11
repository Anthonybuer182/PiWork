import type { Transport } from '../transport/base.js';
import type { ChatService, SendMessageParams, StreamChunk, NavigateTreeResult, NavigateTreeOptions, CompactResult } from '../services/chat.js';
import type { Message } from '@pi/types';

/**
 * Check if a transport supports streaming.
 */
function hasStreaming(transport: Transport): transport is Transport & {
  streamRequest(method: string, params: unknown, onEvent: (data: any) => void, signal?: AbortSignal): Promise<void>;
} {
  return typeof (transport as any).streamRequest === 'function';
}

export function createProxyChatService(transport: Transport): ChatService {
  return {
    async sendMessage(params: SendMessageParams): Promise<Message> {
      return transport.request('chat.sendMessage', params) as Promise<Message>;
    },

    async sendMessageStream(
      params: SendMessageParams,
      onChunk: (chunk: StreamChunk) => void,
      signal?: AbortSignal,
    ): Promise<Message> {
      // Use real streaming via SSE if transport supports it
      if (hasStreaming(transport)) {
        try {
          await transport.streamRequest('chat.sendMessageStream', params, (event) => {
            onChunk(event as StreamChunk);
          }, signal);
        } catch (err) {
          if (signal?.aborted) return { role: 'assistant' } as Message;
          onChunk({ type: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
          throw err;
        }
        // Fetch the final message after stream ends
        const messages = await transport.request('chat.getMessages', {
          sessionId: params.sessionId,
          limit: 1,
          offset: 0,
        }) as Message[];
        return messages[0] || ({ role: 'assistant' } as Message);
      }

      // Fallback: non-streaming for transports without streamRequest
      try {
        const message = await transport.request('chat.sendMessage', params) as Message;
        const textContent = typeof message.content === 'string'
          ? message.content
          : (Array.isArray(message.content) ? JSON.stringify(message.content) : '');
        onChunk({ type: 'text', content: textContent });
        onChunk({ type: 'done' });
        return message;
      } catch (err) {
        onChunk({ type: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
        throw err;
      }
    },

    async getMessages(sessionId: string, limit?: number, offset?: number) {
      return transport.request('chat.getMessages', { sessionId, limit, offset }) as ReturnType<ChatService['getMessages']>;
    },

    async stopGeneration(sessionId: string) {
      return transport.request('chat.stopGeneration', { sessionId }) as ReturnType<ChatService['stopGeneration']>;
    },

    async steer(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]) {
      return transport.request('chat.steer', { sessionId, content, images }) as ReturnType<ChatService['steer']>;
    },

    async followUp(sessionId: string, content: string, images?: { name: string; mimeType: string; data: string }[]) {
      return transport.request('chat.followUp', { sessionId, content, images }) as ReturnType<ChatService['followUp']>;
    },

    async navigateTree(sessionId: string, entryId: string, options?: NavigateTreeOptions) {
      return transport.request('chat.navigateTree', { sessionId, entryId, options }) as Promise<NavigateTreeResult>;
    },

    async switchBranch(sessionId: string, entryId: string) {
      return transport.request('chat.switchBranch', { sessionId, entryId }) as ReturnType<ChatService['switchBranch']>;
    },

    async compact(sessionId: string, customInstructions?: string) {
      return transport.request('chat.compact', { sessionId, customInstructions }) as Promise<CompactResult>;
    },

    // ── agent context ──
    // Settings → 上下文 and the host's context-audit tool reach these the same
    // way any other host UI reaches its data: over the ordinary request
    // transport.
    async getAgentContextConfig(workspacePath: string, workspaceId?: string, sessionId?: string) {
      return transport.request('chat.getAgentContextConfig', {
        workspacePath,
        workspaceId,
        sessionId,
      }) as ReturnType<ChatService['getAgentContextConfig']>;
    },

    async reloadAgentContext(workspacePath: string) {
      return transport.request('chat.reloadAgentContext', { workspacePath }) as ReturnType<
        ChatService['reloadAgentContext']
      >;
    },

    async getGlobalContextInfo() {
      return transport.request('chat.getGlobalContextInfo', {}) as ReturnType<
        ChatService['getGlobalContextInfo']
      >;
    },

    async reloadAgentContextForFile(filePath: string, preferredWorkspace?: string) {
      return transport.request('chat.reloadAgentContextForFile', {
        filePath,
        preferredWorkspace,
      }) as ReturnType<ChatService['reloadAgentContextForFile']>;
    },

    async writeContextFile(params) {
      return transport.request('chat.writeContextFile', params) as ReturnType<ChatService['writeContextFile']>;
    },

    async deleteContextFile(params) {
      return transport.request('chat.deleteContextFile', params) as ReturnType<ChatService['deleteContextFile']>;
    },
  };
}
