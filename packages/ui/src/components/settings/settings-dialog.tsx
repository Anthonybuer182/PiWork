import { useEffect, useState } from 'react';
import {
  AudioLines,
  Cable,
  Cpu,
  FileText,
  Hammer,
  HardDrive,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { useI18n, type MessageKey } from '@/i18n';
import { hasVoiceApi } from '@/lib/voice/voice-client';
import { hasStorageApi } from '@/lib/storage-client';
import { hasMcpApi } from '@/lib/mcp-client';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { GeneralSettingsPage } from './general-settings';
import { ModelsSettingsPage } from './models-settings';
import { ContextSettingsPage } from './context-settings';
import { StorageSettingsPage } from './storage-settings';
import { SkillsSettingsPage } from './skills-settings';
import { ToolsSettingsPage } from './tools-settings';
import { VoiceSettingsPage } from './voice-settings';
import { McpSettingsPage } from './mcp-settings';

type SectionId = 'general' | 'models' | 'context' | 'storage' | 'voice' | 'tools' | 'skills' | 'mcp';

const SECTIONS: { id: SectionId; label: MessageKey; icon: typeof Cpu }[] = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'models', label: '模型', icon: Cpu },
  { id: 'context', label: '上下文', icon: FileText },
  { id: 'storage', label: '存储', icon: HardDrive },
  { id: 'voice', label: '语音', icon: AudioLines },
  { id: 'tools', label: '工具', icon: Hammer },
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Cable },
];

/**
 * Settings, as a centred dialog with its own side menu.
 *
 * The left column cannot host this: at its ~300px the provider forms and a
 * skill list are cramped, and widening the sidebar to fit them would fight the
 * drag-to-collapse layout. Configuration is also a deliberate interruption —
 * it reads as a dialog, not as another view competing with the conversation.
 *
 * While open, every native panel view is hidden (LiveSlot reports degenerate
 * bounds): those views paint above the DOM and would otherwise cover this
 * dialog and swallow its clicks.
 *
 * Pages save as you change them; there is no Save/Cancel, so dismissing the
 * dialog never loses work.
 */
export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const { t } = useI18n();
  const [section, setSection] = useState<SectionId>('general');

  // ⌘, / Ctrl+, — the platform's settings shortcut, active while the shell
  // has focus. (A native plugin view is its own web contents, so a key pressed
  // inside it never reaches this listener; the rail button still works.)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // `repeat` matters: holding the chord would otherwise toggle the dialog
      // on every OS key-repeat and leave it in an arbitrary state.
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        useUIStore.getState().setSettingsOpen(!useUIStore.getState().settingsOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Voice is desktop-only: the web build has no microphone bridge or TTS
  // playback path, so the section is absent rather than broken. Storage is
  // likewise about a directory the desktop app owns.
  const sections = SECTIONS.filter(
    (s) => (s.id !== 'voice' || hasVoiceApi())
      && (s.id !== 'storage' || hasStorageApi())
      && (s.id !== 'mcp' || hasMcpApi()),
  );
  const active = sections.find((s) => s.id === section) ?? sections[0];

  return (
    <Dialog open={open} onOpenChange={setSettingsOpen}>
      <DialogContent
        data-testid="settings-dialog"
        // A click on the dimmed backdrop must not discard a half-finished
        // form. Esc and the close button remain.
        onInteractOutside={(e) => e.preventDefault()}
        className="h-[min(680px,calc(100vh-96px))] w-[min(940px,calc(100vw-96px))] max-w-none gap-0 overflow-hidden p-0 outline-hidden sm:rounded-xl"
      >
        <DialogTitle className="sr-only">{t('设置')}</DialogTitle>
        <DialogDescription className="sr-only">{t('配置模型服务商、技能和通用选项')}</DialogDescription>

        {/* `min-w-0` matters: as a grid item the default `min-width: auto`
            lets a nowrap child (a long tool description) stretch the whole
            dialog past the viewport instead of truncating. */}
        <div className="flex h-full min-h-0 w-full min-w-0">
          <nav
            aria-label={t('设置分类')}
            className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-3"
          >
            <div className="px-2.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('设置')}
            </div>
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? 'true' : undefined}
                data-settings-section={id}
                onClick={() => setSection(id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  section === id
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {t(label)}
              </button>
            ))}
            <div className="mt-auto px-2.5 pt-3 text-[10px] leading-relaxed text-muted-foreground/70">
              {t('改动即时保存，关掉不丢。')}
            </div>
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b px-6">
              <h2 className="text-sm font-semibold">{t(active.label)}</h2>
            </div>
            <div className="min-h-0 flex-1">
              {section === 'general' && <GeneralSettingsPage />}
              {section === 'models' && <ModelsSettingsPage />}
              {section === 'context' && <ContextSettingsPage />}
              {section === 'storage' && hasStorageApi() && <StorageSettingsPage />}
              {section === 'voice' && hasVoiceApi() && <VoiceSettingsPage />}
              {section === 'tools' && <ToolsSettingsPage />}
              {section === 'skills' && <SkillsSettingsPage />}
              {section === 'mcp' && hasMcpApi() && <McpSettingsPage />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
