import type { VoiceProviderEntry } from '@pi/types';

/** A provider entry with the capability-level overrides already applied. */
export interface ResolvedVoiceProvider {
  name: string;
  entry: VoiceProviderEntry;
  model: string;
  voice: string;
  language: string;
  /** Playback generation for TTS chunks (cancellation token). */
  generation?: number;
}

export interface SynthesizedAudio {
  bytes: Buffer;
  mimeType: string;
}

/**
 * One protocol family. Direction methods are absent when the family does not
 * implement that direction (`system-say` has no transcribe, whisper no
 * synthesize); the registry only dispatches after checking capability.
 */
export interface VoiceAdapter {
  transcribe?(provider: ResolvedVoiceProvider, audio: Buffer): Promise<string>;
  synthesize?(provider: ResolvedVoiceProvider, text: string): Promise<SynthesizedAudio>;
}
