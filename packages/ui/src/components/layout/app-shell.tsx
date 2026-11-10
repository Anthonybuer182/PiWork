import { cn } from '@/lib/utils';
import { useOsFileDropGuard } from '@/lib/os-drop';
import { useLanguageSync } from '@/i18n';
import { Toaster } from '@/components/common/toaster';

interface AppShellProps {
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ children, className }: AppShellProps) {
  // One call site keeps `<html lang>` correct for both the desktop and web
  // shells; the dialog itself renders inside this tree.
  useLanguageSync();
  // A file dropped outside a drop zone must not navigate the window to file://.
  useOsFileDropGuard();

  return (
    <div className={cn('flex h-screen flex-col overflow-hidden bg-background', className)}>
      {children}
      <Toaster />
    </div>
  );
}
