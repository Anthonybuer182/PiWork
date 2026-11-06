export { Button, buttonVariants, type ButtonProps } from './components/ui/button';
export { Input } from './components/ui/input';
export { Textarea } from './components/ui/textarea';
export { Badge, badgeVariants, type BadgeProps } from './components/ui/badge';
export { Skeleton } from './components/ui/skeleton';
export { Separator } from './components/ui/separator';
export { Label } from './components/ui/label';
export { Switch } from './components/ui/switch';
export { ScrollArea, ScrollBar } from './components/ui/scroll-area';
export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent } from './components/ui/card';
export { Avatar, AvatarImage, AvatarFallback } from './components/ui/avatar';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
export { Toggle, toggleVariants } from './components/ui/toggle';
export { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';
export { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from './components/ui/dialog';
export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuGroup, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuRadioGroup } from './components/ui/dropdown-menu';
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './components/ui/tooltip';
export { Popover, PopoverTrigger, PopoverContent } from './components/ui/popover';
export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator } from './components/ui/command';
export { Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription } from './components/ui/sheet';
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from './components/ui/collapsible';
export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton } from './components/ui/select';
export { Slot } from './components/ui/slot';

export { cn, isTextEditableFile, isPreviewableInRightPanel, openWithSystemApp } from './lib/utils';
export { openDroppedPaths } from './lib/open-dropped';

// Multi-window helpers (no-ops in the web build).
export {
  applyInitialWindowContext,
  fetchWindowContext,
  getDesktopWindowId,
  hasDesktopWindowApi,
  readInitialWindowContext,
  syncWindowContext,
} from './lib/window-context';
export { useToastStore, toast } from './stores/toast-store';
export { Toaster } from './components/common/toaster';
export {
  activateSession,
  openNewWindow,
  openSessionInNewWindow,
  openWorkspaceInNewWindow,
} from './lib/window-actions';

export { useI18n, useLanguageSync, useLanguageStore, translate, t } from './i18n';
export type { Language, MessageKey } from './i18n';

export { useUIStore } from './stores/ui-store';
export { useThemeStore } from './stores/theme-store';
export { useComposerStore } from './stores/composer-store';
export { usePermissionStore, initPermissionBridge } from './stores/permission-store';
export type { PermissionMode, PermissionDecision, PermissionRequest } from './stores/permission-store';
export { useAskStore, initAskBridge } from './stores/ask-store';
export { useTodoStore, initTodoBridge } from './stores/todo-store';
export { useToolStore, initToolBridge } from './stores/tool-store';
export {
  initPluginVoiceBridge,
  speakExternal,
  toggleExternal,
  stopSpeaking,
} from './stores/voice-playback-store';
export { usePluginStore, getPluginBridge } from './stores/plugin-store';
export { usePanelStore, pluginPanelId, usePanelActivation, panelIdOfTab, instanceIdOfTab, tabKeyOf } from './stores/panel-store';
export type { PanelEntry, PanelKeepAlive, PanelRuntimeState, PanelRegion, PanelAnchor } from './stores/panel-store';
export { HOST_LEFT_PANELS } from './components/panels/host-panels';
export { useCommandStore, HOST_COMMANDS } from './stores/command-store';
export type { RegisteredCommand } from './stores/command-store';

export { useSDK, SDKProvider } from './hooks/use-sdk';
export { useTheme } from './hooks/use-theme';
export { useMediaQuery } from './hooks/use-media-query';
export { useKeyboardShortcut } from './hooks/use-keyboard-shortcut';
export { useResizeObserver } from './hooks/use-resize-observer';

export { AppShell, ThreeColumnLayout, LeftSidebar, CenterPanel, RightPanel, LayoutToggles, getHostChrome } from './components/layout';
export type { HostChrome, HostPlatform } from './components/layout';
export { WorkspaceDropdown, WorkspaceCreateButton } from './components/workspace';
export { SessionList, SessionItem, SessionCreateButton, SessionHeader } from './components/session';
export { ChatTimeline, MessageBubble, ThinkingBlock, ToolCallDisplay, EmptyChat, StreamingIndicator } from './components/chat';
export { Composer, ComposerInput, SendButton, SlashCommandMenu, MentionMenu, AttachmentPreviewBar, FileUploadButton } from './components/composer';
export { ModelSelector, ThinkLevelSelector } from './components/model';
export { SettingsDialog, SettingsRailButton } from './components/settings';
export { UsageBar } from './components/usage';
export { ErrorBoundary, LoadingSpinner, EmptyState, ErrorState, ConfirmDialog } from './components/common';
export { FileTree, FileTreeNode } from './components/file';

export { PluginCenter } from './components/plugins/plugin-center';
export { DeclarativeRenderer } from './components/plugins/declarative/declarative-renderer';
export type { UiEventContext } from './components/plugins/declarative/declarative-renderer';
export { PanelHost, PanelRail } from './components/panels/panel-host';
export { PanelBody, PaneView } from './components/panels/panel-slot';
export { PanelTabs } from './components/panels/panel-tabs';
export { panelIcon } from './components/panels/panel-icons';
export { showPopupMenu } from './lib/native-menu';
export type { PopupMenuItem } from './lib/native-menu';
