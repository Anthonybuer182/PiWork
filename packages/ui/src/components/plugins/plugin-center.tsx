import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trash2, CircleAlert, CircleCheck, Settings2, ChevronDown, Puzzle, Undo2, Search, Info } from 'lucide-react';
import type { MarketEntry, PluginInfo, PluginSettingInfo } from '@pi/types';
import { describePermission, MIN_SUPPORTED_API_VERSION, PLUGIN_PROTOCOL_VERSION } from '@pi/types';
import { usePluginStore } from '@/stores/plugin-store';
import { useI18n, type MessageKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<string, MessageKey> = { dev: '开发', user: '已安装' };
const STATE_LABEL: Record<string, MessageKey> = {
  active: '运行中', activating: '启动中', registered: '已注册', disabled: '已禁用',
  incompatible: '不兼容', error: '错误', crashed: '已崩溃',
};

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Search matches name, id and description; Chinese substrings work as-is. */
function matchesQuery(text: string | undefined, q: string): boolean {
  return (text ?? '').toLowerCase().includes(q);
}

/** ── Auto-generated settings form (contributes.settings) ── */
function PluginSettingsSection({ pluginId, settings }: { pluginId: string; settings: PluginSettingInfo[] }) {
  const { t } = useI18n();
  const loadPluginSettings = usePluginStore((s) => s.loadPluginSettings);
  const setPluginSetting = usePluginStore((s) => s.setPluginSetting);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || values) return;
    loadPluginSettings(pluginId).then(setValues);
  }, [open, values, pluginId, loadPluginSettings]);

  const update = (key: string, value: unknown) => {
    setValues((v) => ({ ...(v ?? {}), [key]: value }));
    setPluginSetting(pluginId, key, value);
  };

  return (
    <div className="mt-2 rounded-md border border-dashed p-2" data-plugin-settings={pluginId}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings2 className="h-3 w-3" />
        {t('插件设置({count})', { count: settings.length })}
        <ChevronDown className={cn('ml-auto h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2.5">
          {!values && <div className="text-xs text-muted-foreground">{t('加载中…')}</div>}
          {values && settings.map((setting) => (
            <div key={setting.key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium">{setting.label ?? setting.key}</div>
                {setting.description ? <div className="text-[10px] text-muted-foreground">{setting.description}</div> : null}
              </div>
              {setting.type === 'boolean' ? (
                <Switch
                  checked={values[setting.key] === true}
                  onCheckedChange={(checked) => update(setting.key, checked)}
                  aria-label={setting.label ?? setting.key}
                  data-setting-key={setting.key}
                />
              ) : setting.type === 'enum' && setting.options?.length ? (
                <select
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                  value={String(values[setting.key] ?? '')}
                  onChange={(e) => update(setting.key, e.target.value)}
                  data-setting-key={setting.key}
                >
                  {setting.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <Input
                  className="h-7 w-44 text-xs"
                  type={setting.type === 'number' ? 'number' : 'text'}
                  value={String(values[setting.key] ?? '')}
                  onChange={(e) => update(setting.key, setting.type === 'number' ? Number(e.target.value) : e.target.value)}
                  data-setting-key={setting.key}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** ── Plugin brand icon (plugin-provided stencil, Puzzle fallback) ── */
function PluginBrandIcon({ iconUrl, name }: { iconUrl?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!iconUrl) return;
    const probe = new Image();
    probe.onerror = () => setBroken(true);
    probe.src = iconUrl;
    return () => { probe.onerror = null; };
  }, [iconUrl]);
  if (iconUrl && !broken) {
    return (
      <span
        role="img"
        aria-label={name}
        className="mt-0.5 shrink-0 bg-current text-muted-foreground"
        style={{
          width: 32,
          height: 32,
          WebkitMaskImage: `url(${iconUrl})`,
          maskImage: `url(${iconUrl})`,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    );
  }
  return <Puzzle className="mt-0.5 h-8 w-8 shrink-0 text-muted-foreground/50" />;
}

/** ── Installed plugin row ── */
function InstalledItem({ plugin }: { plugin: PluginInfo }) {
  const { t, language } = useI18n();
  const setPluginEnabled = usePluginStore((s) => s.setPluginEnabled);
  const uninstallPlugin = usePluginStore((s) => s.uninstallPlugin);
  const installPlugin = usePluginStore((s) => s.installPlugin);
  const rollbackPlugin = usePluginStore((s) => s.rollbackPlugin);
  const catalog = usePluginStore((s) => s.catalog);
  const installPhases = usePluginStore((s) => s.installPhases);
  const mutedPlugins = usePluginStore((s) => s.mutedPlugins);
  const setPluginMuted = usePluginStore((s) => s.setPluginMuted);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const [busy, setBusy] = useState(false);

  // Only a plugin that actually lives in the user's plugin root can be
  // replaced, rolled back, or uninstalled there — a dev copy's directory is
  // the checkout's source tree, and removing it is never what "uninstall"
  // means. The trash button is ALWAYS visible (VS Code never hides the
  // affordance either); for a dev plugin the dialog explains instead of
  // deleting, and the backend refuses the call regardless.
  const manageable = plugin.source === 'user';
  const marketEntry = catalog.find((e) => e.id === plugin.id);
  const inMarket = marketEntry !== undefined;
  const broken = plugin.state === 'error' || plugin.state === 'crashed';
  // Update availability lives here on the installed row — installed plugins
  // are excluded from the market section below, so this badge is the only
  // place version drift shows. Dev copies are excluded from the comparison:
  // their version tracks the checkout, not the market.
  const updatable = manageable && marketEntry != null && marketEntry.version !== plugin.version;

  const sourceLabel = (source: string) =>
    SOURCE_LABEL[source] ? t(SOURCE_LABEL[source]) : source;
  const stateLabel = (state: string) => (STATE_LABEL[state] ? t(STATE_LABEL[state]) : state);

  const stateBadge = () => {
    if (plugin.state === 'disabled') return <Badge variant="secondary">{t('已禁用')}</Badge>;
    if (plugin.state === 'incompatible' || plugin.state === 'error')
      return <Badge variant="destructive">{stateLabel(plugin.state)}</Badge>;
    if (plugin.state === 'active')
      return <Badge variant="outline" className="gap-1 text-emerald-600"><CircleCheck className="h-3 w-3" />{t('运行中')}</Badge>;
    return <Badge variant="outline">{stateLabel(plugin.state)}</Badge>;
  };

  return (
    <div data-installed-plugin={plugin.id} className="flex items-start gap-3 rounded-lg border p-3">
      <PluginBrandIcon iconUrl={plugin.iconUrl} name={plugin.name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{plugin.name}</span>
          <span className="text-xs text-muted-foreground">v{plugin.version}</span>
          <Badge variant="secondary">{sourceLabel(plugin.source)}</Badge>
          {stateBadge()}
          {updatable && marketEntry ? (
            <Badge variant="secondary">
              {t('可更新({from} → {to})', {
                from: plugin.version,
                to: marketEntry.version,
              })}
            </Badge>
          ) : null}
        </div>
        {plugin.description ? <div className="mt-1 text-xs text-muted-foreground">{plugin.description}</div> : null}
        {plugin.shadowed?.length ? (
          // Discovery loads one copy per id and drops the rest without a word.
          // A dev root beating the user's installed copy is the normal state of
          // plugin authoring, so this is a fact to state, not an error.
          <div
            className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-muted-foreground"
            data-shadowed-copy={plugin.id}
            title={plugin.shadowed.map((s) => `${s.rootPath} (v${s.version})`).join('\n')}
          >
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {plugin.shadowed
                .map((s) =>
                  t('{source}副本 v{version}', {
                    source: sourceLabel(s.source),
                    version: s.version,
                  }),
                )
                .join(language === 'en' ? ', ' : '、')}
              {' '}
              {t('未加载（被当前副本遮蔽）')}
            </span>
          </div>
        ) : null}
        {plugin.source === 'dev' ? (
          <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {t('当前加载的是仓库开发副本，插件中心不能替换或卸载它。测试客户的安装/更新路径请用')}
            <span className="font-mono"> pnpm dev:desktop</span>
            {language === 'en' ? '.' : '。'}
          </div>
        ) : null}
        {plugin.error ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />{plugin.error}
          </div>
        ) : null}
        {plugin.permissions.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {plugin.permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px] font-normal">{p}</Badge>
            ))}
          </div>
        ) : null}

        {plugin.permissions.includes('messages') ? (
          <div
            className="mt-2 flex items-center justify-between gap-3 rounded-md border border-dashed px-2 py-1.5"
            data-plugin-messages-mute={plugin.id}
          >
            <div className="text-xs text-muted-foreground">{t('在会话里显示插件消息')}</div>
            <Switch
              checked={!mutedPlugins.includes(plugin.id)}
              onCheckedChange={(checked) => void setPluginMuted(plugin.id, !checked)}
              aria-label={t('在会话里显示插件消息')}
              data-plugin-messages-mute-switch={plugin.id}
            />
          </div>
        ) : null}

        {/*
          The way out of a plugin that will not run.

          `重装` re-fetches from the market — right for a corrupted copy, useless
          when the published version itself is what broke. That case needs
          `回到上一版`, which only exists after an upgrade; the label names the
          version so it is clear what the button would do.
        */}
        {manageable && (broken || plugin.previousVersion || updatable) ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* Update goes through the market row's InstallButton so the
                permission-consent dialog applies to updates too — a new
                version may declare new permissions. */}
            {updatable && marketEntry ? (
              <InstallButton
                entry={marketEntry}
                phase={installPhases[plugin.id]}
                installed
                updatable
                onInstall={() => installPlugin(plugin.id)}
              />
            ) : null}
            {broken && inMarket ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void installPlugin(plugin.id).finally(() => setBusy(false));
                }}
              >
                <RefreshCw className="mr-1 h-3 w-3" />{t('重装')}
              </Button>
            ) : null}
            {plugin.previousVersion ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void rollbackPlugin(plugin.id).finally(() => setBusy(false));
                }}
              >
                <Undo2 className="mr-1 h-3 w-3" />
                {t('回到 v{version}', { version: plugin.previousVersion })}
              </Button>
            ) : null}
          </div>
        ) : null}
        {plugin.settings?.length ? <PluginSettingsSection pluginId={plugin.id} settings={plugin.settings} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={plugin.state !== 'disabled'}
          disabled={plugin.state === 'incompatible' || busy}
          onCheckedChange={(checked) => {
            setBusy(true);
            setPluginEnabled(plugin.id, checked).finally(() => setBusy(false));
          }}
          aria-label={t('启用/禁用 {name}', { name: plugin.name })}
        />
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setConfirmOpen(true)} aria-label={t('卸载 {name}', { name: plugin.name })}>
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>

      {/* Uninstall dialog — two variants.
        * user copy: confirm, with data retention opt-out.
        * dev copy: never deletes. The dialog explains where the plugin really
        * lives and what removal would actually mean — the affordance stays
        * visible (hiding it just made "how do I uninstall" undiscoverable),
        * but the repo source tree is not what a dialog gets to rm. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          {manageable ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('卸载「{name}」?', { name: plugin.name })}</DialogTitle>
                <DialogDescription>
                  {t('将删除插件代码目录。插件数据默认保留,重装后可恢复。')}
                </DialogDescription>
              </DialogHeader>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={keepData} onCheckedChange={setKeepData} aria-label={t('保留插件数据')} />
                {t('保留插件数据(plugins-data/{id})', { id: plugin.id })}
              </label>
              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>{t('取消')}</Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    setConfirmOpen(false);
                    setBusy(true);
                    await uninstallPlugin(plugin.id, keepData);
                    setBusy(false);
                  }}
                >
                  {t('卸载')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('「{name}」是开发副本', { name: plugin.name })}</DialogTitle>
                <DialogDescription>
                  {t('它直接运行自仓库源码目录,不是安装副本,因此没有"卸载"可言。要移除:从仓库 plugins/ 删除对应目录,或把它从 dev 根里拿走;只想停用的话,用左侧的开关就够了。')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>{t('知道了')}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Catalog row. Only ever rendered for entries that are NOT installed — the
 * market section excludes installed ids, so the「已安装/可更新」badges this
 * row used to carry live on the installed row instead, and each plugin
 * appears in exactly one section. While an install runs the phase spinner
 * takes the button's place; on success the row migrates to the installed
 * section above.
 */
function CatalogItem({ entry }: { entry: MarketEntry }) {
  const { t } = useI18n();
  const installPhases = usePluginStore((s) => s.installPhases);
  const marketErrors = usePluginStore((s) => s.marketErrors);
  const installPlugin = usePluginStore((s) => s.installPlugin);

  const phase = installPhases[entry.id];
  const error = marketErrors[entry.id];

  // Catalog-level apiVersion pre-check (stageInstall enforces the same range
  // against the manifest inside the zip and stays authoritative — the index
  // could lie). Saying why beats offering a button that only fails after the
  // download. Old indexes without apiVersion are simply not checked here.
  const outOfRange =
    entry.apiVersion !== undefined &&
    (entry.apiVersion < MIN_SUPPORTED_API_VERSION || entry.apiVersion > PLUGIN_PROTOCOL_VERSION);
  const rangeNote =
    entry.apiVersion === undefined
      ? null
      : entry.apiVersion < MIN_SUPPORTED_API_VERSION
        ? t('插件协议过旧({version},本机支持 {min}–{max}),请找作者更新', {
            version: entry.apiVersion,
            min: MIN_SUPPORTED_API_VERSION,
            max: PLUGIN_PROTOCOL_VERSION,
          })
        : t('插件比客户端新({version},本机支持 {min}–{max}),请升级客户端', {
            version: entry.apiVersion,
            min: MIN_SUPPORTED_API_VERSION,
            max: PLUGIN_PROTOCOL_VERSION,
          });

  return (
    <div data-catalog-plugin={entry.id} className="flex items-start gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{entry.name}</span>
          <span className="text-xs text-muted-foreground">v{entry.version}</span>
          {outOfRange ? <Badge variant="destructive">{rangeNote}</Badge> : null}
          {entry.size ? <span className="text-[10px] text-muted-foreground">{formatSize(entry.size)}</span> : null}
        </div>
        {entry.description ? <div className="mt-1 text-xs text-muted-foreground">{entry.description}</div> : null}
        {entry.permissions?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {entry.permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px] font-normal">{p}</Badge>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />{error}
          </div>
        ) : null}
      </div>
      {outOfRange ? null : (
        <InstallButton entry={entry} phase={phase} installed={false} updatable={false} onInstall={() => installPlugin(entry.id)} />
      )}
    </div>
  );
}

function InstallButton({
  entry, phase, installed, updatable, onInstall,
}: {
  entry: MarketEntry;
  phase?: string;
  installed: boolean;
  updatable: boolean;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const [consentOpen, setConsentOpen] = useState(false);

  if (phase) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {phase === 'downloading'
          ? t('下载中')
          : phase === 'verifying'
            ? t('校验中')
            : phase === 'installing'
              ? t('安装中')
              : t('启动中')}
      </div>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant={installed ? (updatable ? 'default' : 'secondary') : 'default'}
        onClick={() => setConsentOpen(true)}
        data-install-trigger={entry.id}
      >
        {installed ? (updatable ? t('更新') : t('重装')) : t('安装')}
      </Button>

      {/* Permission consent dialog */}
      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('安装「{name}」', { name: entry.name })}</DialogTitle>
            <DialogDescription>
              {t('该插件声明以下权限,安装后即可使用:')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-1">
            {(entry.permissions?.length ? entry.permissions : []).map((p) => {
              const meta = describePermission(p);
              return (
                <div key={p} className="flex items-start gap-2 rounded-md border p-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{meta.label}<span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{p}</span></div>
                    <div className="text-xs text-muted-foreground">{meta.description}</div>
                  </div>
                </div>
              );
            })}
            {!entry.permissions?.length && <div className="text-xs text-muted-foreground">{t('该插件未声明任何权限。')}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConsentOpen(false)}>{t('取消')}</Button>
            <Button
              size="sm"
              onClick={() => {
                setConsentOpen(false);
                onInstall();
              }}
            >
              {t('确认安装')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Plugin center — two sections over one join of installed × market:
 * 「已安装」 first (enable / disable / uninstall / update), then「市场可用」
 * — every catalog entry NOT installed, installable with permission consent.
 * The search box filters both sections in place; it is a filter over what
 * is on screen, not a mode flip, so installing never yanks the list out
 * from under you. An empty query shows everything, which is what a fresh
 * install needs: zero installed plugins opens straight onto a browsable
 * market instead of an empty list behind a search box.
 */
export function PluginCenter() {
  const { t } = useI18n();
  const installed = usePluginStore((s) => s.installed);
  const catalog = usePluginStore((s) => s.catalog);
  const catalogLoading = usePluginStore((s) => s.catalogLoading);
  const catalogError = usePluginStore((s) => s.catalogError);
  const registryUrl = usePluginStore((s) => s.registryUrl);
  const loadCatalog = usePluginStore((s) => s.loadCatalog);
  const installPhases = usePluginStore((s) => s.installPhases);
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const sortedInstalled = useMemo(
    () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    [installed],
  );

  const visibleInstalled = useMemo(
    () =>
      searching
        ? sortedInstalled.filter((p) => [p.name, p.id, p.description].some((text) => matchesQuery(text, q)))
        : sortedInstalled,
    [searching, sortedInstalled, q],
  );

  // Market order is the catalog's array order — build-market writes it, and
  // for an official index that order IS the recommendation ranking.
  const visibleMarket = useMemo(() => {
    const installedIds = new Set(installed.map((p) => p.id));
    return catalog.filter(
      (e) =>
        !installedIds.has(e.id) &&
        (!searching || [e.name, e.id, e.description].some((text) => matchesQuery(text, q))),
    );
  }, [catalog, installed, searching, q]);

  return (
    <div className="h-full overflow-auto p-3" data-panel-kind="plugin-center">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('插件中心')}</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadCatalog(true)} aria-label={t('刷新市场')}>
          <RefreshCw className={cn('h-3.5 w-3.5', catalogLoading && 'animate-spin')} />
        </Button>
      </div>

      {/* Which index the install/update buttons read. A stale local market is
          exactly how "更新" silently does nothing useful. */}
      {registryUrl ? (
        <div className="-mt-1 mb-2 truncate text-[10px] text-muted-foreground" title={registryUrl} data-market-registry>
          {t('市场: {url}', { url: registryUrl })}
        </div>
      ) : null}

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('搜索插件…')}
          className="h-8 pl-7 text-xs"
          aria-label={t('搜索插件')}
          data-market-search
        />
      </div>

      {visibleInstalled.length > 0 && (
        <section className="mb-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('已安装({count})', { count: visibleInstalled.length })}
          </h3>
          <div className="flex flex-col gap-2">
            {visibleInstalled.map((plugin) => (
              <InstalledItem key={plugin.id} plugin={plugin} />
            ))}
          </div>
        </section>
      )}

      {/* The market section carries its own failure/loading states — a catalog
          error must not take the installed list down with it. */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {searching
            ? t('市场结果({count})', { count: visibleMarket.length })
            : t('市场可用({count})', { count: visibleMarket.length })}
        </h3>
        {catalogError ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            {t('市场加载失败:{error}', { error: catalogError })}
          </div>
        ) : catalogLoading ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            {t('市场加载中…')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleMarket.map((entry) => (
              <CatalogItem key={entry.id} entry={entry} />
            ))}
            {!searching && visibleMarket.length === 0 && (
              <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                {t('市场目录为空')}
              </div>
            )}
            {searching && visibleInstalled.length === 0 && visibleMarket.length === 0 && (
              <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                {t('没有匹配「{query}」的插件', { query: query.trim() })}
              </div>
            )}
          </div>
        )}
      </section>

      {Object.keys(installPhases).length > 0 && (
        <div className="mt-3 text-center text-[10px] text-muted-foreground">
          {t('安装进行中:{names}', { names: Object.keys(installPhases).join(', ') })}
        </div>
      )}
    </div>
  );
}
