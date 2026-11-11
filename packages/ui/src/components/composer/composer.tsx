import { useCallback, useMemo, useState, useRef, useEffect, DragEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Square, Upload, CornerDownRight, Sparkles, X } from 'lucide-react';
import { cn, isPreviewableInRightPanel } from '@/lib/utils';
import { streamReducer, initialStreamingState } from '@/lib/stream-reducer';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { activateSession } from '@/lib/window-actions';
import { useComposerStore } from '@/stores/composer-store';
import { ComposerInput } from './composer-input';
import { SendButton } from './send-button';
import { FileUploadButton } from './file-upload-button';
import { SlashCommandMenu } from './slash-command-menu';
import { MentionMenu } from './mention-menu';
import { SlashCommandDialog, type SlashCommandDialogData } from './slash-command-dialog';
import type { MentionItem } from './mention-menu';
import { AttachmentPreviewBar } from './attachment-preview-bar';
import { QueueIndicator } from './queue-indicator';
import { ModelSelector } from '../model/model-selector';
import { ThinkLevelSelector } from '../model/think-level-selector';
import { PermissionModeButton } from './permission-mode-button';
import { VoiceInputButton } from './voice-input-button';
import { useBuiltinModelsQuery, useVoiceSettingsQuery } from '@/lib/voice/voice-client';
import { useI18n, type MessageKey } from '@/i18n';
import { useCommandStore, commandDescription, type RegisteredCommand } from '@/stores/command-store';
import { toast } from '@/stores/toast-store';
import { usePluginStore } from '@/stores/plugin-store';
import { canSaveAttachment, pathForFile, saveAttachmentToWorkspace } from '@/lib/os-drop';
import type { Attachment, ContentBlock, Config, PluginMessageData, SavedAttachment, Skill } from '@pi/types';
import { SKILL_REFERENCE_MARKER } from '@pi/types';

interface SendVariables {
  content: string;
  sessionId: string;
  attachments: Attachment[];
  /** Per-message skill references (the composer chips), captured at send time. */
  skills: Skill[];
  /**
   * Deliver the turn as a plugin request card (`chat.send`): no optimistic
   * user bubble, and the SDK stores a plugin message entry instead of a user
   * message. The agent still sees `content`.
   */
  pluginMessage?: PluginMessageData;
  /**
   * Send this turn as a sibling of an earlier one instead of after the current
   * leaf (editing a question, or replaying the turn at `entryId`). The branch
   * point and the replayed prompt are resolved in main.
   */
  branchFrom?: string;
  replayTurn?: { entryId: string };
}

export function Composer() {
  const { t } = useI18n();
  // Voice preferences live in main; the query is disabled in the web build.
  const { data: voiceSettings } = useVoiceSettingsQuery();
  const { data: voiceModels = [], isLoading: voiceModelsLoading } = useBuiltinModelsQuery();
  const sdk = useSDK();
  const queryClient = useQueryClient();
  // Command registry: host commands + plugin-contributed commands.
  const registeredCommands = useCommandStore((s) => s.commands);
  const executePluginCommand = usePluginStore((s) => s.executePluginCommand);
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const compactMode = useUIStore((s) => s.compactMode);
  const setCompactMode = useUIStore((s) => s.setCompactMode);
  const disabledSkills = useUIStore((s) => s.disabledSkills);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);
  const setActiveSession = useUIStore((s) => s.setActiveSession);

  // Always keep a conversation ready. A workspace with no selected session is
  // exactly the state you land in when the app opens or you switch workspaces —
  // it should not be a dead end with no input box.
  //
  // Creating a session is free: no file is written and it stays out of the
  // session list until the first message, so this produces no clutter even if
  // you switch workspaces without typing.
  useEffect(() => {
    // A window that opens on a workspace but no session (Cmd+N) reaches this
    // effect before the transport connects; creating there fails with
    // "IPC transport not connected" and is silently swallowed. Wait for the
    // connection — the status flip re-runs the effect.
    if (activeSessionId || !activeWorkspaceId || connectionStatus !== 'connected') return;
    let cancelled = false;
    (async () => {
      try {
        const created = await sdk.session.create(activeWorkspaceId);
        // Read it back and seed the cache: without data for the new id the
        // session query has nothing to render and ChatTimeline flashes its
        // "Loading messages..." spinner. A fresh session has no messages, so
        // this is cheap.
        const session = await sdk.session.get(created.id);
        if (cancelled) return;
        queryClient.setQueryData(['session', created.id], session);
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void activateSession(created.id);
      } catch {
        // Leave the empty state in place; the next workspace change retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeWorkspaceId, connectionStatus, sdk, queryClient, setActiveSession]);

  const {
    value,
    setValue,
    isStreaming,
    isDragging,
    setIsDragging,
    showSlashMenu,
    slashQuery,
    setShowSlashMenu,
    showMentionMenu,
    mentionQuery,
    setShowMentionMenu,
    pendingAttachments,
    addAttachment,
    updateAttachmentData,
    removeAttachment,
    clearAttachments,
    triggerSend,
    clearEditingMessage,
    triggerScrollToBottom,
  } = useComposerStore();

  // Whether the conversation on screen has a send in flight. Per-session:
  // another conversation's run must not block this one's Send button.
  const activePending = useComposerStore((s) =>
    activeSessionId ? Boolean(s.sessionPending[activeSessionId]) : false,
  );

  // Highlighted index for keyboard navigation in popup menus
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);

  // Pending token insert signal for ComposerInput contentEditable
  const pendingTokenInsert = useRef<{ text: string; type: 'slash' | 'mention' } | null>(null);

  // Version counter to force ComposerInput useEffect re-run when a token is selected
  const [tokenInsertVersion, setTokenInsertVersion] = useState(0);

  // Version counter to force ComposerInput refocus after file picker closes
  const [focusVersion, setFocusVersion] = useState(0);

  // AbortControllers per conversation, for clean cancellation via AbortSignal.
  // The proxy returns a dummy message (not throw), so onSuccess fires instead
  // of onError, preserving the user message in the chat. One per session
  // because a window can have several runs in flight.
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const [commandDialog, setCommandDialog] = useState<SlashCommandDialogData | null>(null);

  // Config for model/think level
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => sdk.config.get(),
  });

  const updateConfigMut = useMutation({
    mutationFn: (data: Partial<Config>) => sdk.config.update(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
  });

  // Available models for /model slash command
  const { data: availableModels } = useQuery({
    queryKey: ['models'],
    queryFn: () => sdk.config.listModels(),
  });

  // Available skills loaded dynamically from SDK
  const { data: availableSkills } = useQuery({
    queryKey: ['skills'],
    queryFn: () => sdk.config.listSkills(),
  });

  // Skills switched off in Settings → Skills are unavailable: hidden from the
  // `/` menu and never sent. All available skills go to the model every turn;
  // the model decides which one applies.
  const enabledSkills = useMemo(() => {
    if (!availableSkills) return [];
    const off = new Set(disabledSkills);
    return availableSkills.filter((skill) => !off.has(skill.id));
  }, [availableSkills, disabledSkills]);
  const enabledSkillIds = useMemo(
    () => enabledSkills.map((skill) => skill.id),
    [enabledSkills],
  );

  // ── Per-message skill reference ──
  // Choosing a skill from `/` does NOT change the session: it adds one
  // instruction to this message and is cleared after sending. The model still
  // sees every enabled skill in the standing index, so nothing is hidden from
  // it and the tool/skill set stays stable (prompt cache intact).
  const [pendingSkills, setPendingSkills] = useState<Skill[]>([]);
  const pendingSkillsRef = useRef<Skill[]>([]);
  useEffect(() => {
    pendingSkillsRef.current = pendingSkills;
  }, [pendingSkills]);

  const addPendingSkill = useCallback((skill: Skill) => {
    setPendingSkills((prev) =>
      prev.some((s) => s.id === skill.id) ? prev : [...prev, skill],
    );
  }, []);

  // The `/` menu is commands plus the enabled skills. Skill entries carry
  // `skillId`; selecting one adds a reference chip instead of inserting a
  // command token.
  type SlashMenuItem = RegisteredCommand & { skillId?: string };
  const slashItems = useMemo<SlashMenuItem[]>(
    () => [
      // Skills first: `/` is primarily the quick-reference path for them; the
      // fixed command list is short and still one scroll away.
      ...enabledSkills.map((skill) => ({
        id: `skill-${skill.id}`,
        name: skill.name,
        description: skill.description,
        category: 'skill' as const,
        source: 'skill',
        skillId: skill.id,
      })),
      ...registeredCommands,
    ],
    [registeredCommands, enabledSkills],
  );

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      files.forEach((file) => {
        const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        let attType: Attachment['type'] = 'other';
        const mime = file.type || '';

        if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/i.test(mime)) {
          attType = 'image';
        } else if (mime === 'application/pdf') {
          attType = 'pdf';
        } else if (
          /^application\/vnd\.openxmlformats-officedocument\./.test(mime) ||
          mime === 'application/msword'
        ) {
          attType = 'office';
        } else if (
          /^text\/(x-|plain|html|css|csv|xml|javascript|typescript)/.test(mime) ||
          mime === 'application/json' ||
          mime === 'application/javascript'
        ) {
          attType = 'code';
        } else if (/^audio\//.test(mime)) {
          attType = 'audio';
        } else if (/^video\//.test(mime)) {
          attType = 'video';
        }

        addAttachment({
          id,
          name: file.name,
          type: attType,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          status: 'uploading',
          // Persisted only long enough to copy the file when the message is
          // sent (see sendMutation.onMutate).
          sourcePath: pathForFile(file),
          createdAt: new Date().toISOString(),
        });
        // Read file content as base64 for sending to vision models
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip "data:image/png;base64," prefix to get raw base64
          const base64 = result.split(',')[1] || result;
          updateAttachmentData(id, base64);
        };
        reader.onerror = () => {
          updateAttachmentData(id, '');
        };
        reader.readAsDataURL(file);
      });
      // Restore focus to the input after the native file picker closes
      setFocusVersion((v) => v + 1);
    },
    [addAttachment, updateAttachmentData],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, [setIsDragging]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, [setIsDragging]);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    },
    [handleFilesSelected, setIsDragging],
  );

  const handlePreviewAttachment = useCallback(
    (attachment: Attachment) => {
      if (attachment.url) {
        setActivePreviewFile(attachment.url);
      }
    },
    [setActivePreviewFile],
  );

  // Build dynamic mention items from active workspace/session context
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });

  const { data: sessions } = useQuery({
    queryKey: ['sessions', activeWorkspaceId],
    queryFn: () => (activeWorkspaceId ? sdk.session.list(activeWorkspaceId) : []),
    enabled: !!activeWorkspaceId,
  });

  // Fetch workspace files for @ mention autocomplete
  const { data: workspaceFiles } = useQuery({
    queryKey: ['files', activeWorkspaceId, showMentionMenu],
    queryFn: () => (activeWorkspaceId ? sdk.file.list(activeWorkspaceId) : []),
    enabled: !!activeWorkspaceId && showMentionMenu,
    staleTime: 30_000,
  });

  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = [];
    workspaces?.forEach((w) =>
      items.push({ id: `ws-${w.id}`, type: 'workspace', label: w.name, description: `${w.sessionCount} sessions` }),
    );
    sessions?.forEach((s) =>
      items.push({ id: `sess-${s.id}`, type: 'session', label: s.title, description: `${s.messageCount} messages` }),
    );
    // Include workspace files in autocomplete
    if (workspaceFiles && workspaceFiles.length > 0) {
      workspaceFiles.forEach((f) =>
        items.push({
          id: `file-${f.path}`,
          type: f.type === 'directory' ? 'folder' : 'file',
          label: f.name,
          description: f.type === 'directory' ? 'Directory' : f.size ? `${Math.round(f.size / 1024)} KB` : undefined,
        }),
      );
    } else {
      // Fallback placeholders when no workspace or no files loaded
      items.push(
        { id: 'file-default', type: 'file', label: 'current file', description: 'Reference current file' },
        { id: 'folder-default', type: 'folder', label: 'project root', description: 'Reference project folder' },
        { id: 'code-default', type: 'code', label: 'selection', description: 'Current code selection' },
      );
    }
    return items;
  }, [workspaces, sessions, workspaceFiles]);

  const handleStopGeneration = useCallback(() => {
    if (!activeSessionId) return;
    // Trigger clean cancellation via AbortSignal → proxy returns dummy msg → onSuccess fires
    abortControllersRef.current.get(activeSessionId)?.abort();
    // Fire-and-forget server-side cleanup (don't block UI)
    sdk.chat.stopGeneration(activeSessionId).catch(() => {});
    // Instant UI feedback: this conversation goes idle, others are untouched.
    useComposerStore.getState().endSessionStream(activeSessionId, { clear: true });
  }, [sdk, activeSessionId]);

  // Watch for retry trigger from ChatTimeline
  useEffect(() => {
    if (triggerSend > 0 && activeSessionId) {
      const state = useComposerStore.getState();
      const content = state.triggerContent;
      const pluginMessage = state.triggerPluginMessage;
      // A branch point is consumed by this send even if the send fails: the
      // tree move happens inside the send, so a retry afterward continues on
      // whichever branch the last attempt actually opened.
      const pending = state.pendingBranch;
      // An edit may legitimately be attachment-only (the user rewrote the text
      // away but kept the file), and a replayed turn may carry no text at all.
      if (content.trim() || pending?.replay || state.triggerAttachments.length > 0) {
        sendMutation.mutate({
          content,
          sessionId: activeSessionId,
          attachments: state.triggerAttachments,
          skills: [],
          ...(pluginMessage ? { pluginMessage } : {}),
          ...(pending?.replay ? { replayTurn: { entryId: pending.entryId } } : {}),
          ...(pending && !pending.replay ? { branchFrom: pending.entryId } : {}),
        });
        state.setPendingBranch(null);
        if (pluginMessage) {
          // The plugin never touched the input: leave whatever the user was
          // drafting exactly where it is; just consume the card.
          state.setTriggerPluginMessage(null);
        } else if (!pending?.replay) {
          setValue('');
        }
      }
    }
  }, [triggerSend]);

  // Store last user message for potential retry
  const lastUserMessageRef = useRef<string>('');
  // Attachment id → where the send copied it. Filled in onMutate, read by
  // mutationFn to build the prompt and the optimistic blocks.
  const savedAttachmentsRef = useRef(new Map<string, SavedAttachment>());
  const sendMutation = useMutation({
    onMutate: async ({ content, sessionId, attachments, pluginMessage }: SendVariables) => {
      // The conversation is part of the variables, not read again later:
      // `activeSessionId` in the callbacks would point at whichever
      // conversation is on screen when the run finishes.
      abortControllersRef.current.set(sessionId, new AbortController());
      useComposerStore.getState().setSessionPending(sessionId, true);
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ['session', sessionId] });

      // Give every file attachment a real path before it reaches the
      // conversation: the card can then open the right panel, a reload can
      // find it again, and the model can read it without searching the disk.
      const saved = new Map<string, SavedAttachment>();
      if (canSaveAttachment()) {
        await Promise.all(
          attachments.map(async (att) => {
            if (att.type === 'image') return;
            try {
              saved.set(
                att.id,
                await saveAttachmentToWorkspace({
                  name: att.name,
                  ...(att.sourcePath ? { sourcePath: att.sourcePath } : {}),
                  ...(!att.sourcePath && att.data ? { dataBase64: att.data } : {}),
                }),
              );
            } catch (err) {
              // A failed copy never blocks the send; the message simply loses
              // its preview path for this attachment.
              console.warn(`[composer] failed to save attachment ${att.name}:`, err);
            }
          }),
        );
      }
      // Merge by attachment id, never replace: two conversations can be
      // sending at once, and each mutationFn must read its own entries.
      for (const [id, info] of saved) savedAttachmentsRef.current.set(id, info);

      // Build user message blocks from attachments for inline preview
      const userBlocks: ContentBlock[] = [];
      if (attachments.length > 0) {
        // Text content block
        if (content) {
          userBlocks.push({
            id: `b-text-opt-${Date.now()}`,
            type: 'text',
            content,
          });
        }
        for (const att of attachments) {
          if (att.type === 'image' && att.data) {
            userBlocks.push({
              id: `b-img-opt-${att.id}`,
              type: 'image',
              content: att.name,
              mimeType: att.mimeType,
              data: att.data,
            });
          } else {
            // Always create file block for non-image attachments (or
            // images without loaded data), even before base64 data
            // finishes loading. This matches the reload path
            // (stripAttachmentSections) which creates file blocks purely
            // from the [Attached: ...] placeholder text.
            const stored = saved.get(att.id);
            userBlocks.push({
              id: `b-file-opt-${att.id}`,
              type: 'file',
              content: stored?.name ?? att.name,
              mimeType: att.mimeType,
              data: att.data || undefined,
              fileName: stored?.name ?? att.name,
              fileSize: att.size,
              workspacePath: stored?.path,
            });
          }
        }
      }

      // Optimistically show the user message immediately — or, for a plugin
      // request, the request card, since that is what the run was started
      // from. Either is replaced by the transcript when the send lands.
      queryClient.setQueryData(['session', sessionId], (old: any) => {
        if (!old) return old;
        const now = new Date().toISOString();
        const message = pluginMessage
          ? {
              id: `optimistic-plugin-${pluginMessage.id}`,
              sessionId,
              role: 'plugin',
              status: 'complete',
              content: pluginMessage.text ?? '',
              blocks: [],
              ...(pluginMessage.card ? { card: pluginMessage.card } : {}),
              ...(pluginMessage.files?.length ? { files: pluginMessage.files } : {}),
              pluginId: pluginMessage.pluginId,
              pluginMessageId: pluginMessage.id,
              revision: pluginMessage.revision,
              ...(pluginMessage.status ? { pluginStatus: pluginMessage.status } : {}),
              ...(pluginMessage.title ? { title: pluginMessage.title } : {}),
              ...(pluginMessage.quote ? { quote: pluginMessage.quote } : {}),
              ...(pluginMessage.source ? { source: pluginMessage.source } : {}),
              agentVisible: true,
              triggered: true,
              createdAt: now,
              updatedAt: now,
            }
          : {
              id: `optimistic-${Date.now()}`,
              sessionId,
              role: 'user',
              status: 'complete',
              content,
              blocks: userBlocks.length > 0 ? userBlocks : [],
              createdAt: now,
              updatedAt: now,
            };
        return { ...old, messages: [...(old.messages || []), message] };
      });

    },
    mutationFn: async ({ content, sessionId, attachments, skills, pluginMessage, branchFrom, replayTurn }: SendVariables) => {
      if (!pluginMessage) lastUserMessageRef.current = content;
      useComposerStore.getState().beginSessionStream(sessionId);

      // Build prompt text: decode and include text-based file contents,
      // append references for binary files
      const nonImageAtts = attachments.filter((a) => a.type !== 'image' && a.name);
      let promptContent = content;
      if (nonImageAtts.length > 0) {
        const TEXT_MIMES = new Set([
          'text/plain', 'text/html', 'text/css', 'text/csv', 'text/xml',
          'text/javascript', 'text/typescript', 'text/markdown',
          'text/x-python', 'text/x-java', 'text/x-rust', 'text/x-go',
          'text/x-c', 'text/x-c++', 'text/x-sh',
          'application/json', 'application/javascript', 'application/typescript',
          'application/xml', 'application/x-yaml',
        ]);

        const fileSections: string[] = [];
        for (const att of nonImageAtts) {
          const stored = savedAttachmentsRef.current.get(att.id);
          const name = stored?.name ?? att.name;
          // The path suffix is what lets the model open the attachment
          // directly. The session reader strips it for display (and uses it
          // to rebuild the file block after a reload).
          const pathSuffix = stored ? ` -> ${stored.relativePath}` : '';
          if (att.data && TEXT_MIMES.has(att.mimeType)) {
            try {
              // atob returns binary string; decode UTF-8 bytes properly
              const binary = atob(att.data);
              const bytes = new Uint8Array(binary.length);
              for (let j = 0; j < binary.length; j++) {
                bytes[j] = binary.charCodeAt(j);
              }
              const text = new TextDecoder().decode(bytes);
              const ext = (name || '').split('.').pop() || '';
              const fenceExt = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : ext === 'md' ? 'md' : ext;
              fileSections.push(`File: ${name}\n\`\`\`${fenceExt}\n${text}\n\`\`\`${pathSuffix}`);
            } catch {
              fileSections.push(`[Attached: ${name} (${att.type}) - could not decode]${pathSuffix}`);
            }
          } else {
            fileSections.push(`[Attached: ${name} (${att.type})]${pathSuffix}`);
          }
        }
        promptContent = `${content}\n\n${fileSections.join('\n\n')}`;
      }

      // Plugin auto context (contextProviders contribution): collect
      // relevant context from plugins right before sending.
      try {
        const contextSections = await usePluginStore.getState().collectPluginContext(promptContent);
        if (contextSections.length > 0) {
          promptContent = `${promptContent}\n\n---\n[相关上下文]\n${contextSections.join('\n\n')}\n---`;
        }
      } catch { /* context collection never blocks the send */ }

      // Per-message skill references from the `/` menu. This is an instruction
      // for THIS message only — the session's skill set is untouched, and the
      // model still sees every enabled skill in the standing index.
      const referencedSkills = skills;
      if (referencedSkills.length > 0) {
        const list = referencedSkills
          .map((skill) => `- ${skill.name}：${skill.description}`)
          .join('\n');
        promptContent = `${promptContent}\n\n${SKILL_REFERENCE_MARKER}\n${list}\n（技能说明在可用技能列表中，请按该技能的内容执行。）`;
      }

      // Note: the @ prefix on file mentions (e.g. @filename.pptx) is intentionally
      // preserved so that the persisted content keeps the @ and the mention badge
      // renders identically on reload. Workspace/session @mentions already keep @;
      // file mentions now match for consistency.

      // Collect image attachments with base64 data read
      const imageAttachments = attachments
        .filter((a) => a.type === 'image' && a.data)
        .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data! }));

      // Streaming state managed by reducer for consistent block ordering/dedup
      let streamState = initialStreamingState();

      // -- rAF batching for block updates --
      // Without batching, every streaming chunk triggers:
      //   setStreamingBlocks → useMemo → makeStreamingMessage
      //   → ReactMarkdown re-parse → DOM rebuild.
      // Fast models (e.g. Qwen-VL Max) can fire 50+ chunks/second, causing
      // visible flickering. rAF coalesces all chunks in a 16ms frame into
      // a single state update, capping re-renders at ~60fps.
      let pendingRaf = false;
      const rafBlocks: { current: ContentBlock[] } = { current: [] };

      function flushBlockUpdates() {
        pendingRaf = false;
        // Guard per conversation: if this run already ended, a late rAF must
        // not restore stale blocks (the visible slot may belong to another
        // conversation entirely).
        const state = useComposerStore.getState();
        if (!state.streams[sessionId]?.isStreaming) return;
        state.updateSessionStream(sessionId, { blocks: rafBlocks.current });
      }

      function scheduleBlockFlush(blocks: ContentBlock[]) {
        rafBlocks.current = blocks;
        if (!pendingRaf) {
          pendingRaf = true;
          requestAnimationFrame(flushBlockUpdates);
        }
      }

      await sdk.chat.sendMessageStream(
        {
          sessionId,
          content: promptContent,
          workspaceCwd: activeWorkspaceId ?? undefined,
          modelId: config?.defaultModelId,
          attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
          // Every globally enabled skill goes to the model; the model decides
          // which one applies. Per-message references ride in the content.
          skills: enabledSkillIds,
          ...(pluginMessage ? { pluginMessage } : {}),
          ...(branchFrom ? { branchFrom } : {}),
          ...(replayTurn ? { replayTurn } : {}),
        },
        (chunk) => {
          if (chunk.type === 'message_start') {
            streamState = streamReducer(streamState, { type: 'message_start' });
            scheduleBlockFlush(streamState.blocks);
          } else if (chunk.type === 'block' && chunk.block) {
            streamState = streamReducer(streamState, { type: 'block', block: chunk.block as ContentBlock });
            scheduleBlockFlush(streamState.blocks);
          } else if (chunk.type === 'text' && chunk.content) {
            streamState = streamReducer(streamState, { type: 'text_delta', content: chunk.content });
            scheduleBlockFlush(streamState.blocks);
          } else if (chunk.type === 'usage' && chunk.usage) {
            useComposerStore.getState().updateSessionStream(sessionId, { usage: chunk.usage });
          } else if (chunk.type === 'context' && chunk.contextUsage) {
            useComposerStore.getState().updateSessionStream(sessionId, { contextUsage: chunk.contextUsage });
          } else if (chunk.type === 'stats' && chunk.sessionStats) {
            useComposerStore.getState().updateSessionStream(sessionId, { sessionStats: chunk.sessionStats });
          } else if (chunk.type === 'message_timing' && chunk.messageTiming) {
            useComposerStore.getState().updateSessionStream(sessionId, { messageTiming: chunk.messageTiming });
          } else if (chunk.type === 'tool_timing' && chunk.toolTiming) {
            useComposerStore.getState().setSessionToolTiming(sessionId, chunk.toolTiming);
          } else if (chunk.type === 'queue_update' && chunk.queueState) {
            useComposerStore.getState().updateSessionStream(sessionId, {
              steering: chunk.queueState.steering,
              followUp: chunk.queueState.followUp,
            });
          } else if (chunk.type === 'turn_start' && chunk.entryId) {
            // The optimistic bubble becomes the real turn: with an entry id,
            // editing and retrying it work immediately instead of only after
            // the conversation is re-read from disk.
            const entryId = chunk.entryId;
            queryClient.setQueryData(['session', sessionId], (old: any) => {
              if (!old) return old;
              const messages = [...(old.messages || [])];
              for (let i = messages.length - 1; i >= 0; i--) {
                const id = messages[i]?.id;
                if (typeof id === 'string' && id.startsWith('optimistic-')) {
                  messages[i] = { ...messages[i], entryId };
                  return { ...old, messages };
                }
              }
              return old;
            });
          } else if (chunk.type === 'error') {
            useComposerStore.getState().updateSessionStream(sessionId, {
              streamError: chunk.error || t('发生了未知错误'),
            });
          }
        },
        abortControllersRef.current.get(sessionId)?.signal,
      );
    },
    onSuccess: (_data, variables) => {
      const { sessionId } = variables;
      const state = useComposerStore.getState();
      const stream = state.streams[sessionId];

      // Editing state belongs to the visible composer; a background send must
      // not clear a draft the user is editing in another conversation.
      if (state.editingMessageId && sessionId === useUIStore.getState().activeSessionId) {
        clearEditingMessage();
      }

      // Capture this conversation's live data before clearing its slot.
      const blocks = (stream?.blocks ?? []).map((b) => {
        if (b.type === 'tool_call' && b.toolCallId) {
          const ms = stream?.toolTimings.get(b.toolCallId);
          if (ms != null) return { ...b, durationMs: ms };
        }
        return b;
      });

      const content = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.content)
        .join('');

      const streamingUsage = stream?.usage ?? null;

      // Clear this conversation's run BEFORE writing to cache: the slot it
      // owned is gone, and any other conversation keeps its own state.
      state.endSessionStream(sessionId, { clear: true });

      // Now promote the captured streaming data into the query cache as a
      // single assistant message so ChatTimeline transitions without a ghost.
      const now = new Date().toISOString();
      const assistantMsg = {
        id: `msg-${sessionId}-${Date.now()}`,
        sessionId,
        role: 'assistant' as const,
        status: 'complete' as const,
        modelId: config?.defaultModelId ?? 'unknown',
        content,
        blocks,
        usage: streamingUsage ?? undefined,
        createdAt: now,
        updatedAt: now,
      };

      queryClient.setQueryData(['session', sessionId], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          messages: [...(old.messages || []), assistantMsg],
        };
      });

      // A branched send changed the shape of the conversation: the turns after
      // the branch point left the active path, and the new turn carries entry
      // ids and versions the optimistic bubble cannot know. Re-read once, now
      // that the run is over, so the version control is real rather than
      // appearing only after the next reload.
      if (variables.branchFrom || variables.replayTurn) {
        void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      }

      // A run that finished while you were looking elsewhere should announce
      // itself; the session list's spinner disappears at the same moment.
      if (sessionId !== useUIStore.getState().activeSessionId) {
        toast(t('后台会话已完成'));
      }

      queryClient.invalidateQueries({ queryKey: ['files'] });

      // Auto-preview the last generated file in the right panel. A background
      // conversation must not take over the panel the user is looking at.
      const fileBlocks = blocks.filter((b) => b.type === 'file');

      // Only invalidate per-file preview queries when the AI actually used
      // tools or produced file blocks — a pure-text response can't have
      // modified any files, so we skip the refetch to avoid unnecessary
      // network/disk I/O on the currently previewed file.
      const hasToolCalls = blocks.some((b) => b.type === 'tool_call');
      if (hasToolCalls || fileBlocks.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['file'] });
        queryClient.invalidateQueries({ queryKey: ['office'] });
      }

      if (
        fileBlocks.length > 0 &&
        sessionId === useUIStore.getState().activeSessionId
      ) {
        const lastFile = fileBlocks[fileBlocks.length - 1];
        if (lastFile.workspacePath && isPreviewableInRightPanel(lastFile.workspacePath)) {
          setActivePreviewFile(lastFile.workspacePath);
        }
      }

      // Drain queue: removed — steer/followUp are now sent directly via
      // sdk.chat.steer()/sdk.chat.followUp() and processed by the SDK's
      // internal queue. The SDK emits queue_update events that sync the UI.
    },
    onError: (error: Error, variables) => {
      const { sessionId } = variables;
      const store = useComposerStore.getState();
      if (sessionId) {
        // User-initiated cancel via Stop: end the run without an error banner.
        store.endSessionStream(sessionId, {
          clear: true,
          error: error.name === 'AbortError' ? null : error.message || t('发送失败'),
        });
      }
      if (error.name === 'AbortError' || !sessionId) return;

      // Re-read the session rather than restoring the pre-send snapshot.
      //
      // The snapshot rollback assumed "the send failed, so it never happened".
      // That is wrong for the ordinary case: a model error arrives AFTER the
      // message has been written to the session file, so restoring the snapshot
      // deleted a message that was already on disk. The UI and the session
      // disagreed, and the user's own words vanished with no explanation — the
      // symptom that made an out-of-credit account look like a dead send button.
      //
      // Re-reading makes the timeline show what is actually stored, whichever
      // way it went: no message if the send never left, the user's message if it
      // reached the model and the model refused.
      void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    },
    onSettled: (_data, _error, variables) => {
      const { sessionId, attachments } = variables;
      for (const att of attachments) savedAttachmentsRef.current.delete(att.id);
      if (sessionId) {
        useComposerStore.getState().setSessionPending(sessionId, false);
        abortControllersRef.current.delete(sessionId);
      }
    },
  });

  /** Handle registry slash commands locally without sending to LLM */
  const handleSlashCommand = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      // Strip arguments: /bash ls -la → /bash
      const cmdName = trimmed.split(/\s+/)[0];
      const command = registeredCommands.find((c) => c.name === cmdName);
      if (!command) return false;

      // Plugin commands dispatch to their backend via the control plane.
      if (command.source !== 'host') {
        const args = trimmed.slice(cmdName.length).trim();
        executePluginCommand(command.source, command.name, args).then((res) => {
          if (!res.ok) console.error('[composer] plugin command failed:', res.error);
        });
        return true;
      }

      const now = new Date().toISOString();

      if (cmdName === '/help') {
        const helpSections: Array<{ title: string; items: Array<{ name: string; desc: string }> }> = [
          {
            title: t('可用命令'),
            items: registeredCommands.map((c: RegisteredCommand) => ({
              name: c.name,
              desc: commandDescription(c, t),
            })),
          },
          {
            title: t('技能'),
            items: enabledSkills.map((s) => ({
              name: s.name,
              desc: s.description,
            })),
          },
          {
            title: t('键盘快捷键'),
            items: [
              { name: 'Enter', desc: t('发送消息') },
              { name: 'Shift+Enter', desc: t('换行') },
              { name: 'Ctrl+Enter', desc: t('流式回复时引导 agent') },
              { name: '/', desc: t('打开命令菜单，快速操作') },
              { name: '@', desc: t('提及文件、工作区或会话') },
            ],
          },
          {
            title: t('能力'),
            items: [
              { name: t('文件'), desc: t('读取、写入和编辑工作区里的文件') },
              { name: 'Shell', desc: t('用 bash 工具执行 shell 命令') },
              { name: t('搜索'), desc: t('用正则和 glob 模式搜索代码库') },
              { name: 'Office', desc: t('创建和编辑 Office 文档（.docx、.xlsx、.pptx）') },
              { name: t('附件'), desc: t('附加图片和文件供 AI 分析') },
            ],
          },
        ];
        setCommandDialog({ title: 'PiWork', subtitle: t('你的 AI 编程助手'), sections: helpSections });
        return true;
      }

      if (cmdName === '/clear') {
        if (!activeWorkspaceId) return false;
        // Create a new session and switch to it
        sdk.session.create(activeWorkspaceId).then((session) => {
          queryClient.invalidateQueries({ queryKey: ['sessions'] });
          queryClient.invalidateQueries({ queryKey: ['workspaces'] });
          void activateSession(session.id);
        });
        return true;
      }

      if (cmdName === '/config') {
        const thinkLabel: Record<string, MessageKey> = {
          off: '不思考',
          low: '低',
          medium: '中',
          high: '高',
        };
        const skills = enabledSkills.map((s) => s.name).join(', ') || t('无');
        const configSections: Array<{ title: string; items: Array<{ name: string; desc: string }> }> = [
          {
            title: t('当前配置'),
            items: [
              { name: t('模型名称'), desc: config?.defaultModelId ?? t('未设置') },
              {
                name: t('思考等级'),
                desc: config?.defaultThinkLevel
                  ? t(thinkLabel[config.defaultThinkLevel] ?? '中')
                  : t('未设置'),
              },
              { name: t('技能'), desc: skills },
              { name: t('紧凑模式'), desc: compactMode ? t('开') : t('关') },
              { name: t('工作区'), desc: activeWorkspaceId ?? t('无') },
            ],
          },
        ];
        setCommandDialog({
          title: t('配置'),
          subtitle: t('当前会话设置'),
          sections: configSections,
        });
        return true;
      }

      if (cmdName === '/model') {
        const currentModelId = config?.defaultModelId ?? t('未设置');
        const modelItems: Array<{ name: string; desc: string }> = [];
        if (availableModels && availableModels.length > 0) {
          for (const m of availableModels) {
            const marker = m.id === currentModelId ? t('（当前）') : '';
            const status = m.isAvailable ? '' : t('［不可用］');
            modelItems.push({ name: m.name, desc: `${marker}${status}`.trim() });
          }
        } else {
          modelItems.push({ name: t('正在加载'), desc: t('正在加载模型…') });
        }
        const modelSections: Array<{ title: string; items: Array<{ name: string; desc: string }> }> = [
          { title: t('可用模型'), items: modelItems },
          { title: t('当前'), items: [{ name: currentModelId, desc: '' }] },
        ];
        setCommandDialog({
          title: t('模型'),
          subtitle: t('选择会话使用的模型'),
          sections: modelSections,
        });
        return true;
      }

      if (cmdName === '/compact') {
        // Insert a transient "Compacting..." message that will be replaced on completion
        const compactAckId = `compact-ack-${Date.now()}`;
        const compactMsg = {
          id: compactAckId,
          sessionId: activeSessionId,
          role: 'assistant' as const,
          status: 'complete' as const,
          modelId: 'system',
          content: [
            t('## 正在压缩对话上下文'),
            '',
            t('正在总结对话历史以减少 token 用量，同时保留关键上下文…'),
          ].join('\n'),
          blocks: [],
          createdAt: now,
          updatedAt: now,
        };
        queryClient.setQueryData(['session', activeSessionId], (old: any) => {
          if (!old) return old;
          return {
            ...old,
            messages: [...(old.messages || []), compactMsg],
          };
        });
        triggerScrollToBottom();
        return true;
      }

      // Unknown slash commands pass through to the LLM as plain text
      return false;
    },
    [
      sdk,
      registeredCommands,
      executePluginCommand,
      activeSessionId,
      activeWorkspaceId,
      config,
      availableModels,
      enabledSkills,
      compactMode,
      queryClient,
      setActiveSession,
      triggerScrollToBottom,
    ],
  );

  const handleSubmit = useCallback(() => {
    if (
      (!value.trim() && pendingAttachments.length === 0 && pendingSkills.length === 0) ||
      !activeSessionId ||
      activePending
    ) {
      return;
    }

    const trimmed = value.trim();

    // /compact: handle entirely client-side with SDK compaction
    if (trimmed.startsWith('/compact')) {
      // Insert user message BEFORE the acknowledgment so order is correct
      const now = new Date().toISOString();
      const userMsg = {
        id: `compact-user-${Date.now()}`,
        sessionId: activeSessionId,
        role: 'user' as const,
        status: 'complete' as const,
        content: trimmed,
        blocks: [],
        createdAt: now,
        updatedAt: now,
      };
      queryClient.setQueryData(['session', activeSessionId], (old: any) => {
        if (!old) return old;
        return { ...old, messages: [...(old.messages || []), userMsg] };
      });
      // Now insert the "Compacting..." acknowledgment (after user message)
      handleSlashCommand(value);
      setValue('');
      clearAttachments();
      triggerScrollToBottom();

      sdk.chat.compact(activeSessionId).then((result) => {
        queryClient.setQueryData(['session', activeSessionId], (old: any) => {
          if (!old) return old;
          const messages = (old.messages || []).map((m: any) => {
            if (m.id.startsWith('compact-ack-')) {
              return {
                ...m,
                content: [
                  '## Conversation Compacted',
                  '',
                  result.summary,
                  '',
                  '---',
                  `**Tokens before compaction:** ${result.tokensBefore.toLocaleString()}`,
                ].join('\n'),
              };
            }
            return m;
          });
          return { ...old, messages };
        });
      }).catch((err: Error) => {
        const msg = err.message || 'Unknown error';
        const isAlreadyCompacted = msg.toLowerCase().includes('already compacted');
        queryClient.setQueryData(['session', activeSessionId], (old: any) => {
          if (!old) return old;
          const messages = (old.messages || []).map((m: any) => {
            if (m.id.startsWith('compact-ack-')) {
              return {
                ...m,
                content: isAlreadyCompacted
                  ? '**Session already compacted.** The conversation has already been summarized. No additional compaction is needed.'
                  : `**Compaction failed:** ${msg}`,
              };
            }
            return m;
          });
          return { ...old, messages };
        });
      });
      return;
    }

    // Intercept built-in slash commands before sending to LLM
    const slashHandled = handleSlashCommand(value);
    if (slashHandled) {
      setValue('');
      clearAttachments();
      return;
    }

    const attachments = useComposerStore.getState().pendingAttachments;
    const skills = pendingSkillsRef.current;
    // These belong to THIS message; clear them now so a concurrent send in
    // another conversation cannot pick them up.
    setPendingSkills([]);
    pendingSkillsRef.current = [];
    sendMutation.mutate({ content: value, sessionId: activeSessionId, attachments, skills });
    setValue('');
    clearAttachments();
  }, [value, activeSessionId, activePending, setValue, handleSlashCommand, sdk, queryClient, triggerScrollToBottom, pendingAttachments]);

  // Read at call time: transcription takes seconds, and the user may start a
  // stream or switch conversations while it is in flight.
  const sendPendingRef = useRef(false);
  sendPendingRef.current = activePending;

  /** Insert a transcription into the composer, or send it when autoSend is on.
   *  The draft is kept when sending (not replaced), and a transcript that
   *  returns after switching conversations is dropped instead of leaking into
   *  the new one. */
  const handleVoiceTranscript = useCallback(
    (text: string, recordedInSession: string | null) => {
      const clean = text.trim();
      if (!clean) return;
      const state = useComposerStore.getState();
      const currentSession = useUIStore.getState().activeSessionId;
      if (recordedInSession && currentSession && recordedInSession !== currentSession) {
        toast(t('已切换会话，转写结果已丢弃'));
        return;
      }
      if (!currentSession) return;

      const draft = state.value.replace(/\s+$/, '');
      const next = draft ? `${draft} ${clean}` : clean;
      if (voiceSettings?.stt.autoSend && !sendPendingRef.current && !state.isStreaming) {
        sendMutation.mutate({
          content: next,
          sessionId: currentSession,
          attachments: state.pendingAttachments,
          skills: [],
        });
        state.setValue('');
        state.clearAttachments();
        state.triggerScrollToBottom();
        return;
      }
      state.setValue(next);
      setFocusVersion((version) => version + 1);
    },
    [voiceSettings?.stt.autoSend, sendMutation, t],
  );

  const builtinSttModelId = voiceSettings?.stt.builtinModel || 'sensevoice';
  const builtinSttReady =
    voiceSettings?.stt.builtin !== 'off' &&
    voiceModels.some((model) => model.id === builtinSttModelId && model.installed);
  // Until settings/models load, assume configured; otherwise a fast click
  // wrongly reports "model not downloaded".
  const sttConfigured =
    !voiceSettings || voiceModelsLoading || !!voiceSettings.stt.activeProvider || builtinSttReady;
  const sttNeedsModelDownload =
    !!voiceSettings &&
    !voiceModelsLoading &&
    !voiceSettings.stt.activeProvider &&
    voiceSettings.stt.builtin !== 'off' &&
    !builtinSttReady;

  /** Queue a steering message via the SDK. It will be delivered after the
   *  current assistant turn's tool calls complete, redirecting the agent.
   *  If the stream has already ended (fast model, no tool calls), fall back
   *  to a regular submit so the message isn't silently lost. */
  const handleSteerSubmit = useCallback(() => {
    if (!value.trim() || !activeSessionId) return;
    const isStreamingNow = () => {
      const state = useComposerStore.getState();
      return state.activeStreamSessionId === activeSessionId && state.isStreaming;
    };
    if (isStreamingNow()) {
      sdk.chat.steer(activeSessionId, value).catch((err) => {
        console.error('[Steer] Failed to steer:', err);
        // If steer fails because the stream just ended, send it normally.
        if (!isStreamingNow()) {
          useComposerStore.getState().setTriggerSend(value);
        }
      });
    } else {
      // Agent has already finished — send as a regular message
      handleSubmit();
      return;
    }
    setValue('');
  }, [value, activeSessionId, sdk, setValue, handleSubmit]);

  /** Queue a follow-up message via the SDK. It will be delivered after the
   *  agent finishes all work (all tool calls and steering messages processed).
   *  If the stream has already ended, fall back to a regular submit. */
  const handleFollowUpSubmit = useCallback(() => {
    if (!value.trim() || !activeSessionId) return;
    const isStreamingNow = () => {
      const state = useComposerStore.getState();
      return state.activeStreamSessionId === activeSessionId && state.isStreaming;
    };
    if (isStreamingNow()) {
      sdk.chat.followUp(activeSessionId, value).catch((err) => {
        console.error('[FollowUp] Failed to follow up:', err);
        if (!isStreamingNow()) {
          useComposerStore.getState().setTriggerSend(value);
        }
      });
    } else {
      handleSubmit();
      return;
    }
    setValue('');
  }, [value, activeSessionId, sdk, setValue, handleSubmit]);

  const handleSlashDetect = useCallback(
    (query: string) => {
      // Only show menu when there are actual matches; otherwise Enter key
      // gets intercepted for empty-menu selection and the message won't send.
      const hasMatch = slashItems.some(
        (c) => !query || c.name.toLowerCase().includes(query.toLowerCase()),
      );
      if (!hasMatch) {
        setShowSlashMenu(false);
        return;
      }
      setHighlightedSlashIndex(0);
      setShowSlashMenu(true, query);
    },
    [setShowSlashMenu, slashItems],
  );

  const handleMentionDetect = useCallback(
    (query: string) => {
      // Only show menu when there are actual matches; otherwise Enter key
      // gets intercepted for empty-menu selection and the message won't send.
      const hasMatch = mentionItems.some(
        (i) => !query || i.label.toLowerCase().includes(query.toLowerCase()),
      );
      if (!hasMatch) {
        setShowMentionMenu(false);
        return;
      }
      setHighlightedMentionIndex(0);
      setShowMentionMenu(true, query);
      setShowSlashMenu(false);
    },
    [setShowMentionMenu, setShowSlashMenu, mentionItems],
  );

  const handleSlashDismiss = useCallback(() => {
    setShowSlashMenu(false);
    setHighlightedSlashIndex(0);
  }, [setShowSlashMenu]);
  const handleMentionDismiss = useCallback(() => {
    setShowMentionMenu(false);
    setHighlightedMentionIndex(0);
  }, [setShowMentionMenu]);

  // Compute total filtered items for both menus (for index clamping)
  const totalSlashItems = useMemo(() => {
    if (!showSlashMenu) return 0;
    return slashItems.filter(
      (c) => !slashQuery || c.name.toLowerCase().includes(slashQuery.toLowerCase()),
    ).length;
  }, [showSlashMenu, slashQuery, slashItems]);

  const totalMentionItems = useMemo(() => {
    if (!showMentionMenu) return 0;
    return mentionItems.filter(
      (i) => !mentionQuery || i.label.toLowerCase().includes(mentionQuery.toLowerCase()),
    ).length;
  }, [showMentionMenu, mentionQuery, mentionItems]);

  // Keyboard navigation handlers for popup menus
  const handleSlashNavigate = useCallback(
    (direction: 'up' | 'down') => {
      setHighlightedSlashIndex((prev) => {
        if (totalSlashItems === 0) return 0;
        if (direction === 'down') return (prev + 1) % totalSlashItems;
        return (prev - 1 + totalSlashItems) % totalSlashItems;
      });
    },
    [totalSlashItems],
  );

  const handleSlashSelect = useCallback(
    (cmd?: import('@pi/types').SlashCommand & { skillId?: string }) => {
      // If called without args (Enter key), select highlighted item
      if (!cmd) {
        const filtered = slashItems.filter(
          (c) => !slashQuery || c.name.toLowerCase().includes(slashQuery.toLowerCase()),
        );
        cmd = filtered[highlightedSlashIndex];
        if (!cmd) return;
      }

      // A skill is a per-message reference, not a command token: add a chip
      // for this message and clear the typed `/query`. Nothing about the
      // session changes.
      if (cmd.skillId) {
        const skill = enabledSkills.find((s) => s.id === cmd!.skillId);
        if (skill) addPendingSkill(skill);
        setValue(value.replace(/\/([^\s]*)$/, ''));
        setShowSlashMenu(false);
        setHighlightedSlashIndex(0);
        return;
      }

      // cmd.name already includes the / prefix (e.g. "/help")
      const tokenText = cmd.name;
      const withoutSlash = value.replace(/\/(\w*)$/, '');
      setValue(`${withoutSlash}${tokenText}\u00A0`);
      pendingTokenInsert.current = { text: tokenText, type: 'slash' };
      setShowSlashMenu(false);
      setHighlightedSlashIndex(0);
      setTokenInsertVersion((v) => v + 1);
    },
    [
      value,
      setValue,
      setShowSlashMenu,
      slashQuery,
      highlightedSlashIndex,
      slashItems,
      enabledSkills,
      addPendingSkill,
    ],
  );

  const handleMentionNavigate = useCallback(
    (direction: 'up' | 'down') => {
      setHighlightedMentionIndex((prev) => {
        if (totalMentionItems === 0) return 0;
        if (direction === 'down') return (prev + 1) % totalMentionItems;
        return (prev - 1 + totalMentionItems) % totalMentionItems;
      });
    },
    [totalMentionItems],
  );

  const handleMentionSelect = useCallback(
    (item?: MentionItem) => {
      if (!item) {
        const filtered = mentionItems.filter(
          (i) => !mentionQuery || i.label.toLowerCase().includes(mentionQuery.toLowerCase()),
        );
        item = filtered[highlightedMentionIndex];
        if (!item) return;
      }
      const withoutMention = value.replace(/@([^\s]*)$/, '');
      const tokenText = `@${item.label}`;
      setValue(`${withoutMention}${tokenText}\u00A0`);
      setShowMentionMenu(false);
      setHighlightedMentionIndex(0);
      setTokenInsertVersion((v) => v + 1);
    },
    [value, setValue, setShowMentionMenu, mentionQuery, highlightedMentionIndex, mentionItems],
  );

  // Menu navigation handler (delegates to correct menu based on which is open)
  const handleMenuNavigate = useCallback(
    (direction: 'up' | 'down') => {
      if (showSlashMenu) handleSlashNavigate(direction);
      else if (showMentionMenu) handleMentionNavigate(direction);
    },
    [showSlashMenu, showMentionMenu, handleSlashNavigate, handleMentionNavigate],
  );

  const handleMenuSelect = useCallback(() => {
    if (showSlashMenu) handleSlashSelect();
    else if (showMentionMenu) handleMentionSelect();
  }, [showSlashMenu, showMentionMenu, handleSlashSelect, handleMentionSelect]);

  // Deliberately NOT `if (!activeSessionId) return null`: switching workspace
  // clears the session for a moment while the new one is created, and
  // unmounting here makes the input box blink. The input is already disabled
  // when there is no session, so rendering it dimmed is both truthful and
  // flicker-free.

  return (
    <div
      className={cn(
        'rounded-3xl border border-border bg-card shadow-xs mx-4 mb-4 overflow-visible transition-colors',
        // 完全访问 states itself on its own control (red icon + label in
        // PermissionModeButton). Ringing the whole composer reads as "this
        // input is wrong" and paints every surrounding element red, so the
        // composer keeps its normal border.
        isDragging && 'ring-2 ring-muted-foreground/30 border-muted-foreground/50',
      )}
    >
      {/* Attachment previews */}
      {pendingAttachments.length > 0 && (
        <div className="px-3 pt-3 space-y-2">
          <AttachmentPreviewBar
            attachments={pendingAttachments}
            onRemove={removeAttachment}
            onPreview={handlePreviewAttachment}
          />
        </div>
      )}

      {/* Per-message skill references from the `/` menu. Cleared after send. */}
      {pendingSkills.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
          {pendingSkills.map((skill) => (
            <span
              key={skill.id}
              title={skill.description}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 pl-2 pr-1 text-[11px]"
            >
              <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="max-w-[180px] truncate">{skill.name}</span>
              <button
                type="button"
                aria-label={t('移除技能引用')}
                onClick={() =>
                  setPendingSkills((prev) => prev.filter((s) => s.id !== skill.id))
                }
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input area with drag-drop */}
      <div
        className="relative mx-3 mt-3"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Slash Command / Mention Menus */}
        {showSlashMenu && (
          <SlashCommandMenu
            commands={slashItems}
            query={slashQuery}
            highlightedIndex={highlightedSlashIndex}
            onSelect={handleSlashSelect}
          />
        )}
        {showMentionMenu && (
          <MentionMenu
            items={mentionItems}
            query={mentionQuery}
            highlightedIndex={highlightedMentionIndex}
            onSelect={handleMentionSelect}
          />
        )}

        {/* Textarea */}
        <ComposerInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          onSlashDetected={handleSlashDetect}
          onMentionDetected={handleMentionDetect}
          onSlashDismiss={handleSlashDismiss}
          onMentionDismiss={handleMentionDismiss}
          disabled={!activeSessionId}
          placeholder={
            isStreaming ? t('按 Enter 继续追问，或点「引导」改变方向…') : undefined
          }
          showMenu={showSlashMenu || showMentionMenu}
          onMenuNavigate={handleMenuNavigate}
          onMenuSelect={handleMenuSelect}
          isStreaming={isStreaming}
          onSteerSubmit={handleSteerSubmit}
          onFollowUpSubmit={handleFollowUpSubmit}
          pendingTokenInsert={pendingTokenInsert}
          tokenInsertVersion={tokenInsertVersion}
          focusVersion={focusVersion}
        />

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-lg border-2 border-dashed border-muted-foreground/40 z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <Upload className="h-6 w-6" />
              <span className="text-xs font-medium">{t('松开即可添加附件')}</span>
            </div>
          </div>
        )}
      </div>

      {/* Queued steer / follow-up messages indicator */}
      <QueueIndicator />

      {/* Divider */}
      <Separator className="mt-3" />

      {/* Bottom tools row. Left zone: input action · model/effort ·
          permission mode. Right zone: voice input and the primary action,
          separated by a wider gap so the mic does not crowd Send. Every
          control is 28px tall; the model name is the only thing that shrinks. */}
      <div className="flex min-w-0 items-center gap-1 px-2.5 py-2">
        <FileUploadButton
          disabled={isStreaming}
          onFilesSelected={handleFilesSelected}
        />
        <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <ModelSelector
          value={config?.defaultModelId ?? ''}
          onChange={(modelId) => updateConfigMut.mutate({ defaultModelId: modelId })}
        />
        <ThinkLevelSelector
          value={config?.defaultThinkLevel ?? 'medium'}
          onChange={(level) => updateConfigMut.mutate({ defaultThinkLevel: level })}
        />
        <PermissionModeButton />
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <VoiceInputButton
            disabled={!activeSessionId}
            configured={sttConfigured}
            needsModelDownload={sttNeedsModelDownload}
            sessionId={activeSessionId}
            onTranscribed={handleVoiceTranscript}
          />

        {isStreaming ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSteerSubmit}
              disabled={!value.trim()}
              className="h-8 gap-1.5 text-xs"
              aria-label={t('引导（Ctrl+Enter）')}
            >
              <CornerDownRight className="h-3.5 w-3.5" />
              {t('引导')}
              <kbd className="ml-0.5 text-[10px] opacity-60 hidden sm:inline">⌃↵</kbd>
            </Button>
            <Button
              size="icon"
              variant="destructive"
              onClick={handleStopGeneration}
              className="h-8 w-8 shrink-0"
              aria-label={t('停止生成')}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <SendButton
            onClick={handleSubmit}
            disabled={
              (!value.trim() && pendingAttachments.length === 0 && pendingSkills.length === 0) ||
              !activeSessionId
            }
            isLoading={activePending}
          />
        )}
        </div>
      </div>

      {/* Slash command dialog (/help, /config, /model) */}
      <SlashCommandDialog data={commandDialog} onClose={() => setCommandDialog(null)} />
    </div>
  );
}
