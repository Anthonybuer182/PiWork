import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/toast-store';
import { voiceApi } from '@/lib/voice/voice-client';
import {
  describeMicrophoneError,
  startMicrophoneRecording,
  type RecordingSession,
} from '@/lib/voice/recorder';
import { Button } from '@/components/ui/button';

type MicState = 'idle' | 'recording' | 'processing';

/**
 * Microphone button for the composer.
 *
 * Click to start, click again to stop and transcribe. The transcript goes
 * through `onTranscribed`; whether that sends immediately is the composer's
 * decision (`autoSend`), so this button stays unaware of chat state.
 */
export function VoiceInputButton({
  disabled,
  configured = true,
  needsModelDownload = false,
  sessionId,
  onTranscribed,
}: {
  disabled?: boolean;
  /** False when no STT provider is set: tell the user instead of recording. */
  configured?: boolean;
  /** The built-in is enabled but its model has not been downloaded yet. */
  needsModelDownload?: boolean;
  /** Conversation that owns the recording; a switch drops the transcript. */
  sessionId?: string | null;
  onTranscribed: (text: string, recordedInSession: string | null) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<MicState>('idle');
  const sessionRef = useRef<RecordingSession | null>(null);
  const busyRef = useRef(false);
  const startingRef = useRef(false);
  const ownerSessionRef = useRef<string | null>(null);

  const finish = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || busyRef.current) return;
    busyRef.current = true;
    sessionRef.current = null;
    setState('processing');
    try {
      const recorded = await session.stop();
      const api = voiceApi();
      if (!api) throw new Error(t('仅桌面版可用'));
      const result = await api.transcribe({ audio: recorded.wav, mimeType: 'audio/wav' });
      const text = result.text.trim();
      if (!text) {
        toast(t('没有识别到文字'));
        return;
      }
      onTranscribed(text, ownerSessionRef.current);
    } catch (err) {
      toast(t('语音识别失败：{message}', { message: describeError(err) }), 'error');
    } finally {
      busyRef.current = false;
      setState('idle');
    }
  }, [onTranscribed, t]);

  const cancel = useCallback(() => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    ownerSessionRef.current = null;
    setState('idle');
    toast(t('录音已取消'));
  }, [t]);

  const start = useCallback(async () => {
    if (busyRef.current || startingRef.current) return;
    if (!configured) {
      toast(
        t(
          needsModelDownload
            ? '内置语音识别模型尚未下载，请在设置 → 语音中下载。'
            : '语音识别未配置，请先在设置 → 语音中配置。',
        ),
        'error',
      );
      return;
    }
    // getUserMedia can wait for a permission prompt; a second click during
    // that window would orphan the first MediaStream and leave the mic on.
    startingRef.current = true;
    try {
      const session = await startMicrophoneRecording({
        onLimit: () => {
          toast(t('录音上限 2 分钟，已自动停止'));
          void finish();
        },
      });
      sessionRef.current = session;
      ownerSessionRef.current = sessionId ?? null;
      setState('recording');
    } catch (err) {
      toast(t('无法访问麦克风：{message}', { message: describeMicrophoneError(err) }), 'error');
    } finally {
      startingRef.current = false;
    }
  }, [configured, needsModelDownload, sessionId, finish, t]);

  // Esc cancels a recording instead of closing anything else.
  useEffect(() => {
    if (state !== 'recording') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, cancel]);

  // Leaving the composer mid-recording must not keep the microphone open.
  useEffect(
    () => () => {
      sessionRef.current?.cancel();
      ownerSessionRef.current = null;
    },
    [],
  );

  if (!voiceApi()) return null;

  const recording = state === 'recording';
  const processing = state === 'processing';

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled || processing}
      data-testid="voice-mic-button"
      aria-label={t(
        recording ? '停止录音并转写' : processing ? '正在识别…' : '开始语音输入',
      )}
      title={t(recording ? '录音中，点击停止' : '开始语音输入')}
      onClick={() => (recording ? void finish() : void start())}
      className={cn(
        'h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground',
        recording && 'text-destructive hover:text-destructive',
      )}
    >
      {processing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Mic className={cn('h-4 w-4', recording && 'animate-pulse')} />
      )}
    </Button>
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
