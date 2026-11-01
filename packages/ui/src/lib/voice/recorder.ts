/**
 * Microphone capture for speech input.
 *
 * MediaRecorder records webm/opus (Chromium) or mp4 (Safari), which vendors do
 * not agree on; decoding and re-encoding to 16 kHz WAV here gives every
 * adapter the same bytes. Callers map `describeMicrophoneError` to a toast.
 */

import { floatTo16BitPcmWav16k } from './wav';

export interface RecordedAudio {
  wav: Uint8Array;
  durationMs: number;
}

export interface RecordingSession {
  stop: () => Promise<RecordedAudio>;
  cancel: () => void;
}

export interface StartRecordingOptions {
  /** Hard stop for forgotten recordings; default 120 s. */
  maxDurationMs?: number;
  onLimit?: () => void;
}

const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export async function startMicrophoneRecording(
  options: StartRecordingOptions = {},
): Promise<RecordingSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const parts: Blob[] = [];
  const startedAt = performance.now();
  let finished = false;

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) parts.push(event.data);
  });
  recorder.start(250);

  const maxDurationMs = options.maxDurationMs ?? 120_000;
  const limitTimer = setTimeout(() => {
    if (!finished) options.onLimit?.();
  }, maxDurationMs);

  const cleanup = () => {
    finished = true;
    clearTimeout(limitTimer);
    for (const track of stream.getTracks()) track.stop();
  };

  const stop = (): Promise<RecordedAudio> =>
    new Promise((resolve, reject) => {
      if (finished) {
        reject(new Error('录音已经结束'));
        return;
      }
      const durationMs = performance.now() - startedAt;
      recorder.addEventListener(
        'stop',
        () => {
          const cleanupAfterStop = cleanup;
          cleanupAfterStop();
          void (async () => {
            try {
              const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' });
              if (blob.size === 0) throw new Error('没有录到声音，请再试一次');
              const buffer = await blob.arrayBuffer();
              const audio = await decodeMono(buffer);
              resolve({ wav: audio, durationMs });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              reject(
                /decode/i.test(message) || message === 'EncodingError'
                  ? new Error('录音解码失败，请再试一次')
                  : err instanceof Error
                    ? err
                    : new Error(message),
              );
            }
          })();
        },
        { once: true },
      );
      try {
        recorder.stop();
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  const cancel = () => {
    if (finished) return;
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
    cleanup();
  };

  return { stop, cancel };
}

async function decodeMono(buffer: ArrayBuffer): Promise<Uint8Array> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));
    if (decoded.numberOfChannels === 0 || decoded.length === 0) {
      throw new Error('录音为空，请再试一次');
    }
    const channel = decoded.getChannelData(0);
    return floatTo16BitPcmWav16k(channel, decoded.sampleRate);
  } finally {
    void context.close();
  }
}

/** Human-readable Chinese reason for the two common capture failures. */
export function describeMicrophoneError(err: unknown): string {
  const name = (err as { name?: string } | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝，请在系统设置中允许访问麦克风';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '未找到可用的麦克风';
  }
  if (name === 'NotReadableError') {
    return '麦克风正被其他应用占用';
  }
  return err instanceof Error ? err.message : String(err);
}
