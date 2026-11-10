import { Loader2, Trash2 } from 'lucide-react';
import type {
  BuiltinModelId,
  VoiceBuiltinModel,
  VoiceCapability,
  VoiceCapabilitySettings,
  VoiceModelProgress,
  VoicePreferencesPatch,
} from '@pi/types';
import { useI18n, type MessageKey } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MODEL_LABELS: Record<BuiltinModelId, MessageKey> = {
  sensevoice: 'SenseVoice（推荐）',
  'whisper-base': 'Whisper Base（多语言）',
  'whisper-small': 'Whisper Small（多语言）',
  'melo-int8': 'MeloTTS（中英双语）',
  kokoro: 'Kokoro（高质量）',
};

const DEFAULT_ASR_MODEL: BuiltinModelId = 'sensevoice';
const DEFAULT_TTS_MODEL: BuiltinModelId = 'melo-int8';

/**
 * The built-in engine card: local ASR (downloadable) or system/local TTS.
 *
 * It is presented next to the user's providers but is not one of them — the
 * settings object only carries `builtin` / `builtinModel`, never an entry in
 * `providers`.
 */
export function BuiltinVoiceCard({
  capability,
  settings,
  models,
  modelsLoading,
  progress,
  platform,
  onPrefs,
  onDownload,
  onCancel,
  onDelete,
}: {
  capability: VoiceCapability;
  settings: VoiceCapabilitySettings;
  models: VoiceBuiltinModel[];
  modelsLoading: boolean;
  progress: Record<string, VoiceModelProgress | undefined>;
  platform: string;
  onPrefs: (patch: VoicePreferencesPatch) => void;
  onDownload: (id: BuiltinModelId) => void;
  onCancel: (id: BuiltinModelId) => void;
  onDelete: (id: BuiltinModelId) => void;
}) {
  const { t } = useI18n();
  const isStt = capability === 'stt';
  const enabled = settings.builtin !== 'off';
  const active = !settings.activeProvider && enabled;
  const systemTtsSupported = platform === 'darwin' || platform === 'win32';

  const usesModel = isStt || settings.builtin === 'local-tts';
  const modelId: BuiltinModelId | '' = isStt
    ? (settings.builtinModel || DEFAULT_ASR_MODEL)
    : settings.builtin === 'local-tts'
      ? (settings.builtinModel || DEFAULT_TTS_MODEL)
      : '';
  const kindModels = models.filter((model) => model.kind === (isStt ? 'asr' : 'tts'));
  const model = kindModels.find((entry) => entry.id === modelId);
  const download = modelId ? progress[modelId] : undefined;
  const downloading = download?.phase === 'downloading' || model?.downloading === true;
  const percent =
    download && download.totalBytes > 0
      ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))
      : 0;

  const defaultEngine = () => {
    if (isStt) return 'whisper';
    return systemTtsSupported ? 'system-say' : 'local-tts';
  };

  return (
    <Card data-testid={`voice-builtin-${capability}`} className="mb-3 shadow-none">
      <CardHeader className="space-y-2 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <CardTitle className="truncate text-sm">
              {t(isStt ? '本地离线识别' : '内置朗读')}
            </CardTitle>
            <Badge variant="secondary" className="shrink-0 text-[9px]">
              {t('内置（推荐）')}
            </Badge>
            {active && (
              <Badge variant="outline" className="shrink-0 text-[9px]">
                {t('当前使用')}
              </Badge>
            )}
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              onPrefs({ builtin: checked ? defaultEngine() : 'off' })
            }
            aria-label={t('启用内置语音')}
          />
        </div>

        {enabled && !isStt && (
          <div className="flex items-center gap-2">
            <Label className="shrink-0 text-xs text-muted-foreground">{t('引擎')}</Label>
            <Select
              value={settings.builtin}
              onValueChange={(value: string) =>
                onPrefs({ builtin: value as VoiceCapabilitySettings['builtin'] })
              }
            >
              <SelectTrigger className="h-7 w-[220px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system-say" disabled={!systemTtsSupported}>
                  {t('系统语音')}
                </SelectItem>
                <SelectItem value="local-tts">{t('本地神经语音')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {enabled && usesModel && (
          <div className="flex flex-wrap items-center gap-2">
            <Label className="shrink-0 text-xs text-muted-foreground">{t('模型')}</Label>
            <Select
              value={modelId || ''}
              disabled={modelsLoading}
              onValueChange={(value: string) =>
                onPrefs({ builtinModel: value as BuiltinModelId })
              }
            >
              <SelectTrigger className="h-7 w-[260px] text-xs">
                <SelectValue>
                  {model ? t(MODEL_LABELS[model.id]) : t('加载中…')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {kindModels.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    <span className="flex items-center gap-2">
                      <span>{t(MODEL_LABELS[entry.id])}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatBytes(entry.sizeBytes)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {model?.installed ? <Badge variant="outline" className="text-[9px]">{t('已安装')}</Badge> : null}
          </div>
        )}

        {enabled && usesModel && (
          <div className="rounded-md border bg-muted/20 px-2.5 py-2">
            {modelsLoading ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('加载中…')}
              </span>
            ) : downloading ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('模型下载中 {percent}%', { percent })}
                  </span>
                  <span>
                    {formatBytes(download?.receivedBytes ?? 0)} / {formatBytes(model?.sizeBytes ?? 0)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-foreground/60 transition-[width]" style={{ width: `${percent}%` }} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => modelId && onCancel(modelId)}
                >
                  {t('取消下载')}
                </Button>
              </div>
            ) : model?.installed ? (
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>{t('模型已就绪，可离线使用')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px] text-destructive hover:text-destructive"
                  onClick={() => modelId && onDelete(modelId)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  {t('删除模型')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-[11px] text-muted-foreground">
                  {download?.phase === 'error' ? (
                    <span className="text-destructive">
                      {t('下载失败：{message}', { message: download.message ?? '' })}
                    </span>
                  ) : (
                    <span>{t('未安装，首次使用前需下载')}</span>
                  )}
                </div>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!model}
                  onClick={() => modelId && onDownload(modelId)}
                >
                  {model
                    ? t('下载（{size}）', { size: formatBytes(model.sizeBytes) })
                    : t('下载')}
                </Button>
              </div>
            )}
          </div>
        )}

        {enabled && !isStt && settings.builtin === 'local-tts' && (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="voice-sid" className="shrink-0 text-xs text-muted-foreground">
              {t('音色编号')}
            </Label>
            <Input
              id="voice-sid"
              key={settings.voice}
              defaultValue={settings.voice}
              placeholder={t('留空使用默认音色')}
              className="h-7 w-[180px] text-xs"
              onBlur={(event) => {
                if (event.target.value.trim() !== settings.voice) {
                  onPrefs({ voice: event.target.value.trim() });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <span className="text-[10px] text-muted-foreground">
              {t('Kokoro 中文音色建议 48–52，英文可试 0；MeloTTS 仅 0')}
            </span>
          </div>
        )}

        <p className="text-[10px] leading-relaxed text-muted-foreground/70">
          {t(
            isStt
              ? '模型下载后完全在本机识别，录音不会离开设备。'
              : '系统语音由操作系统合成；本地神经语音完全离线。',
          )}
        </p>
      </CardHeader>
    </Card>
  );
}
