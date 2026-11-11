import { useQuery } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/i18n';

interface ModelSelectorProps {
  value?: string;
  onChange?: (modelId: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const { t } = useI18n();
  const sdk = useSDK();

  const { data: models, isLoading } = useQuery({
    queryKey: ['models'],
    queryFn: () => sdk.config.listModels(),
  });

  if (isLoading) return <Skeleton className="h-7 w-[120px] shrink-0" />;

  // A squeezed composer truncates the name to a stub; the title keeps the
  // full one a hover away.
  const currentName = models?.find((model) => model.id === value)?.name ?? value;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        // The name is the only thing that gives way, and only down to a
        // readable stub: it must never collapse to the bare icon and leave
        // the neighbouring controls to overflow the row.
        className="h-7 w-auto min-w-[72px] max-w-[150px] shrink gap-1 border-0 bg-transparent px-2 text-xs hover:bg-accent @[560px]:max-w-[220px] [&>span]:truncate"
        aria-label={t('选择模型')}
        title={currentName || undefined}
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <SelectValue placeholder={t('选择模型')} />
      </SelectTrigger>
      <SelectContent>
        {models?.map((model) => (
          <SelectItem key={model.id} value={model.id} disabled={!model.isAvailable}>
            <div className="flex items-center gap-2">
              <span>{model.name}</span>
              {!model.isAvailable && (
                <span className="text-[10px] text-muted-foreground">{t('不可用')}</span>
              )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
