import { create } from 'zustand';
import { t } from '@/i18n';
import { toast } from '@/stores/toast-store';
import { voiceApi } from '@/lib/voice/voice-client';
import { electronApi } from '@/lib/electron-ipc';
import { speechChunks } from '@/lib/voice/chunker';

/**
 * One player per window (one renderer, one store).
 *
 * Replies are spoken sentence by sentence: the first chunk can start playing
 * while the next two synthesize, which keeps time-to-first-sound short even
 * with a slow vendor. A generation token invalidates every in-flight request
 * when the user stops or starts another message.
 */

export type VoicePlaybackStatus = 'idle' | 'loading' | 'playing';

interface VoicePlaybackState {
  /** Message currently being read, if any. */
  messageId: string | null;
  status: VoicePlaybackStatus;
  /** 1-based index of the chunk playing (or loading). */
  current: number;
  total: number;
  speak: (messageId: string, text: string) => Promise<void>;
  stop: () => void;
}

const PREFETCH_AHEAD = 2;

let generation = 0;
let audioElement: HTMLAudioElement | null = null;
let cancelCurrentPlayback: (() => void) | null = null;
const objectUrls = new Set<string>();

function releaseAudio(): void {
  // Detach first: the cancel closure nulls `audioElement` (via finish()), so
  // pausing after calling it would be a no-op and the chunk would keep
  // playing underneath the next message.
  const element = audioElement;
  const cancel = cancelCurrentPlayback;
  audioElement = null;
  cancelCurrentPlayback = null;
  if (element) {
    element.pause();
    element.removeAttribute('src');
    element.load();
  }
  cancel?.();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

/** Tell plugins (keys are `plugin:<id>`) whether their read-aloud is playing. */
function notifyPluginPlayback(messageId: string | null, playing: boolean): void {
  if (!messageId || !messageId.startsWith('plugin:')) return;
  void voiceApi()?.notifyPlayback?.(messageId, playing).catch(() => undefined);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function playUrl(url: string, generationAtStart: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = new Audio(url);
    audioElement = element;
    const finish = () => {
      if (audioElement === element) audioElement = null;
      cancelCurrentPlayback = null;
    };
    element.onended = () => {
      finish();
      resolve();
    };
    element.onerror = () => {
      finish();
      reject(new Error(t('音频播放失败')));
    };
    cancelCurrentPlayback = () => {
      finish();
      resolve();
    };
    if (generation !== generationAtStart) {
      finish();
      resolve();
      return;
    }
    element.play().catch((err: unknown) => {
      finish();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export const useVoicePlaybackStore = create<VoicePlaybackState>((set, get) => ({
  messageId: null,
  status: 'idle',
  current: 0,
  total: 0,

  async speak(messageId, text) {
    const api = voiceApi();
    if (!api) {
      toast(t('仅桌面版可用'), 'error');
      return;
    }
    const chunks = speechChunks(text);
    if (chunks.length === 0) {
      toast(t('没有可朗读的文本'));
      return;
    }

    // A new read (chat or another plugin) takes over the single player; tell
    // the previous plugin owner that its clip is no longer playing.
    const previousMessage = get().messageId;
    if (previousMessage && previousMessage !== messageId) {
      notifyPluginPlayback(previousMessage, false);
    }
    // Drop whatever the previous read-aloud left queued in the worker. The
    // cancel is generation-scoped so a late message cannot kill this request.
    const previous = generation;
    void api.cancelSynthesis?.(previous).catch(() => undefined);
    const my = ++generation;
    releaseAudio();
    set({ messageId, status: 'loading', current: 0, total: chunks.length });
    notifyPluginPlayback(messageId, true);

    const cache = new Map<number, Promise<string>>();
    const load = (index: number): Promise<string> => {
      const existing = cache.get(index);
      if (existing) return existing;
      const promise = api
        .synthesize({ text: chunks[index], generation: my })
        .then((result) => {
          if (generation !== my) throw new Error('cancelled');
          const bytes = base64ToBytes(result.audioBase64);
          const url = URL.createObjectURL(
            new Blob([Uint8Array.from(bytes)], { type: result.mimeType || 'audio/mpeg' }),
          );
          objectUrls.add(url);
          return url;
        });
      cache.set(index, promise);
      return promise;
    };

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (generation !== my) return;
        // Send the current chunk first: the worker synthesizes in arrival
        // order, so prefetching before it would delay the first sound by two
        // whole sentences.
        const current = load(index);
        for (let ahead = index + 1; ahead <= index + PREFETCH_AHEAD && ahead < chunks.length; ahead += 1) {
          load(ahead).catch(() => undefined);
        }

        const url = await current;
        if (generation !== my) return;
        set({ status: 'playing', current: index + 1 });
        await playUrl(url, my);
      }
      if (generation === my) {
        releaseAudio();
        notifyPluginPlayback(messageId, false);
        set({ messageId: null, status: 'idle', current: 0, total: 0 });
      }
    } catch (err) {
      if (generation !== my) return;
      releaseAudio();
      notifyPluginPlayback(messageId, false);
      set({ messageId: null, status: 'idle', current: 0, total: 0 });
      const message = err instanceof Error ? err.message : String(err);
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || /NotAllowedError/.test(message)) {
        toast(t('播放被浏览器阻止，请点击朗读'), 'error');
      } else {
        toast(t('语音合成失败：{message}', { message }), 'error');
      }
    }
  },

  stop() {
    notifyPluginPlayback(get().messageId, false);
    const previous = generation;
    generation += 1;
    void voiceApi()?.cancelSynthesis?.(previous).catch(() => undefined);
    releaseAudio();
    set({ messageId: null, status: 'idle', current: 0, total: 0 });
  },
}));

export function stopSpeaking(): void {
  getVoiceState().stop();
}

/** Read text on behalf of a plugin; `key` doubles as the playback identity. */
export function speakExternal(key: string, text: string): Promise<void> {
  return getVoiceState().speak(key, text);
}

/** Plugin shortcut toggle: stop this plugin's current read, otherwise start. */
export function toggleExternal(key: string, text: string): void {
  const state = getVoiceState();
  if (state.messageId === key && state.status !== 'idle') state.stop();
  else void state.speak(key, text);
}

/**
 * Host → renderer bridge for the `voice.speak` / `voice.stop` plugin
 * capabilities. Same one-way relay pattern as `pi:chat:send`.
 */
let pluginVoiceBridgeInstalled = false;

export function initPluginVoiceBridge(): void {
  // React StrictMode mounts effects twice in development; a second listener
  // would make every toggle-speak stop itself.
  if (pluginVoiceBridgeInstalled) return;
  const api = electronApi();
  if (!api?.on) return;
  pluginVoiceBridgeInstalled = true;
  api.on('pi:voice:speak', (payload) => {
    const request = payload as { text?: unknown; key?: unknown; toggle?: unknown } | undefined;
    const text = typeof request?.text === 'string' ? request.text : '';
    if (!text.trim()) return;
    const key = typeof request?.key === 'string' && request.key ? request.key : 'plugin';
    if (request?.toggle !== false) toggleExternal(key, text);
    else void speakExternal(key, text);
  });
  api.on('pi:voice:stop', () => stopSpeaking());
}

function getVoiceState() {
  return useVoicePlaybackStore.getState();
}
