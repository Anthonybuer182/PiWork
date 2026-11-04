/**
 * 设置 → MCP.
 *
 * Two scopes: the global list (`<agentDir>/mcp.json`, shared with the pi CLI)
 * and the active workspace's `.pi/mcp.json`. Project files can run local
 * commands, so they stay inert until the workspace is explicitly trusted.
 *
 * Tools are not listed here: the model discovers them through `tool_search`
 * at conversation time, which keeps the prompt from growing with every server.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type {
  McpListResult,
  McpProbeResult,
  McpScope,
  McpServerInput,
  McpServerRecord,
  McpTransportKind,
} from '@pi/types';
import { useI18n } from '@/i18n';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { MCP_SERVERS_QUERY_KEY, hasMcpApi, mcpApi } from '@/lib/mcp-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** `KEY=value` lines → object. Blank lines and `#` comments are ignored. */
function parseKeyValueLines(text: string, separator: '=' | ':'): { map: Record<string, string>; error?: string } {
  const map: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(separator);
    if (index <= 0) return { map, error: line };
    map[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { map };
}

function formatKeyValueLines(map: Record<string, string> | undefined, separator: '=' | ':'): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([key, value]) => `${key}${separator === '=' ? '=' : ': '}${value}`)
    .join('\n');
}

interface FormState {
  name: string;
  type: McpTransportKind;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  description: string;
  timeout: string;
  exposure: 'deferred' | 'hidden';
  enabled: boolean;
}

function formFromRecord(record?: McpServerRecord): FormState {
  return {
    name: record?.name ?? '',
    type: record?.type ?? 'stdio',
    command: record?.command ?? '',
    args: (record?.args ?? []).join('\n'),
    env: formatKeyValueLines(record?.env, '='),
    cwd: record?.cwd ?? '',
    url: record?.url ?? '',
    headers: formatKeyValueLines(record?.headers, ':'),
    description: record?.description ?? '',
    timeout: record?.timeout ? String(record.timeout) : '',
    exposure: record?.exposure ?? 'deferred',
    enabled: record?.enabled ?? true,
  };
}

function buildInput(form: FormState, original?: McpServerRecord): McpServerInput {
  const base: McpServerInput = {
    name: form.name.trim(),
    type: form.type,
    enabled: form.enabled,
    exposure: form.exposure,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.timeout.trim() ? { timeout: Number(form.timeout) } : {}),
    ...(original?.extra ? { extra: original.extra } : {}),
  };
  if (form.type === 'http') {
    const headers = parseKeyValueLines(form.headers, ':');
    base.url = form.url.trim();
    if (Object.keys(headers.map).length > 0) base.headers = headers.map;
    return base;
  }
  const env = parseKeyValueLines(form.env, '=');
  base.command = form.command.trim();
  const args = form.args.split('\n').map((line) => line.trim()).filter(Boolean);
  if (args.length > 0) base.args = args;
  if (Object.keys(env.map).length > 0) base.env = env.map;
  if (form.cwd.trim()) base.cwd = form.cwd.trim();
  return base;
}

function ServerFormDialog({
  scope,
  workspacePath,
  record,
  onClose,
  onSaved,
}: {
  scope: McpScope;
  workspacePath: string | null;
  record?: McpServerRecord;
  onClose: () => void;
  onSaved: (result: McpListResult) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => formFromRecord(record));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpProbeResult | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const input = () => buildInput(form, record);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await mcpApi.probe({
        scope,
        ...(workspacePath ? { workspacePath } : {}),
        server: input(),
      }));
    } catch (err) {
      setTestResult({ ok: false, code: 'invalid', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    // Parse the line formats before handing them to main, so a typo is
    // reported next to the field instead of as a generic save failure.
    if (form.type === 'stdio' && parseKeyValueLines(form.env, '=').error) {
      setError(t('环境变量格式应为 KEY=value，每行一条'));
      return;
    }
    if (form.type === 'http' && parseKeyValueLines(form.headers, ':').error) {
      setError(t('请求头格式应为 Name: value，每行一条'));
      return;
    }
    setSaving(true);
    try {
      const result = await mcpApi.save({
        scope,
        ...(workspacePath ? { workspacePath } : {}),
        originalName: record?.name ?? null,
        server: input(),
      });
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{record ? t('编辑 MCP 服务器') : t('添加 MCP 服务器')}</DialogTitle>
          <DialogDescription>
            {scope === 'project'
              ? t('此配置写入当前工作区的 .pi/mcp.json，只在本工作区生效。')
              : t('此配置写入全局 mcp.json，与 pi 命令行共享。')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('名称')}</span>
            <Input
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="github"
              autoFocus
            />
          </label>

          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">{t('传输方式')}</span>
            <div className="flex gap-1 rounded-lg border p-1">
              {(['stdio', 'http'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => set('type', kind)}
                  className={
                    form.type === kind
                      ? 'rounded-md bg-accent px-3 py-1 text-xs font-medium'
                      : 'rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-accent/60'
                  }
                >
                  {kind === 'stdio' ? t('本地命令 (stdio)') : t('远程服务 (HTTP)')}
                </button>
              ))}
            </div>
          </div>

          {form.type === 'stdio' ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t('命令')}</span>
                <Input
                  value={form.command}
                  onChange={(event) => set('command', event.target.value)}
                  placeholder="npx"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t('参数（每行一个）')}</span>
                <Textarea
                  value={form.args}
                  onChange={(event) => set('args', event.target.value)}
                  rows={3}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t('环境变量（每行 KEY=value）')}</span>
                <Textarea
                  value={form.env}
                  onChange={(event) => set('env', event.target.value)}
                  rows={2}
                  placeholder="MODE=readonly"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t('工作目录（可选）')}</span>
                <Input
                  value={form.cwd}
                  onChange={(event) => set('cwd', event.target.value)}
                  placeholder={workspacePath ?? '~'}
                />
              </label>
            </>
          ) : (
            <>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t('地址')}</span>
                <Input
                  value={form.url}
                  onChange={(event) => set('url', event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t('请求头（每行 Name: value）')}</span>
                <Textarea
                  value={form.headers}
                  onChange={(event) => set('headers', event.target.value)}
                  rows={2}
                  placeholder="Authorization: Bearer ${TOKEN}"
                />
              </label>
            </>
          )}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('说明（可选）')}</span>
            <Input
              value={form.description}
              onChange={(event) => set('description', event.target.value)}
              placeholder={t('一句话描述这个服务器提供什么')}
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">{t('超时（秒）')}</span>
              <Input
                value={form.timeout}
                onChange={(event) => set('timeout', event.target.value)}
                placeholder="60"
                inputMode="numeric"
              />
            </label>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{t('按需加载工具')}</span>
              <Switch
                checked={form.exposure === 'deferred'}
                onCheckedChange={(checked) => set('exposure', checked ? 'deferred' : 'hidden')}
              />
            </div>
          </div>

          {form.type === 'stdio' && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {t('这个命令会在本机执行，并继承 PiWork 的环境变量（包括 API Key）。只添加你信任的服务器。')}
            </p>
          )}

          {testResult && (
            <div
              className={
                testResult.ok
                  ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs'
                  : 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'
              }
            >
              {testResult.ok
                ? t('连接成功：协议 {version}，发现 {count} 个工具', {
                    version: testResult.protocolVersion,
                    count: String(testResult.tools.length),
                  })
                : t('连接失败：{message}', { message: testResult.message })}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={runTest} disabled={testing || saving}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('测试连接')}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function McpSettingsPage() {
  const sdk = useSDK();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((state) => state.activeWorkspaceId);

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });
  const workspacePath = useMemo(
    () => workspaces?.find((workspace) => workspace.id === activeWorkspaceId)?.path ?? null,
    [workspaces, activeWorkspaceId],
  );

  const [scope, setScope] = useState<McpScope>('global');
  useEffect(() => {
    if (!workspacePath && scope === 'project') setScope('global');
  }, [workspacePath, scope]);

  const queryKey = [MCP_SERVERS_QUERY_KEY, workspacePath ?? ''] as const;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => mcpApi.list(workspacePath),
    enabled: hasMcpApi(),
    staleTime: 0,
  });

  const [dialog, setDialog] = useState<{ record?: McpServerRecord } | null>(null);
  const [deleting, setDeleting] = useState<McpServerRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const apply = (result: McpListResult) => queryClient.setQueryData(queryKey, result);

  const servers = scope === 'global' ? data?.global ?? [] : data?.project ?? [];
  const statusOf = (server: McpServerRecord) =>
    data?.statuses.find((status) => status.scope === server.scope && status.name === server.name);

  const toggle = async (server: McpServerRecord, enabled: boolean) => {
    setBusy(server.name);
    try {
      apply(await mcpApi.setEnabled({
        scope: server.scope,
        ...(workspacePath ? { workspacePath } : {}),
        name: server.name,
        enabled,
      }));
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async (server: McpServerRecord) => {
    setBusy(server.name);
    setNotice(null);
    try {
      const result = await mcpApi.probe({
        name: server.name,
        scope: server.scope,
        ...(workspacePath ? { workspacePath } : {}),
      });
      setNotice(result.ok
        ? {
            kind: 'ok',
            text: t('{name} 连接成功：协议 {version}，{count} 个工具', {
              name: server.name,
              version: result.protocolVersion,
              count: String(result.tools.length),
            }),
          }
        : { kind: 'error', text: t('{name} 连接失败：{message}', { name: server.name, message: result.message }) });
      await refetch();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      apply(await mcpApi.remove({
        scope: deleting.scope,
        ...(workspacePath ? { workspacePath } : {}),
        name: deleting.name,
      }));
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setDeleting(null);
    }
  };

  const toggleTrust = async (trusted: boolean) => {
    if (!workspacePath) return;
    try {
      apply(await mcpApi.setTrust({ workspacePath, trusted }));
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!hasMcpApi()) {
    return <p className="p-6 text-sm text-muted-foreground">{t('MCP 仅在桌面应用中可用。')}</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">{t('MCP 服务器')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('接入 Model Context Protocol 服务器。工具不会常驻提示词——模型需要时通过搜索发现，避免多服务器撑爆上下文。')}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border p-1">
          {(['global', 'project'] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={value === 'project' && !workspacePath}
              onClick={() => setScope(value)}
              className={
                scope === value
                  ? 'rounded-md bg-accent px-3 py-1 text-xs font-medium'
                  : 'rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-accent/60 disabled:opacity-40'
              }
            >
              {value === 'global' ? t('全局') : t('本项目')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('刷新')}
          </Button>
          <Button size="sm" onClick={() => setDialog({})} disabled={scope === 'project' && !workspacePath}>
            <Plus className="mr-2 h-4 w-4" />
            {t('添加服务器')}
          </Button>
        </div>
      </div>

      {scope === 'project' && workspacePath && (
        <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('允许本项目运行 MCP 服务器')}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t('项目里的 .pi/mcp.json 可以执行本机命令。只在你信任这个仓库时开启。')}
            </p>
          </div>
          <Switch
            checked={data?.workspaceTrusted ?? false}
            onCheckedChange={(checked) => void toggleTrust(checked)}
          />
        </div>
      )}

      {notice && (
        <div
          className={
            notice.kind === 'ok'
              ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs'
              : 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'
          }
        >
          {notice.text}
        </div>
      )}

      {data && data.diagnostics.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('配置文件有问题')}
          </div>
          <ul className="list-disc space-y-0.5 pl-4">
            {data.diagnostics.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('加载中…')}
        </div>
      ) : error ? (
        <div className="p-6 text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
          {scope === 'global'
            ? t('还没有配置 MCP 服务器。添加一个，或在 pi 命令行里用 mcp add 添加，两边共享同一份配置。')
            : t('这个工作区还没有项目级的 MCP 服务器。')}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {servers.map((server) => {
            const status = statusOf(server);
            return (
              <li key={`${server.scope}:${server.name}`} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{server.name}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {server.type === 'http' ? 'HTTP' : 'stdio'}
                    </Badge>
                    {server.override && (
                      <Badge variant="outline" className="text-[10px]">{t('项目覆盖')}</Badge>
                    )}
                    {status && (
                      <span
                        className={
                          status.state === 'ok'
                            ? 'text-[11px] text-emerald-600 dark:text-emerald-400'
                            : 'text-[11px] text-destructive'
                        }
                      >
                        {status.state === 'ok'
                          ? t('可用 · {count} 个工具', { count: String(status.toolCount ?? 0) })
                          : t('连接失败')}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {server.type === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ')}
                  </div>
                  {server.description && (
                    <div className="mt-1 text-xs text-muted-foreground">{server.description}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={server.enabled}
                    disabled={busy === server.name}
                    onCheckedChange={(checked) => void toggle(server, checked)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === server.name}
                    onClick={() => void test(server)}
                  >
                    {busy === server.name
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <RefreshCw className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDialog({ record: server })}>
                    {t('编辑')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(server)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog && (
        <ServerFormDialog
          scope={scope}
          workspacePath={workspacePath}
          record={dialog.record}
          onClose={() => setDialog(null)}
          onSaved={apply}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('删除 MCP 服务器？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('将从配置文件中移除 {name}，已打开会话中的工具会在下一条消息后失效。', {
                name: deleting?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>{t('删除')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
