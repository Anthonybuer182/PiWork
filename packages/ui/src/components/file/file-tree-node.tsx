import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, CircleAlert, File, FileCode, FileText, FileImage, FileVideo, Folder, FolderOpen, Loader2, Trash2 } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { FileEntry } from '@pi/sdk-wrapper';

interface FileTreeNodeProps {
  entry: FileEntry;
  workspaceId: string;
  depth: number;
  onFileClick: (path: string) => void;
  onRequestDelete: (entry: FileEntry) => void;
}

function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return null; // handled separately with expand state
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'css': case 'html': case 'vue':
    case 'svelte': case 'py': case 'rs': case 'go': case 'java': case 'c': case 'cpp':
      return <FileCode className="h-3.5 w-3.5 shrink-0 text-blue-400" />;
    case 'json': case 'yaml': case 'yml': case 'toml': case 'xml':
      return <FileCode className="h-3.5 w-3.5 shrink-0 text-yellow-400" />;
    case 'md': case 'txt': case 'log':
      return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': case 'ico': case 'bmp': case 'avif':
      return <FileImage className="h-3.5 w-3.5 shrink-0 text-green-400" />;
    case 'mp4': case 'webm': case 'mov': case 'm4v': case 'ogv': case 'mkv': case 'avi': case '3gp':
      return <FileVideo className="h-3.5 w-3.5 shrink-0 text-purple-400" />;
    default:
      return <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

export function FileTreeNode({ entry, workspaceId, depth, onFileClick, onRequestDelete }: FileTreeNodeProps) {
  const sdk = useSDK();
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const [expanded, setExpanded] = useState(false);

  const { data: children, isLoading, error } = useQuery({
    queryKey: ['files', workspaceId, entry.path],
    queryFn: () => sdk.file.list(workspaceId, entry.path),
    enabled: expanded && entry.type === 'directory',
    staleTime: 30_000,
  });

  const isDirectory = entry.type === 'directory';

  // Whether the current file is selected
  const isSelected = entry.type === 'file' && activePreviewFilePath === entry.path;

  // Whether the current directory is an ancestor of the selected file
  const shouldAutoExpand = entry.type === 'directory'
    && !!activePreviewFilePath
    && (activePreviewFilePath.startsWith(entry.path + '/') || activePreviewFilePath.startsWith(entry.path + '\\'));

  // Auto-expand ancestor directory
  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true);
  }, [shouldAutoExpand]);

  // Scroll file into view after selection
  useEffect(() => {
    if (isSelected && ref.current) {
      const timer = setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isSelected]);

  const handleClick = () => {
    if (isDirectory) {
      setExpanded((prev) => !prev);
    } else {
      onFileClick(entry.path);
    }
  };

  return (
    <div>
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          // Ignore keys that bubbled from the trash button — it handles its own.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') {
            handleClick();
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            e.stopPropagation();
            onRequestDelete(entry);
          }
        }}
        aria-expanded={isDirectory ? expanded : undefined}
        aria-selected={isSelected || undefined}
        aria-label={isDirectory ? `Toggle directory: ${entry.name}` : `Preview file: ${entry.name}`}
        className={cn(
          'group flex items-center gap-1 rounded-sm px-2 py-1 text-sm cursor-pointer transition-colors hover:bg-accent/50',
          isSelected && 'bg-accent',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        title={entry.name}
      >
        {isDirectory ? (
          <>
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90',
              )}
            />
            {expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {getFileIcon(entry.name, false)}
          </>
        )}
        <span className="flex-1 truncate text-xs">{entry.name}</span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t('删除 {name}', { name: entry.name })}
          title={t('删除 {name}', { name: entry.name })}
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(entry);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {isDirectory && expanded && (
        <div>
          {isLoading && (
            <div
              className="flex items-center gap-1 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </div>
          )}
          {error && (
            <div
              className="flex items-center gap-1 py-1 text-xs text-destructive/80"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
              title={error instanceof Error ? error.message : undefined}
            >
              <CircleAlert className="h-3 w-3 shrink-0" />
              Failed to read
            </div>
          )}
          {children
            ?.filter((child) => child.type === 'directory' || child.type === 'file')
            .sort((a, b) => {
              // Directories first, then files, then alphabetical
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <FileTreeNode
                key={child.path}
                entry={child}
                workspaceId={workspaceId}
                depth={depth + 1}
                onFileClick={onFileClick}
                onRequestDelete={onRequestDelete}
              />
            ))}
        </div>
      )}
    </div>
  );
}
