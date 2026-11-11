import type { Transport } from '../transport/base.js';
import type { SessionService } from '../services/session.js';

export function createProxySessionService(transport: Transport): SessionService {
  return {
    async list(workspaceId: string) {
      return transport.request('session.list', { workspaceId }) as ReturnType<SessionService['list']>;
    },
    async get(id: string) {
      return transport.request('session.get', { id }) as ReturnType<SessionService['get']>;
    },
    async create(workspaceId: string, title?: string) {
      return transport.request('session.create', { workspaceId, title }) as ReturnType<SessionService['create']>;
    },
    async delete(id: string) {
      return transport.request('session.delete', { id }) as ReturnType<SessionService['delete']>;
    },
    async updateTitle(id: string, title: string) {
      return transport.request('session.updateTitle', { id, title }) as ReturnType<SessionService['updateTitle']>;
    },
    async getTree(id: string) {
      return transport.request('session.getTree', { id }) as ReturnType<SessionService['getTree']>;
    },
    async fork(sourceId: string, throughEntryId: string, title?: string) {
      return transport.request('session.fork', {
        sourceId,
        throughEntryId,
        title,
      }) as ReturnType<SessionService['fork']>;
    },
  };
}
