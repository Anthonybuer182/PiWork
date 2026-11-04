import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProxyMode, ProxySettings, ProxyState, ThemeMode } from '@pi/types';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useUIStore } from '@/stores/ui-store';
import { hasProxyApi, proxyApi } from '@/lib/network-client';
import {
  useI18n,
  useLanguageStore,
  LANGUAGE_OPTIONS,
  type Language,
  type MessageKey,
} from '@/i18n';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const THEME_OPTIONS: { value: ThemeMode; label: MessageKey }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

const PROXY_OPTIONS: { value: ProxyMode; label: MessageKey }[] = [
  { value: 'direct', label: '直接连接' },
  { value: 'system', label: '跟随系统' },
  { value: 'manual', label: '手动配置' },
];

function Row({
  label,
  hint,
  children,
  footer,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Full-width content below the row — for a field the right column is too narrow for. */
  footer?: ReactNode;
}) {
  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center">{children}</div>
      </div>
      {footer}
    </div>
  );
}

/**
 * 通用 — the settings that apply to the whole app rather than to one provider
 * or one conversation.
 *
 * Appearance and language are client preferences: they live in their own
 * stores, so each applies instantly and survives with no backend round-trip.
 * The proxy is the exception — only main can reach both network stacks — so it
 * is persisted there and re-applied on every change. Model, thinking level and
 * skill selection are deliberately absent: the composer already owns those,
 * per conversation.
 */
export function GeneralSettingsPage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const compactMode = useUIStore((s) => s.compactMode);
  const setCompactMode = useUIStore((s) => s.setCompactMode);

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-2">
      <div className="divide-y">
        <Row label={t('外观')} hint={t('整个应用的配色，立即生效。')}>
          <div className="flex rounded-md border p-0.5">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={theme === opt.value}
                onClick={() => setTheme(opt.value)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  theme === opt.value
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(opt.label)}
              </button>
            ))}
          </div>
        </Row>

        <Row label={t('语言')} hint={t('切换后立即生效，并记住选择。')}>
          <Select
            value={language}
            onValueChange={(value: string) => setLanguage(value as Language)}
          >
            <SelectTrigger className="w-[220px]" aria-label={t('语言')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label={t('紧凑模式')} hint={t('收紧消息间距，一屏看更多内容。')}>
          <Switch
            checked={compactMode}
            onCheckedChange={setCompactMode}
            aria-label={t('紧凑模式')}
          />
        </Row>

        {hasProxyApi() && <ProxyRow />}
      </div>

      <p className="pb-4 pt-2 text-[11px] text-muted-foreground/70">
        {t('外观、语言和网络设置保存在本机。')}
      </p>
    </div>
  );
}

/**
 * 网络代理.
 *
 * Two modes are one click; 手动配置 also needs an address, so the select only
 * becomes the saved choice once that address parses — otherwise picking it
 * would bounce straight back to the previous mode. The address commits on
 * Enter or blur, not on every keystroke: a half-typed URL is not a setting.
 */
function ProxyRow() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ProxyMode | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [ipcError, setIpcError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['network-proxy'],
    queryFn: () => proxyApi.get(),
    staleTime: 0,
  });

  const saved = data?.settings;
  // A mode picked in the UI wins until main confirms it — 手动配置 may be
  // waiting for an address.
  const activeMode = mode ?? saved?.mode ?? 'system';
  const error = ipcError ?? data?.error ?? null;

  // Adopt the saved address, including the normalised form main returns
  // (`127.0.0.1:7897` comes back as `http://127.0.0.1:7897`).
  useEffect(() => {
    setDraft(saved?.url ?? '');
  }, [saved?.url]);

  const apply = async (patch: Partial<ProxySettings>): Promise<boolean> => {
    setBusy(true);
    setIpcError(null);
    try {
      const next: ProxyState = await proxyApi.set(patch);
      queryClient.setQueryData(['network-proxy'], next);
      return next.error === null;
    } catch (err) {
      setIpcError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (value: string) => {
    const next = value as ProxyMode;
    setMode(next);
    // Manual needs an address first; the field below appears and applies on save.
    if (next === 'manual' && !saved?.url) return;
    void apply({ mode: next }).then((ok) => {
      if (ok) setMode(null);
    });
  };

  const saveUrl = () => {
    const url = draft.trim();
    if (!url || url === saved?.url) return;
    void apply({ mode: 'manual', url }).then((ok) => {
      if (ok) setMode(null);
    });
  };

  const hint =
    activeMode === 'manual'
      ? t('所有请求都走这个代理。支持 http、https 和 socks5，改完立即生效。')
      : activeMode === 'direct'
        ? t('所有请求直接发出，不走代理。')
        : data?.systemProxy
          ? t('跟随系统：{proxy}', { proxy: data.systemProxy })
          : t('跟随系统：系统当前没有设置代理。');

  return (
    <Row
      label={t('网络代理')}
      hint={hint}
      footer={
        <>
          {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
          {activeMode === 'manual' && (
            <div className="mt-2">
              <div className="flex items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={saveUrl}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveUrl();
                    }
                  }}
                  placeholder="http://127.0.0.1:7897"
                  aria-label={t('代理地址')}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 w-[280px] font-mono text-xs"
                />
                {busy && <span className="text-[11px] text-muted-foreground">{t('保存中…')}</span>}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                {t('填好后按回车或点别处保存；也可以写 socks5://主机:端口。')}
              </p>
            </div>
          )}
        </>
      }
    >
      <Select value={activeMode} onValueChange={changeMode} disabled={busy}>
        <SelectTrigger className="w-[220px]" aria-label={t('网络代理')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROXY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {t(opt.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}
