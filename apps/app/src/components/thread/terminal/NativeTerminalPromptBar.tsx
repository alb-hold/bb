import { CONTENT_MEASURE_MAX_WIDTH_CLASS } from "@/lib/content-measure";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { PromptInput } from "@bb/domain";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  COMPOSER_SHELL_CLASS,
  COMPOSER_SUBMIT_CLASS,
  COMPOSER_SEND_ICON,
} from "@bb/shared-ui/composer-primitives";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { appToast } from "@/components/ui/app-toast";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useSendNativeTerminalMessage } from "@/hooks/queries/native-terminal-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useWritingAssistanceView } from "@/hooks/queries/writing-assistance-queries";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { useSegmentedDictation } from "@/hooks/useSegmentedDictation";
import { sdk } from "@/lib/sdk";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  diffText,
  joinDictation,
  mapCaret,
  mapOffset,
  type TextChange,
} from "./composer-text-ops";
import { AssistStrip, DictationStrip } from "./NativeComposerStatus";
import { useTypingAssistance } from "./useTypingAssistance";

interface NativeTerminalPromptBarProps {
  projectId: string;
  providerLabel: string;
  threadId: string;
  executionLabel?: string;
  modelLabel?: string;
}

const PUSH_TO_TALK_HOLD_MS = 350;
const MAX_TEXTAREA_HEIGHT_PX = 192;
const DICTATION_CONTEXT_CHARS = 400;

const supportsFieldSizing =
  typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("field-sizing", "content")
    : false;

function attachmentPromptInput(
  attachment: UploadedPromptAttachment,
): PromptInput {
  if (attachment.type === "localImage") {
    return {
      type: "localImage",
      path: attachment.path,
      ...(attachment.sourceProjectId === undefined
        ? {}
        : { sourceProjectId: attachment.sourceProjectId }),
    };
  }
  return {
    type: "localFile",
    path: attachment.path,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.mimeType === undefined
      ? {}
      : { mimeType: attachment.mimeType }),
    ...(attachment.sourceProjectId === undefined
      ? {}
      : { sourceProjectId: attachment.sourceProjectId }),
  };
}

function pastedFiles(clipboard: Pick<DataTransfer, "files" | "items">): File[] {
  const files = Array.from(clipboard.files ?? []);
  if (files.length > 0) return files;
  return Array.from(clipboard.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

export function NativeTerminalPromptBar({
  projectId,
  providerLabel,
  executionLabel,
  modelLabel,
  threadId,
}: NativeTerminalPromptBarProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [wraps, setWraps] = useState(false);
  const textRef = useRef("");
  const programmaticRef = useRef(false);
  const composingRef = useRef(false);
  const lastChangeRef = useRef<TextChange | null>(null);
  const anchorRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<readonly [number, number] | null>(null);
  const dictatedStartRef = useRef<number | null>(null);
  const sendAfterDictationRef = useRef(false);
  const pressRef = useRef<{
    startedAt: number;
    startedDictation: boolean;
  } | null>(null);
  const releasePressRef = useRef<(() => void) | null>(null);
  const ignoreClickRef = useRef(false);
  const [attachments, setAttachments] = useState<UploadedPromptAttachment[]>(
    [],
  );
  const [pendingUploads, setPendingUploads] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const send = useSendNativeTerminalMessage();
  const upload = useUploadPromptAttachment();
  const systemConfig = useSystemConfig();
  const writing = useWritingAssistanceView();
  const paneIsFocused = useOptionalPaneContext()?.isFocused ?? true;
  const voiceAvailable = systemConfig.data?.voiceTranscriptionEnabled === true;
  const settings = writing.data?.settings;
  const assistEnabled =
    writing.data !== undefined &&
    writing.data.correctionAvailable &&
    settings?.typingCorrection !== "off" &&
    settings?.mode !== "literal-code";
  const message = text.trim();

  const applyValue = useCallback((next: string, programmatic: boolean) => {
    const change = diffText(textRef.current, next);
    textRef.current = next;
    setText(next);
    lastChangeRef.current = change;
    if (change === null) return;
    if (anchorRef.current !== null) {
      anchorRef.current = mapOffset(change, anchorRef.current, "after");
    }
    if (dictatedStartRef.current !== null) {
      dictatedStartRef.current = mapOffset(
        change,
        dictatedStartRef.current,
        "before",
      );
    }
    assistRef.current?.onTextChange(change, programmatic);
  }, []);

  const replaceText = useCallback(
    (start: number, end: number, replacement: string) => {
      const element = textareaRef.current;
      const current = textRef.current;
      if (start < 0 || end > current.length || start > end) return;
      if (
        element !== null &&
        document.activeElement === element &&
        typeof document.execCommand === "function"
      ) {
        const selectionStart = element.selectionStart;
        const selectionEnd = element.selectionEnd;
        programmaticRef.current = true;
        lastChangeRef.current = null;
        let applied = false;
        try {
          element.setSelectionRange(start, end);
          applied =
            replacement.length > 0
              ? document.execCommand("insertText", false, replacement)
              : start === end || document.execCommand("delete");
        } finally {
          programmaticRef.current = false;
        }
        if (applied && textRef.current !== current) {
          const change = lastChangeRef.current;
          if (change !== null) {
            element.setSelectionRange(
              mapCaret(change, selectionStart),
              mapCaret(change, selectionEnd),
            );
          }
          return;
        }
        element.setSelectionRange(selectionStart, selectionEnd);
      }
      const selection =
        element !== null && document.activeElement === element
          ? ([element.selectionStart, element.selectionEnd] as const)
          : null;
      applyValue(
        `${current.slice(0, start)}${replacement}${current.slice(end)}`,
        true,
      );
      const change = lastChangeRef.current;
      if (selection !== null && change !== null) {
        pendingSelectionRef.current = [
          mapCaret(change, selection[0]),
          mapCaret(change, selection[1]),
        ];
      }
    },
    [applyValue],
  );

  const assist = useTypingAssistance({
    enabled: assistEnabled,
    getText: () => textRef.current,
    getCaret: () => {
      const element = textareaRef.current;
      return element !== null && document.activeElement === element
        ? element.selectionStart
        : null;
    },
    isComposing: () => composingRef.current,
    isBusy: () => send.isPending,
    replace: replaceText,
    correct: (request, signal) =>
      sdk.writingAssistance.correct({ ...request, signal }),
  });
  const assistRef = useRef(assist);
  assistRef.current = assist;

  const insertDictation = useCallback(
    (piece: string) => {
      const trimmed = piece.trim();
      if (trimmed.length === 0) return;
      const current = textRef.current;
      const anchor = Math.min(
        anchorRef.current ?? current.length,
        current.length,
      );
      const joined = joinDictation(
        current.slice(0, anchor),
        trimmed,
        current.slice(anchor),
      );
      const trailing = joined.endsWith(" ") && !trimmed.endsWith(" ") ? 1 : 0;
      if (dictatedStartRef.current === null) {
        dictatedStartRef.current = anchor;
      }
      replaceText(anchor, anchor, joined);
      anchorRef.current = anchor + joined.length - trailing;
    },
    [replaceText],
  );

  const submitRef = useRef<() => void>(() => {});

  const dictation = useSegmentedDictation({
    transcribe: ({ file, signal }) => {
      const anchor = anchorRef.current ?? textRef.current.length;
      return sdk.writingAssistance
        .transcribeDictationSegment({
          file,
          context: textRef.current.slice(
            Math.max(0, anchor - DICTATION_CONTEXT_CHARS),
            anchor,
          ),
          signal,
        })
        .then((result) => result.text);
    },
    onText: insertDictation,
    onError: (description) => {
      appToast.error("Dictation stopped", { description });
    },
    onFinished: () => {
      const start = dictatedStartRef.current;
      const end = anchorRef.current;
      dictatedStartRef.current = null;
      anchorRef.current = null;
      if (sendAfterDictationRef.current) {
        sendAfterDictationRef.current = false;
        submitRef.current();
        return;
      }
      if (start !== null && end !== null && end > start) {
        assistRef.current.analyzeRange(start, end);
      }
    },
  });
  const dictating = dictation.phase !== "idle";

  const canSend =
    (message.length > 0 || attachments.length > 0 || dictating) &&
    pendingUploads === 0 &&
    !send.isPending;

  const uploadFiles = async (files: readonly File[]) => {
    setAttachError(null);
    setPendingUploads((count) => count + files.length);
    const failed: string[] = [];
    for (const file of files) {
      try {
        const uploaded = await upload.mutateAsync({ projectId, file });
        setAttachments((current) => [...current, uploaded]);
      } catch {
        failed.push(file.name);
      } finally {
        setPendingUploads((count) => count - 1);
      }
    }
    if (failed.length > 0) {
      setAttachError(`Failed to attach ${failed.join(", ")}`);
    }
  };

  const attachFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    uploadFiles(files).catch(() => {
      setAttachError("Failed to attach the selected files");
    });
  };

  const submitNow = () => {
    const sentText = textRef.current;
    const sentMessage = sentText.trim();
    const sentAttachments = attachments;
    if (sentMessage.length === 0 && sentAttachments.length === 0) return;
    if (pendingUploads > 0 || send.isPending) return;
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId,
      threadId,
    });
    const sentDraft = draft.getCurrent();
    const input: PromptInput[] = [
      ...sentAttachments.map(attachmentPromptInput),
      ...(sentMessage.length === 0
        ? []
        : [{ type: "text" as const, text: sentMessage, mentions: [] }]),
    ];
    send.mutate(
      { input, threadId },
      {
        onSuccess: () => {
          draft.clearIfCurrentMatches(sentDraft);
          if (textRef.current === sentText) applyValue("", true);
          setAttachments((current) =>
            current.filter(
              (attachment) => !sentAttachments.includes(attachment),
            ),
          );
        },
      },
    );
  };
  submitRef.current = submitNow;

  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSend) return;
    if (dictating) {
      sendAfterDictationRef.current = true;
      dictation.stop();
      return;
    }
    submitNow();
  };

  const startDictation = () => {
    const element = textareaRef.current;
    anchorRef.current =
      element !== null && document.activeElement === element
        ? element.selectionEnd
        : textRef.current.length;
    dictatedStartRef.current = null;
    sendAfterDictationRef.current = false;
    void dictation.start();
  };

  const toggleDictation = () => {
    if (dictation.phase === "idle") startDictation();
    else if (
      dictation.phase === "recording" ||
      dictation.phase === "starting"
    ) {
      dictation.stop();
    }
  };

  const dictationShortcut = useAppCommandShortcut("composer.dictation.toggle");
  useAppCommandHandler(
    "composer.dictation.toggle",
    () => {
      toggleDictation();
      return true;
    },
    1,
    voiceAvailable && paneIsFocused,
  );

  const stopDictation = dictation.stop;
  const finishPress = useCallback(
    (cancelled: boolean, onButton: boolean, releasedAt: number) => {
      releasePressRef.current?.();
      if (!onButton) ignoreClickRef.current = false;
      const press = pressRef.current;
      pressRef.current = null;
      if (press === null || !press.startedDictation) return;
      if (cancelled || releasedAt - press.startedAt >= PUSH_TO_TALK_HOLD_MS) {
        stopDictation();
      }
    },
    [stopDictation],
  );

  useEffect(() => () => releasePressRef.current?.(), []);

  const onMicPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    ignoreClickRef.current = true;
    releasePressRef.current?.();
    const startedDictation = dictation.phase === "idle";
    pressRef.current = { startedAt: event.timeStamp, startedDictation };
    const pointerId = event.pointerId;
    const button = event.currentTarget;
    const onUp = (release: globalThis.PointerEvent) => {
      if (release.pointerId !== pointerId) return;
      finishPress(
        false,
        release.target instanceof Node && button.contains(release.target),
        release.timeStamp,
      );
    };
    const onCancel = (release: globalThis.PointerEvent) => {
      if (release.pointerId === pointerId)
        finishPress(true, false, release.timeStamp);
    };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    releasePressRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      releasePressRef.current = null;
    };
    toggleDictation();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && dictating) {
      event.preventDefault();
      dictation.cancel();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(files);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const files = pastedFiles(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(files);
  };

  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    const element = textareaRef.current;
    pendingSelectionRef.current = null;
    if (
      selection === null ||
      element === null ||
      document.activeElement !== element
    ) {
      return;
    }
    element.setSelectionRange(selection[0], selection[1]);
  }, [text]);

  const measureInput = useCallback(() => {
    const element = textareaRef.current;
    const shell = element?.closest<HTMLElement>("[data-native-composer]");
    const actions = shell?.querySelector<HTMLElement>("[data-native-composer-actions]");
    if (!element || !shell || !actions) return;
    const style = getComputedStyle(element);
    const shellStyle = getComputedStyle(shell);
    const buttons = Array.from(actions.querySelectorAll("button"));
    const actionsWidth = buttons.reduce((sum, button) => sum + Math.max(44, button.getBoundingClientRect().width), 0) +
      Math.max(0, buttons.length - 1) * 4;
    const width = shell.clientWidth - parseFloat(shellStyle.paddingLeft || "0") -
      parseFloat(shellStyle.paddingRight || "0") - actionsWidth;
    const previousWidth = element.style.width;
    const previousHeight = element.style.height;
    const previousMinHeight = element.style.minHeight;
    element.style.width = `${Math.max(1, width)}px`;
    element.style.minHeight = "0";
    element.style.height = "0";
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const padding = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
    setWraps(text.includes("\n") || element.scrollHeight > lineHeight + padding + 1);
    element.style.width = previousWidth;
    element.style.minHeight = previousMinHeight;
    element.style.height = previousHeight;
    if (!supportsFieldSizing) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
    }
  }, [text]);

  useLayoutEffect(measureInput, [measureInput]);

  useLayoutEffect(() => {
    const shell = textareaRef.current?.closest<HTMLElement>("[data-native-composer]");
    if (!shell) return;
    let previousWidth = shell.clientWidth;
    const observer = new ResizeObserver(() => {
      if (shell.clientWidth === previousWidth) return;
      previousWidth = shell.clientWidth;
      measureInput();
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [measureInput]);

  const inline = !wraps && attachments.length === 0 && pendingUploads === 0 &&
    attachError === null && !dictating && assist.suggestions.length === 0 &&
    assist.recent === null && !assist.pending;

  const recording =
    dictation.phase === "recording" || dictation.phase === "starting";
  const micLabel = recording
    ? "Stop dictation"
    : `Dictate a message to ${providerLabel}`;

  return (
    <form
      className={cn(
        "mx-auto flex w-full shrink-0 flex-col gap-1.5 bg-sidebar px-4 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        CONTENT_MEASURE_MAX_WIDTH_CLASS,
      )}
      data-native-terminal-prompt=""
      onSubmit={submit}
    >
      {attachments.length > 0 || pendingUploads > 0 || attachError !== null ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {attachments.map((attachment, index) => (
            <span
              key={`${attachment.path}-${index}`}
              className="flex max-w-full items-center gap-1 rounded-md border border-border bg-background py-0.5 pr-0.5 pl-2 text-foreground"
            >
              <Icon name="Paperclip" className="size-3 shrink-0" />
              <span className="truncate">{attachment.name}</span>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => {
                  setAttachments((current) =>
                    current.filter((_, position) => position !== index),
                  );
                }}
              >
                <Icon name="X" className="size-3" />
              </button>
            </span>
          ))}
          {pendingUploads > 0 ? (
            <span className="text-muted-foreground">Attaching…</span>
          ) : null}
          {attachError === null ? null : (
            <span role="alert" className="text-destructive">
              {attachError}
            </span>
          )}
        </div>
      ) : null}
      <div
        className={cn(
          COMPOSER_SHELL_CLASS,
          "flex flex-col px-1.5 py-0.5 transition-[border-color,box-shadow] duration-200 focus-within:border-ring/60 motion-reduce:transition-none",
          recording && "border-destructive/40",

        )}
        data-native-composer=""
        data-native-composer-inline={inline ? "" : undefined}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {dictation.phase === "idle" ? null : (
          <DictationStrip
            phase={dictation.phase}
            startedAt={dictation.startedAt}
            stream={dictation.stream}
            pending={dictation.pending}
            failure={dictation.failure}
            onCancel={dictation.cancel}
            onRetry={dictation.retry}
            onDiscard={dictation.discardFailed}
          />
        )}
        {executionLabel?.trim() &&
        executionLabel.trim() !== providerLabel.trim() ? (
          <div
            aria-label="Terminal execution"
            className="col-span-2 truncate px-2 text-xs leading-tight text-muted-foreground"
          >
            <span className="block truncate" title={executionLabel ?? providerLabel}>
              {executionLabel}
            </span>
          </div>
        ) : null}
        <label className="sr-only" htmlFor={inputId}>
          Send to {providerLabel} terminal
        </label>
        <textarea
          ref={textareaRef}
          id={inputId}
          rows={1}
          value={text}
          enterKeyHint="send"
          spellCheck
          autoCorrect="on"
          placeholder={
            dictation.phase === "starting"
              ? "Starting microphone…"
              : recording
                ? "Listening…"
                : `Type to ${providerLabel}’s terminal…`
          }
          onChange={(event) => {
            applyValue(event.target.value, programmaticRef.current);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(
            "max-h-48 min-h-7 min-w-0 w-full resize-none bg-transparent px-2 py-1 text-base md:text-sm text-foreground field-sizing-content placeholder:text-sm placeholder:text-muted-foreground focus-visible:outline-none",
          )}
        />
        <AssistStrip
          suggestions={assist.suggestions}
          recent={assist.recent}
          refining={
            assist.pending ||
            (dictation.phase === "finalizing" && dictation.pending > 0)
          }
          onAccept={assist.acceptSuggestion}
          onDismiss={assist.dismissSuggestion}
          onUndo={assist.undoRecent}
        />
        <div data-native-composer-actions="" className="flex shrink-0 items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-label={`Attach images for ${providerLabel}`}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              attachFiles(files);
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-9 shrink-0 rounded-full pointer-coarse:size-11"
            aria-label="Attach image"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="Plus" className="size-4" />
          </Button>
          {modelLabel ? (
            <div aria-label="Terminal model" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              <span title={modelLabel}>{modelLabel}</span>
            </div>
          ) : <div className="flex-1" />}
          {voiceAvailable ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                "relative size-9 shrink-0 rounded-full transition-colors duration-200 pointer-coarse:size-11 motion-reduce:transition-none",
                recording &&
                  "bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive",
              )}
              aria-label={micLabel}
              aria-pressed={recording}
              aria-keyshortcuts={dictationShortcut?.ariaKeyshortcuts}
              data-dictation-state={dictation.phase}
              onPointerDown={onMicPointerDown}
              onClick={(event) => {
                const fromPointer = event.detail > 0;
                if (ignoreClickRef.current) {
                  ignoreClickRef.current = false;
                  if (fromPointer) return;
                }
                toggleDictation();
              }}
            >
              {recording ? (
                <>
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-full ring-2 ring-destructive/30 motion-safe:animate-ping motion-safe:[animation-duration:1.6s]"
                  />
                  <Icon
                    name="Square"
                    className="size-3.5 fill-current [&_*]:stroke-0"
                  />
                </>
              ) : dictation.phase === "finalizing" ? (
                <Icon name="Spinner" className="size-4 animate-spin" />
              ) : (
                <Icon name="Mic" className="size-4" />
              )}
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="default"
            size="icon"
            className={COMPOSER_SUBMIT_CLASS}
            disabled={!canSend}
            aria-label={`Send to ${providerLabel}`}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Icon name={COMPOSER_SEND_ICON} className="size-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
