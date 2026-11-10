import { Shield, ShieldAlert, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePermissionStore, type PermissionMode } from '@/stores/permission-store';
import { useI18n, type MessageKey } from '@/i18n';

const MODE_LABELS: Record<PermissionMode, { title: MessageKey; hint: MessageKey }> = {
  default: { title: '默认', hint: '高危操作逐条批准' },
  full: { title: '完全访问', hint: '不拦截，仅记录审计日志' },
};

/**
 * The permission mode toggle, in the composer's bottom tools row. Quiet in
 * default mode (icon only); loud in 完全访问 (red icon + label) because an
 * open door must stay visible — the choice carries to new sessions within a
 * run, and a restart closes the door again.
 *
 * Hidden in the web build: there is no main process to enforce anything, and
 * a toggle that only pretends would be worse than none.
 */
export function PermissionModeButton() {
  // One global mode, like the model and thinking-level pickers next to it.
  const mode = usePermissionStore((s) => s.mode);
  const setMode = usePermissionStore((s) => s.setMode);
  const { t } = useI18n();

  // Web build: no electronAPI → nothing enforces the gate → hide the control.
  if (
    !(window as unknown as { electronAPI?: unknown }).electronAPI
  ) {
    return null;
  }

  const isFull = mode === 'full';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={
            isFull
              ? 'h-7 gap-1.5 px-2 text-xs text-red-600 dark:text-red-400 hover:text-red-600 dark:hover:text-red-400'
              : 'h-7 gap-1.5 px-2 text-xs text-muted-foreground'
          }
          title={t('权限模式（全局，重启后恢复默认）')}
        >
          {isFull ? (
            <ShieldAlert className="h-3.5 w-3.5" />
          ) : (
            <Shield className="h-3.5 w-3.5" />
          )}
          {isFull && t(MODE_LABELS[mode].title)}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {(Object.keys(MODE_LABELS) as PermissionMode[]).map((key) => (
          <DropdownMenuItem
            key={key}
            onClick={() => setMode(key)}
            className="flex flex-col items-start gap-0.5 cursor-pointer"
          >
            <span
              className={
                key === 'full' ? 'text-red-600 dark:text-red-400 font-medium' : 'font-medium'
              }
            >
              {t(MODE_LABELS[key].title)}
              {mode === key && (
                <span className="ml-1.5 text-[10px] opacity-60">{t('当前')}</span>
              )}
            </span>
            <span className="text-[10px] text-muted-foreground font-normal">
              {t(MODE_LABELS[key].hint)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
