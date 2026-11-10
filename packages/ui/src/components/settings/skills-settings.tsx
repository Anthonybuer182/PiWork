import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderPlus, Loader2, Sparkles, X } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useI18n } from '@/i18n';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { LoadingSpinner } from '@/components/common/loading-spinner';

/**
 * 技能 — what the agent can be told it knows how to do.
 *
 * This page lists discovered skills, switches each one on or off, and manages
 * extra search directories (written to `settings.skills`). The switch is a
 * UI-level availability list (the SDK has no global skill flag): a disabled
 * skill is hidden from the composer and never used. A new conversation starts
 * with every enabled skill; the composer's checkboxes override that for one
 * conversation only.
 */
export function SkillsSettingsPage() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const disabledSkills = useUIStore((s) => s.disabledSkills);
  const toggleSkillEnabled = useUIStore((s) => s.toggleSkillEnabled);

  const {
    data: skills,
    isLoading,
    error: skillsError,
    refetch: refetchSkills,
  } = useQuery({
    queryKey: ['skills'],
    queryFn: () => sdk.config.listSkills(),
  });

  const {
    data: extraPaths,
    isLoading: pathsLoading,
    error: pathsError,
    refetch: refetchPaths,
  } = useQuery({
    queryKey: ['skillPaths'],
    queryFn: () => sdk.config.getSkillPaths(),
  });

  const savePaths = useMutation({
    mutationFn: (paths: string[]) => sdk.config.setSkillPaths(paths),
    onSuccess: (_result, paths) => {
      setError(null);
      // Write the result straight into the cache: the refetch below is async,
      // and a second add/remove landing before it would otherwise read the
      // previous list and drop the change just made.
      queryClient.setQueryData(['skillPaths'], paths);
      void queryClient.invalidateQueries({ queryKey: ['skillPaths'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-context'] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const addDirectory = async () => {
    setError(null);
    try {
      const picked = (await sdk.transport.request('system.selectDirectory')) as string | null;
      if (!picked) return;
      // Read at resolve time, not from the render that opened the picker: the
      // query may have arrived while the folder chooser was up, and the
      // closure's list would be stale (saving it would drop the new entries).
      const current = queryClient.getQueryData<string[]>(['skillPaths']);
      if (!current) {
        setError(t('技能目录还没读取完成，请稍后再试'));
        return;
      }
      if (current.includes(picked)) return;
      savePaths.mutate([...current, picked]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeDirectory = (path: string) => {
    const current = queryClient.getQueryData<string[]>(['skillPaths']);
    if (!current) return;
    savePaths.mutate(current.filter((p) => p !== path));
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-5">
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">{t('已发现的技能')}</h3>
          {!isLoading && !skillsError && skills && (
            <span className="text-xs text-muted-foreground">
              {t('{enabled} / {total} 启用', {
                enabled: skills.filter((s) => !disabledSkills.includes(s.id)).length,
                total: skills.length,
              })}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t(
            '每个技能可以单独开关；关闭后不会出现在输入框的技能菜单里。打开的技能默认用于新会话，可在输入框里按本次会话临时取消。',
          )}
        </p>

        <div className="mt-3">
          {skillsError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {t('读取技能失败：{error}', {
                  error: skillsError instanceof Error ? skillsError.message : String(skillsError),
                })}
              </span>
              <button
                type="button"
                onClick={() => void refetchSkills()}
                className="shrink-0 underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('重试')}
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoadingSpinner />
            </div>
          ) : skills && skills.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {skills.map((skill) => {
                const enabled = !disabledSkills.includes(skill.id);
                return (
                  <li key={skill.id} className="flex items-start gap-3 px-3 py-2.5">
                    <Sparkles
                      className={cn(
                        'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground',
                        !enabled && 'opacity-40',
                      )}
                    />
                    <div className={cn('min-w-0 flex-1', !enabled && 'opacity-60')}>
                      <div className="truncate text-sm">{skill.name}</div>
                      {skill.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {skill.description}
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={enabled}
                      onCheckedChange={() => toggleSkillEnabled(skill.id)}
                      aria-label={t('启用 {name}', { name: skill.name })}
                      data-skill-id={skill.id}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
              {t('还没有发现技能。技能是带 SKILL.md 的目录，放进下面任一位置即可。')}
            </div>
          )}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">{t('额外技能目录')}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void addDirectory()}
            disabled={savePaths.isPending || pathsLoading || !!pathsError}
          >
            {savePaths.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus className="mr-1 h-3.5 w-3.5" />
            )}
            {t('添加目录')}
          </Button>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t(
            '这些目录写入全局设置，对所有工作区生效（工作区的 .pi/settings.json 若配置了技能目录会整体覆盖这里）。扫描顺序是 ~/.agents/skills、额外目录、~/.pi/agent/skills、工作区，同名技能以靠前的为准。',
          )}
        </p>

        <div className="mt-3 space-y-3">
          <div className="rounded-md border bg-muted/20 px-3 py-2.5">
            <div className="text-[11px] font-medium text-muted-foreground">{t('内置位置')}</div>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
              <li>~/.agents/skills</li>
              <li>~/.pi/agent/skills</li>
              <li>&lt;{t('工作区')}&gt;/.pi/skills</li>
            </ul>
          </div>

          {pathsError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {t('读取额外目录失败：{error}', {
                  error: pathsError instanceof Error ? pathsError.message : String(pathsError),
                })}
              </span>
              <button
                type="button"
                onClick={() => void refetchPaths()}
                className="shrink-0 underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('重试')}
              </button>
            </div>
          ) : pathsLoading ? (
            <p className="text-xs text-muted-foreground">{t('读取中…')}</p>
          ) : extraPaths && extraPaths.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {extraPaths.map((path) => (
                <li key={path} className="flex items-center gap-2 px-3 py-2">
                  <code className="min-w-0 flex-1 break-all text-[11px]">{path}</code>
                  <button
                    type="button"
                    aria-label={t('{path} 移除', { path })}
                    onClick={() => removeDirectory(path)}
                    disabled={savePaths.isPending}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('没有额外目录。')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
