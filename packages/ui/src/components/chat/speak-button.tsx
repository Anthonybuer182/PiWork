import { Volume2, Square } from 'lucide-react';
import { useI18n } from '@/i18n';
import { hasVoiceApi } from '@/lib/voice/voice-client';
import { useVoicePlaybackStore } from '@/stores/voice-playback-store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Read-aloud toggle for one assistant message.
 *
 * Subscribes only to its own playback state, so a change in the player does
 * not invalidate the memoized markdown bubble above it.
 */
export function SpeakButton({ messageId, text }: { messageId: string; text: string }) {
  const { t } = useI18n();
  const active = useVoicePlaybackStore(
    (state) => state.messageId === messageId && state.status !== 'idle',
  );
  const loading = useVoicePlaybackStore(
    (state) => state.messageId === messageId && state.status === 'loading',
  );
  const speak = useVoicePlaybackStore((state) => state.speak);
  const stop = useVoicePlaybackStore((state) => state.stop);

  if (!hasVoiceApi()) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 text-muted-foreground/50 hover:text-foreground"
          data-testid="speak-button"
          aria-pressed={active}
          aria-label={t(active ? '停止朗读' : '朗读')}
          onClick={() => {
            // Read the live store: a fast second click can land before this
            // component re-renders, and a stale `active` would start a second
            // read instead of stopping.
            const state = useVoicePlaybackStore.getState();
            if (state.messageId === messageId && state.status !== 'idle') stop();
            else void speak(messageId, text);
          }}
        >
          {active ? (
            <Square className="h-3 w-3" />
          ) : loading ? (
            <Volume2 className="h-3 w-3 animate-pulse" />
          ) : (
            <Volume2 className="h-3 w-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t(active ? '停止朗读' : '朗读')}</TooltipContent>
    </Tooltip>
  );
}
