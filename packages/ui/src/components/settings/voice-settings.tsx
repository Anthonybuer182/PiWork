import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Eye,
  EyeOff,
  FileAudio,
  Loader2,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from 'lucide-react';
import type {
  BuiltinModelId,
  VoiceBuiltinModel,
  VoiceCapability,
  VoiceCapabilitySettings,
  VoiceModelProgress,
  VoicePreferencesPatch,
  VoiceProviderEntry,
  VoiceProviderType,
  VoiceSettings,
} from '@pi/types';
import {
  BUILTIN_PROVIDER_SENTINEL,
  VOICE_PROVIDER_CAPABILITIES,
} from '@pi/types';
import { useI18n, type MessageKey } from '@/i18n';
import { getHostChrome } from '@/components/layout';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/toast-store';
import {
  VOICE_MODELS_QUERY_KEY,
  VOICE_SETTINGS_QUERY_KEY,
  useBuiltinModelsQuery,
  useVoiceSettingsQuery,
  voiceApi,
} from '@/lib/voice/voice-client';
import { BuiltinVoiceCard } from './builtin-voice-card';
import { floatTo16BitPcmWav16k } from '@/lib/voice/wav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const PROVIDER_LABELS: Record<VoiceProviderType, MessageKey> = {
  'openai-audio': 'OpenAI 兼容（通用）',
  'azure-openai-audio': 'Azure OpenAI',
  elevenlabs: 'ElevenLabs',
  deepgram: 'Deepgram',
  gemini: 'Google Gemini',
  'custom-http': '自定义 HTTP',
  'system-say': '系统语音',
  'local-whisper': '本地 Whisper',
  // Built-in-only protocols; never offered in the add-provider dialog.
  'sherpa-asr': '内置识别',
  'sherpa-tts': '内置朗读（本地）',
};
const PROVIDER_TYPES = Object.keys(PROVIDER_LABELS) as VoiceProviderType[];
const TEST_SENTENCE = '你好，这是一段语音合成测试。';

function typesFor(capability: VoiceCapability): VoiceProviderType[] {
  const platform = getHostChrome().platform;
  return PROVIDER_TYPES.filter((type) => {
    if (type === 'sherpa-asr' || type === 'sherpa-tts') return false;
    if (!VOICE_PROVIDER_CAPABILITIES[type][capability]) return false;
    if (type === 'system-say' && platform !== 'darwin' && platform !== 'win32') {
      return false;
    }
    return true;
  });
}

/** A text field that saves on blur or Enter, not on every keystroke. */
function PrefText({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}) {
  return (
    <div className="min-w-0 flex-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        key={value}
        defaultValue={value}
        placeholder={placeholder}
        className="mt-1 h-8 text-xs"
        onBlur={(event) => {
          if (event.target.value.trim() !== value) onCommit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function maskKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

interface ProviderDialogState {
  open: boolean;
  editMode: boolean;
  capability: VoiceCapability;
  originalName: string;
  name: string;
  data: VoiceProviderEntry;
}

/**
 * 语音 — speech input and output providers.
 *
 * Two independent lists because a vendor may implement only one direction.
 * Everything saves as it changes; the tests at the bottom exercise the same
 * IPC path the composer and message buttons use.
 */
export function VoiceSettingsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useVoiceSettingsQuery();
  const { data: models = [], isLoading: modelsLoading } = useBuiltinModelsQuery();
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ capability: VoiceCapability; name: string } | null>(null);
  const [deleteModelId, setDeleteModelId] = useState<BuiltinModelId | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ProviderDialogState | null>(null);
  const [modelProgress, setModelProgress] = useState<Record<string, VoiceModelProgress>>({});
  const [savingProvider, setSavingProvider] = useState(false);

  const api = voiceApi();

  const applySettings = (next: VoiceSettings) => {
    queryClient.setQueryData(VOICE_SETTINGS_QUERY_KEY, next);
  };

  const refreshModels = () =>
    queryClient.invalidateQueries({ queryKey: VOICE_MODELS_QUERY_KEY });

  // Progress events arrive on the window that started the download.
  useEffect(() => {
    if (!api) return undefined;
    return api.onModelProgress((progress) => {
      setModelProgress((current) => ({ ...current, [progress.modelId]: progress }));
      if (progress.phase === 'done' || progress.phase === 'error' || progress.phase === 'cancelled') {
        void refreshModels();
      }
    });
  }, [api, queryClient]);

  const downloadModel = async (modelId: BuiltinModelId) => {
    if (!api) return;
    setModelProgress((current) => ({
      ...current,
      [modelId]: { modelId, phase: 'downloading', receivedBytes: 0, totalBytes: 0 },
    }));
    try {
      const next = await api.downloadModel(modelId);
      queryClient.setQueryData(VOICE_MODELS_QUERY_KEY, next);
      toast(t('模型已下载，可离线使用'));
    } catch (err) {
      const message = errorMessage(err);
      // Cancelling is a user action, not a failure worth a red toast.
      if (!message.includes('下载已取消')) {
        toast(t('下载失败：{message}', { message }), 'error');
      }
      void refreshModels();
    } finally {
      // The provisional 0% entry must go away on every terminal path (already
      // installed, disk-space error, incomplete download); otherwise the card
      // spins forever with no in-flight download behind it.
      setModelProgress((current) => {
        if (!(modelId in current)) return current;
        const next = { ...current };
        delete next[modelId];
        return next;
      });
    }
  };

  const cancelModelDownload = (modelId: BuiltinModelId) => {
    void api?.cancelModelDownload(modelId);
  };

  const removeModel = async () => {
    if (!api || !deleteModelId) return;
    try {
      const next = await api.deleteModel(deleteModelId);
      queryClient.setQueryData(VOICE_MODELS_QUERY_KEY, next);
    } catch (err) {
      toast(t('删除失败：{message}', { message: errorMessage(err) }), 'error');
    } finally {
      setDeleteModelId(null);
    }
  };

  const savePrefs = async (capability: VoiceCapability, patch: VoicePreferencesPatch) => {
    if (!api) return;
    try {
      applySettings(await api.setPreferences(capability, patch));
    } catch (err) {
      toast(t('保存失败：{message}', { message: errorMessage(err) }), 'error');
    }
  };

  const saveProvider = async () => {
    if (!api || !dialog || savingProvider) return;
    if (!dialog.name.trim()) {
      setProviderError(t('填写服务商名称'));
      return;
    }
    setSavingProvider(true);
    try {
      const next = await api.saveProvider(
        dialog.capability,
        dialog.editMode ? dialog.originalName : null,
        dialog.name.trim(),
        dialog.data,
      );
      applySettings(next);
      setDialog(null);
      setProviderError(null);
    } catch (err) {
      setProviderError(errorMessage(err));
    } finally {
      setSavingProvider(false);
    }
  };

  const deleteProvider = async (capability: VoiceCapability, name: string) => {
    if (!api) return;
    try {
      applySettings(await api.deleteProvider(capability, name));
      setDeleteTarget(null);
    } catch (err) {
      toast(t('删除失败：{message}', { message: errorMessage(err) }), 'error');
    }
  };

  const toggleKey = (name: string) => {
    setVisibleKeys((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('加载中…')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
        {errorMessage(error)}
      </div>
    );
  }

  const sections: { capability: VoiceCapability; title: MessageKey; hint: MessageKey }[] = [
    {
      capability: 'stt',
      title: '语音识别',
      hint: '说话转成文字，填入输入框后发送。',
    },
    {
      capability: 'tts',
      title: '语音合成',
      hint: '把 AI 的回复读出来，按句合成、边播边合成。',
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pb-6">
          {sections.map(({ capability, title, hint }, index) => (
            <div key={capability} className={index > 0 ? 'mt-6 border-t pt-5' : undefined}>
              <VoiceSection
                capability={capability}
                title={t(title)}
                hint={t(hint)}
                settings={data[capability]}
                models={models}
                modelsLoading={modelsLoading}
                modelProgress={modelProgress}
                onDownloadModel={(id) => void downloadModel(id)}
                onCancelModelDownload={cancelModelDownload}
                onDeleteModel={(id) => setDeleteModelId(id)}
                t={t}
                visibleKeys={visibleKeys}
                onToggleKey={toggleKey}
                onSavePrefs={(patch) => void savePrefs(capability, patch)}
                onAdd={() => {
                  setProviderError(null);
                  setDialog({
                    open: true,
                    editMode: false,
                    capability,
                    originalName: '',
                    name: '',
                    data: { type: typesFor(capability)[0] },
                  });
                }}
                onEdit={(name, provider) => {
                  setProviderError(null);
                  setDialog({
                    open: true,
                    editMode: true,
                    capability,
                    originalName: name,
                    name,
                    data: provider,
                  });
                }}
                onDelete={(name) => setDeleteTarget({ capability, name })}
              />
            </div>
          ))}

          <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground/70">
            {t('密钥以明文保存在本机 voice.json，与 models.json 一致。')}
          </p>
        </div>
      </ScrollArea>

      <VoiceProviderDialog
        dialog={dialog}
        error={providerError}
        saving={savingProvider}
        onClose={() => {
          setDialog(null);
          setProviderError(null);
        }}
        onChange={setDialog}
        onSave={() => void saveProvider()}
      />

      <AlertDialog open={!!deleteModelId} onOpenChange={(open) => !open && setDeleteModelId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('删除模型')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('删除后需要重新下载才能使用内置语音，确认删除？')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeModel()}>{t('删除')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('删除语音服务商')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('确认删除语音服务商「{name}」？此操作不可撤销。', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && void deleteProvider(deleteTarget.capability, deleteTarget.name)}
            >
              {t('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VoiceSection({
  capability,
  title,
  hint,
  settings,
  models,
  modelsLoading,
  modelProgress,
  onDownloadModel,
  onCancelModelDownload,
  onDeleteModel,
  t,
  visibleKeys,
  onToggleKey,
  onSavePrefs,
  onAdd,
  onEdit,
  onDelete,
}: {
  capability: VoiceCapability;
  title: string;
  hint: string;
  settings: VoiceCapabilitySettings;
  models: VoiceBuiltinModel[];
  modelsLoading: boolean;
  modelProgress: Record<string, VoiceModelProgress>;
  onDownloadModel: (id: BuiltinModelId) => void;
  onCancelModelDownload: (id: BuiltinModelId) => void;
  onDeleteModel: (id: BuiltinModelId) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  visibleKeys: Set<string>;
  onToggleKey: (name: string) => void;
  onSavePrefs: (patch: VoicePreferencesPatch) => void;
  onAdd: () => void;
  onEdit: (name: string, provider: VoiceProviderEntry) => void;
  onDelete: (name: string) => void;
}) {
  const api = voiceApi();
  const providerNames = Object.keys(settings.providers);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioUrlRef = useRef<string | null>(null);
  const isStt = capability === 'stt';

  const runTranscribeTest = async (file: File) => {
    if (!api) return;
    setTestBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const wav = await decodeFileToWav(file);
      const result = await api.transcribe({ audio: wav, mimeType: 'audio/wav' });
      setTestResult(result.text || t('没有识别到文字'));
    } catch (err) {
      setTestError(errorMessage(err));
    } finally {
      setTestBusy(false);
    }
  };

  const runSpeakTest = async () => {
    if (!api) return;
    setTestBusy(true);
    setTestError(null);
    try {
      const result = await api.synthesize({ text: TEST_SENTENCE });
      const bytes = Uint8Array.from(atob(result.audioBase64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      stopTestAudio();
      const audio = new Audio(url);
      testAudioRef.current = audio;
      testAudioUrlRef.current = url;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        testAudioRef.current = null;
        testAudioUrlRef.current = null;
      };
      await audio.play();
    } catch (err) {
      setTestError(errorMessage(err));
    } finally {
      setTestBusy(false);
    }
  };

  const stopTestAudio = () => {
    const audio = testAudioRef.current;
    if (!audio) return;
    audio.pause();
    testAudioRef.current = null;
    if (testAudioUrlRef.current) {
      URL.revokeObjectURL(testAudioUrlRef.current);
      testAudioUrlRef.current = null;
    }
  };

  // Closing the settings dialog / switching sections must stop the test clip.
  useEffect(
    () => () => {
      testAudioRef.current?.pause();
      if (testAudioUrlRef.current) {
        URL.revokeObjectURL(testAudioUrlRef.current);
        testAudioUrlRef.current = null;
      }
      testAudioRef.current = null;
    },
    [],
  );

  return (
    <section data-testid={`voice-section-${capability}`}>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={onAdd}
          data-testid={`voice-add-${capability}`}
        >
          <Plus className="mr-1 h-3 w-3" />
          {t('添加服务商')}
        </Button>
      </div>

      <div className="rounded-md border px-3 py-1 divide-y">
        <Row label={t(isStt ? '语音识别服务商' : '语音合成服务商')} hint={t('未配置时对应按钮会提示去设置。')}>
          <Select
            value={
              settings.activeProvider ??
              (settings.builtin !== 'off' ? BUILTIN_PROVIDER_SENTINEL : undefined)
            }
            onValueChange={(value: string) => {
              if (value === BUILTIN_PROVIDER_SENTINEL) {
                const fallback: VoiceCapabilitySettings['builtin'] = isStt
                  ? 'whisper'
                  : getHostChrome().platform === 'darwin' || getHostChrome().platform === 'win32'
                    ? 'system-say'
                    : 'local-tts';
                onSavePrefs({
                  activeProvider: null,
                  ...(settings.builtin === 'off' ? { builtin: fallback } : {}),
                });
                return;
              }
              onSavePrefs({ activeProvider: value });
            }}
          >
            <SelectTrigger className="h-8 w-[220px] text-xs" aria-label={t('当前服务商')}>
              <SelectValue placeholder={t('未配置')}>
                {settings.activeProvider ?? t('内置（推荐）')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BUILTIN_PROVIDER_SENTINEL}>{t('内置（推荐）')}</SelectItem>
              {providerNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        {/* Capability-level overrides only apply to a configured provider;
            with the built-in active they would be dead inputs. */}
        {settings.activeProvider && (
          <div className="flex flex-wrap gap-3 py-2.5">
            <PrefText
              label={t('模型（留空使用服务商默认）')}
              value={settings.model}
              placeholder={t('留空使用默认')}
              onCommit={(next) => onSavePrefs({ model: next })}
            />
            {!isStt && (
              <PrefText
                label={t('音色（留空使用默认）')}
                value={settings.voice}
                placeholder={t('留空使用默认')}
                onCommit={(next) => onSavePrefs({ voice: next })}
              />
            )}
            {isStt && (
              <PrefText
                label={t('语言（可选）')}
                value={settings.language}
                placeholder="zh / en"
                onCommit={(next) => onSavePrefs({ language: next })}
              />
            )}
          </div>
        )}

        <Row
          label={t(isStt ? '自动发送' : '自动朗读回复')}
          hint={t(isStt ? '转写完成后直接发送消息' : '仅当窗口在前台时自动朗读')}
        >
          <Switch
            checked={isStt ? settings.autoSend : settings.autoRead}
            onCheckedChange={(checked) =>
              onSavePrefs(isStt ? { autoSend: checked } : { autoRead: checked })
            }
            aria-label={t(isStt ? '自动发送' : '自动朗读回复')}
          />
        </Row>
      </div>

      <BuiltinVoiceCard
        capability={capability}
        settings={settings}
        models={models}
        modelsLoading={modelsLoading}
        progress={modelProgress}
        platform={getHostChrome().platform}
        onPrefs={(patch) => onSavePrefs(patch)}
        onDownload={onDownloadModel}
        onCancel={onCancelModelDownload}
        onDelete={onDeleteModel}
      />

      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {providerNames.length === 0 ? (
          <p className="col-span-full py-3 text-xs text-muted-foreground">
            {t('还没有配置语音服务商')}
          </p>
        ) : (
          providerNames.map((name) => {
            const provider = settings.providers[name];
            const active = settings.activeProvider === name;
            return (
              <ProviderCard
                key={name}
                name={name}
                provider={provider}
                active={active}
                keyVisible={visibleKeys.has(name)}
                onToggleKey={() => onToggleKey(name)}
                onEdit={() => onEdit(name, provider)}
                onDelete={() => onDelete(name)}
                t={t}
              />
            );
          })
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isStt ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void runTranscribeTest(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={testBusy || !settings.activeProvider}
              onClick={() => fileInputRef.current?.click()}
              data-testid="voice-test-transcribe"
            >
              {testBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <FileAudio className="mr-1 h-3 w-3" />}
              {t('测试识别')}
            </Button>
            <span className="text-[11px] text-muted-foreground">{t('选择音频文件')}</span>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={testBusy || !settings.activeProvider}
              onClick={() => void runSpeakTest()}
              data-testid="voice-test-synthesize"
            >
              {testBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
              {t('测试合成')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={stopTestAudio}
            >
              <Square className="mr-1 h-3 w-3" />
              {t('停止播放')}
            </Button>
          </>
        )}
      </div>

      {testResult && (
        <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('识别结果')}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs">{testResult}</p>
        </div>
      )}
      {testError && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{testError}</span>
        </div>
      )}
    </section>
  );
}

function ProviderCard({
  name,
  provider,
  active,
  keyVisible,
  onToggleKey,
  onEdit,
  onDelete,
  t,
}: {
  name: string;
  provider: VoiceProviderEntry;
  active: boolean;
  keyVisible: boolean;
  onToggleKey: () => void;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <Card className={cn('shadow-none', active && 'border-foreground/30')}>
      <CardHeader className="space-y-1 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <CardTitle className="truncate text-sm">{name}</CardTitle>
            {active && <Badge variant="secondary" className="text-[9px]">{t('当前服务商')}</Badge>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} aria-label={t('编辑')}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label={t('删除')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="min-w-0 space-y-0.5 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {t(PROVIDER_LABELS[provider.type])}
            </Badge>
          </div>
          {provider.baseUrl && (
            <div className="break-all" title={provider.baseUrl}>
              {provider.baseUrl}
            </div>
          )}
          {provider.apiKey && (
            <div className="flex items-center gap-1">
              <span className="shrink-0">{t('API Key')}:</span>
              <code className="break-all rounded bg-muted px-1 text-[10px]">
                {keyVisible ? provider.apiKey : maskKey(provider.apiKey)}
              </code>
              <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={onToggleKey}>
                {keyVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </Button>
            </div>
          )}
          {provider.model && (
            <div className="truncate" title={provider.model}>
              {t('模型')}: {provider.model}
            </div>
          )}
          {provider.voice && (
            <div className="truncate" title={provider.voice}>
              {t('音色')}: {provider.voice}
            </div>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function VoiceProviderDialog({
  dialog,
  error,
  saving,
  onClose,
  onChange,
  onSave,
}: {
  dialog: ProviderDialogState | null;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onChange: (next: ProviderDialogState | null) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  if (!dialog) return null;

  const { capability, data } = dialog;
  const isStt = capability === 'stt';
  const isSystem = data.type === 'system-say';
  const isWhisper = data.type === 'local-whisper';
  const isCustom = data.type === 'custom-http';
  const isAzure = data.type === 'azure-openai-audio';

  const setData = (patch: Partial<VoiceProviderEntry>) =>
    onChange({ ...dialog, data: { ...data, ...patch } });
  const setOption = (key: string, value: string) =>
    setData({ options: { ...(data.options ?? {}), [key]: value } });
  const option = (key: string) => data.options?.[key] ?? '';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialog.editMode ? t('编辑语音服务商') : t('添加服务商')}</DialogTitle>
          <DialogDescription>
            {t(isStt ? '用于把语音转写成文字。' : '用于把文字朗读成语音。')}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
          </div>
        )}

        <div className="space-y-3 py-1">
          <div>
            <Label htmlFor="voiceProviderName">{t('名称')} *</Label>
            <Input
              id="voiceProviderName"
              placeholder={isStt ? 'whisper / 我的识别服务' : '系统语音 / my-tts'}
              value={dialog.name}
              onChange={(event) => onChange({ ...dialog, name: event.target.value })}
            />
          </div>

          <div>
            <Label htmlFor="voiceProviderType">{t('协议类型')}</Label>
            <Select
              value={data.type}
              onValueChange={(value: string) =>
                setData({
                  type: value as VoiceProviderType,
                  // Type-specific fields from the previous protocol would
                  // otherwise be sent to the new vendor.
                  baseUrl: undefined,
                  apiKey: undefined,
                  model: undefined,
                  voice: undefined,
                  language: undefined,
                  options: undefined,
                })
              }
            >
              <SelectTrigger id="voiceProviderType">
                <SelectValue>{t(PROVIDER_LABELS[data.type])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {typesFor(capability).map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(PROVIDER_LABELS[type])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isSystem && !isWhisper && (
            <>
              <div>
                <Label htmlFor="voiceBaseUrl">
                  {isCustom ? t('请求 URL') : 'Base URL'}
                </Label>
                <Input
                  id="voiceBaseUrl"
                  placeholder={
                    data.type === 'openai-audio'
                      ? 'https://api.openai.com/v1'
                      : isCustom
                        ? 'https://vendor.example/asr'
                        : t('留空使用服务商默认值')
                  }
                  value={data.baseUrl ?? ''}
                  onChange={(event) => setData({ baseUrl: event.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="voiceApiKey">{t('API Key')}</Label>
                <Input
                  id="voiceApiKey"
                  type="password"
                  placeholder={t('可选')}
                  value={data.apiKey ?? ''}
                  onChange={(event) => setData({ apiKey: event.target.value })}
                />
              </div>
            </>
          )}

          {isWhisper ? (
            <>
              <div>
                <Label htmlFor="voiceBinaryPath">{t('可执行文件路径')}</Label>
                <Input
                  id="voiceBinaryPath"
                  placeholder="whisper-cli"
                  value={option('binaryPath')}
                  onChange={(event) => setOption('binaryPath', event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="voiceModelPath">{t('模型文件路径')}</Label>
                <Input
                  id="voiceModelPath"
                  placeholder="/path/to/ggml-base.bin"
                  value={option('modelPath')}
                  onChange={(event) => setOption('modelPath', event.target.value)}
                />
              </div>
            </>
          ) : isCustom ? (
            <CustomHttpFields
              isStt={isStt}
              option={option}
              setOption={setOption}
              value={data}
              setData={setData}
              t={t}
            />
          ) : (
            <>
              {!isSystem && (
                <div>
                  <Label htmlFor="voiceModel">{t(isAzure ? '部署名' : '模型')}</Label>
                  <Input
                    id="voiceModel"
                    placeholder={modelPlaceholder(data.type)}
                    value={data.model ?? ''}
                    onChange={(event) => setData({ model: event.target.value })}
                  />
                </div>
              )}
              {!isStt && (
                <div>
                  <Label htmlFor="voiceVoice">
                    {t(
                      data.type === 'elevenlabs'
                        ? 'Voice ID'
                        : data.type === 'gemini'
                          ? '预置音色'
                          : data.type === 'system-say'
                            ? '系统音色'
                            : '音色（留空使用默认）',
                    )}
                  </Label>
                  <Input
                    id="voiceVoice"
                    placeholder={
                      data.type === 'system-say'
                        ? 'Tingting / Alex'
                        : data.type === 'gemini'
                          ? 'Kore'
                          : t('留空使用默认')
                    }
                    value={data.voice ?? ''}
                    onChange={(event) => setData({ voice: event.target.value })}
                  />
                </div>
              )}
              {isStt && (
                <div>
                  <Label htmlFor="voiceLanguage">{t('语言（可选）')}</Label>
                  <Input
                    id="voiceLanguage"
                    placeholder="zh / en"
                    value={data.language ?? ''}
                    onChange={(event) => setData({ language: event.target.value })}
                  />
                </div>
              )}
              {isAzure && (
                <div>
                  <Label htmlFor="voiceApiVersion">{t('API 版本')}</Label>
                  <Input
                    id="voiceApiVersion"
                    placeholder="2024-06-01"
                    value={option('apiVersion')}
                    onChange={(event) => setOption('apiVersion', event.target.value)}
                  />
                </div>
              )}
              {data.type === 'openai-audio' && (
                <div>
                  <Label htmlFor="voicePathOverride">
                    {t(isStt ? '识别路径覆盖（可选）' : '合成路径覆盖（可选）')}
                  </Label>
                  <Input
                    id="voicePathOverride"
                    placeholder={isStt ? '/audio/transcriptions' : '/audio/speech'}
                    value={option(isStt ? 'sttPath' : 'ttsPath')}
                    onChange={(event) => setOption(isStt ? 'sttPath' : 'ttsPath', event.target.value)}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {t('保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomHttpFields({
  isStt,
  option,
  setOption,
  value,
  setData,
  t,
}: {
  isStt: boolean;
  option: (key: string) => string;
  setOption: (key: string, value: string) => void;
  value: VoiceProviderEntry;
  setData: (patch: Partial<VoiceProviderEntry>) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="voiceMethod">{t('请求方法')}</Label>
          <Input
            id="voiceMethod"
            placeholder="POST"
            value={option('method')}
            onChange={(event) => setOption('method', event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="voiceContentType">Content-Type</Label>
          <Input
            id="voiceContentType"
            placeholder="application/json"
            value={option('contentType')}
            onChange={(event) => setOption('contentType', event.target.value)}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="voiceHeaders">{t('请求头（JSON）')}</Label>
        <textarea
          id="voiceHeaders"
          className="mt-1 min-h-[56px] w-full rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          placeholder='{"X-Api-Key": "..."}'
          defaultValue={option('headers')}
          onBlur={(event) => setOption('headers', event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="voiceBodyTemplate">{t('请求体模板')}</Label>
        <textarea
          id="voiceBodyTemplate"
          className="mt-1 min-h-[86px] w-full rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={
            isStt
              ? '{"audio":"{{audio_base64}}","mimeType":"{{mime}}","language":"{{language}}","model":"{{model}}"}'
              : '{"text":"{{text}}","voice":"{{voice}}","model":"{{model}}","language":"{{language}}"}'
          }
          defaultValue={option('bodyTemplate')}
          onBlur={(event) => setOption('bodyTemplate', event.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="voiceResponsePath">{t('响应字段路径')}</Label>
          <Input
            id="voiceResponsePath"
            placeholder={isStt ? 'text' : 'audio'}
            value={option('responsePath')}
            onChange={(event) => setOption('responsePath', event.target.value)}
          />
        </div>
        {!isStt && (
          <div>
            <Label htmlFor="voiceResponseType">{t('响应类型')}</Label>
            <Select
              value={option('responseType') || 'binary'}
              onValueChange={(next: string) => setOption('responseType', next)}
            >
              <SelectTrigger id="voiceResponseType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="binary">{t('二进制音频')}</SelectItem>
                <SelectItem value="json-base64">{t('JSON 中的 base64')}</SelectItem>
                <SelectItem value="json-hex">{t('JSON 中的 hex')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {!isStt && (
        <div>
          <Label htmlFor="voiceMime">{t('MIME 类型')}</Label>
          <Input
            id="voiceMime"
            placeholder="audio/mpeg"
            value={option('mimeType')}
            onChange={(event) => setOption('mimeType', event.target.value)}
          />
        </div>
      )}
      {isStt && (
        <div>
          <Label htmlFor="voiceSttLanguage">{t('语言（可选）')}</Label>
          <Input
            id="voiceSttLanguage"
            placeholder="zh / en"
            value={value.language ?? ''}
            onChange={(event) => setData({ language: event.target.value })}
          />
        </div>
      )}
    </>
  );
}

function modelPlaceholder(type: VoiceProviderType): string {
  switch (type) {
    case 'openai-audio':
      return 'whisper-1 / tts-1 / gpt-4o-mini-tts';
    case 'elevenlabs':
      return 'scribe_v1 / eleven_multilingual_v2';
    case 'deepgram':
      return 'nova-3 / aura-2-thalia-en';
    case 'gemini':
      return 'gemini-2.5-flash / gemini-2.5-flash-preview-tts';
    default:
      return '';
  }
}

async function decodeFileToWav(file: File): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));
    if (decoded.numberOfChannels === 0) throw new Error('音频为空');
    return floatTo16BitPcmWav16k(decoded.getChannelData(0), decoded.sampleRate);
  } finally {
    void context.close();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
