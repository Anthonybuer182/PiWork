/**
 * Typed access to the desktop voice bridge (`window.electronAPI.voice`).
 *
 * The web build has no such namespace; every caller checks `hasVoiceApi()`
 * and hides its control, so a browser tab simply has no voice UI instead of a
 * button that throws.
 */

import { useQuery } from '@tanstack/react-query';
import type {
  BuiltinModelId,
  VoiceBuiltinModel,
  VoiceCapability,
  VoiceModelProgress,
  VoicePreferencesPatch,
  VoiceProviderEntry,
  VoiceSettings,
  VoiceSynthesizeRequest,
  VoiceSynthesizeResult,
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
} from '@pi/types';
import { electronApi } from '@/lib/electron-ipc';

export interface VoiceBridge {
  get: () => Promise<VoiceSettings>;
  saveProvider: (
    capability: VoiceCapability,
    originalName: string | null,
    name: string,
    provider: VoiceProviderEntry,
  ) => Promise<VoiceSettings>;
  deleteProvider: (capability: VoiceCapability, name: string) => Promise<VoiceSettings>;
  setPreferences: (
    capability: VoiceCapability,
    patch: VoicePreferencesPatch,
  ) => Promise<VoiceSettings>;
  transcribe: (request: VoiceTranscribeRequest) => Promise<VoiceTranscribeResult>;
  synthesize: (request: VoiceSynthesizeRequest) => Promise<VoiceSynthesizeResult>;
  cancelSynthesis: (generation?: number) => Promise<void>;
  notifyPlayback: (key: string, playing: boolean) => Promise<void>;
  getModels: () => Promise<VoiceBuiltinModel[]>;
  downloadModel: (modelId: BuiltinModelId) => Promise<VoiceBuiltinModel[]>;
  cancelModelDownload: (modelId: BuiltinModelId) => Promise<void>;
  deleteModel: (modelId: BuiltinModelId) => Promise<VoiceBuiltinModel[]>;
  onModelProgress: (callback: (progress: VoiceModelProgress) => void) => () => void;
}

export function voiceApi(): VoiceBridge | undefined {
  const bridge = electronApi() as (Record<string, unknown> & { voice?: VoiceBridge }) | undefined;
  return bridge?.voice;
}

export function hasVoiceApi(): boolean {
  return !!voiceApi();
}

export const VOICE_SETTINGS_QUERY_KEY = ['voiceConfig'] as const;

export function useVoiceSettingsQuery() {
  return useQuery<VoiceSettings>({
    queryKey: VOICE_SETTINGS_QUERY_KEY,
    queryFn: () => voiceApi()!.get(),
    enabled: hasVoiceApi(),
    staleTime: 30_000,
  });
}

export const VOICE_MODELS_QUERY_KEY = ['voiceBuiltinModels'] as const;

export function useBuiltinModelsQuery() {
  return useQuery<VoiceBuiltinModel[]>({
    queryKey: VOICE_MODELS_QUERY_KEY,
    queryFn: () => voiceApi()!.getModels(),
    enabled: hasVoiceApi(),
    staleTime: 30_000,
  });
}
