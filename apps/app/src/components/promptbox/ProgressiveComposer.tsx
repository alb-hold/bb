import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  ExperimentalComposerInput,
  ExperimentalComposerRendererApi,
} from "@get-bb/plugin-sdk";
import { composerDraftFromPromptDraft } from "@bb/client-core";
import type { PromptTextMention } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  COMPOSER_SHELL_CLASS,
  ComposerSubmitButton,
  COMPOSER_SUBMIT_CLASS,
} from "@bb/shared-ui/composer-primitives";
import { ComposerAttachmentPreview } from "@bb/shared-ui/composer-attachment-preview";
import {
  COARSE_POINTER_TEXT_BASE_CLASS,
  COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@bb/shared-ui/icon";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { cn } from "@bb/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import type { ComposerBoxProps, PromptBoxHandle } from "./ComposerBox";
import { VoiceInputButton } from "./VoiceInputButton";
import { VoiceRecordingBar } from "./VoiceRecordingBar";
import { FailedVoiceRecordings } from "./FailedVoiceRecordings";
import { useComposerRendererApi } from "./ComposerBox";
import { ImageLightbox } from "@/lib/plugin-sdk-lazy-components";
import { resolveComposerEditorMinHeightCss } from "./composerHeightAtoms";
import { composerSubmission } from "./composer-submission";

type Handoff = NonNullable<
  ExperimentalComposerInput["experimental_startupHandoff"]
>;
type Accept = Parameters<Handoff["attach"]>[0];
const ACTION_LAYOUT =
  "aspect-square min-w-8 shrink-0 self-center max-md:pointer-coarse:min-w-10";
const PREPARING_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  visibility: "hidden",
  pointerEvents: "none",
};

function mentionsAfterEdit(
  previous: string,
  next: string,
  mentions: readonly PromptTextMention[],
): PromptTextMention[] {
  let from = 0;
  while (
    from < previous.length &&
    from < next.length &&
    previous[from] === next[from]
  )
    from++;
  let tail = 0;
  while (
    tail < previous.length - from &&
    tail < next.length - from &&
    previous[previous.length - tail - 1] === next[next.length - tail - 1]
  )
    tail++;
  const to = previous.length - tail;
  const delta = next.length - previous.length;
  return mentions.flatMap((mention) =>
    mention.end <= from
      ? [mention]
      : mention.start >= to
        ? [
            {
              ...mention,
              start: mention.start + delta,
              end: mention.end + delta,
            },
          ]
        : [],
  );
}

function assignHandle(
  ref: ComposerBoxProps["promptBoxRef"],
  handle: PromptBoxHandle | null,
) {
  if (typeof ref === "function") ref(handle);
  else if (ref) ref.current = handle;
}

export function ProgressiveComposer({
  props,
  children,
}: {
  props: ComposerBoxProps;
  children: (
    handoff: Handoff,
    rich: boolean,
    layout: (renderer: ReactNode) => ReactNode,
    controls: ReactNode,
  ) => ReactNode;
}) {
  const [rich, setRich] = useState(false);
  const [controlsNode] = useState(() => {
    const node = document.createElement("div");
    node.className = "contents";
    return node;
  });
  const controls = useMemo(
    () => <StartupControlsMount node={controlsNode} />,
    [controlsNode],
  );
  const previewOpen = useRef(false);
  const plainRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<Accept | null>(null);
  const composing = useRef(false);
  const pendingAttachments = useRef(0);
  const frame = useRef<number | null>(null);
  const current = useRef(props);
  current.current = props;
  const actions = useRef(composerSubmission(props.submission, props.onSubmit));
  actions.current = composerSubmission(props.submission, props.onSubmit);
  const draft = useRef({ text: props.value, mentions: props.mentionRanges });
  draft.current = { text: props.value, mentions: props.mentionRanges };
  const richRefState = useRef(false);
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const pendingPlus = useRef(false);
  const coarse = usePointerCoarse();
  const commit = useCallback((text: string) => {
    const mentions = mentionsAfterEdit(
      draft.current.text,
      text,
      draft.current.mentions,
    );
    draft.current = { text, mentions };
    current.current.onChange(text, mentions);
  }, []);
  const takeOver = useCallback(() => {
    frame.current = null;
    const input = inputRef.current;
    const accept = acceptRef.current;
    if (
      !input ||
      !accept ||
      composing.current ||
      pendingAttachments.current > 0 ||
      previewOpen.current ||
      richRefState.current
    )
      return;
    const focused = document.activeElement === input;
    if (
      !pendingPlus.current &&
      !focused &&
      plainRef.current?.contains(document.activeElement)
    )
      return;
    const text = input.value;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    const backward = input.selectionDirection === "backward";
    commit(text);
    const wrapper = richRef.current;
    if (wrapper) {
      wrapper.style.removeProperty("visibility");
    }
    accept({
      draft: composerDraftFromPromptDraft({
        ...draft.current,
        mentions: [...draft.current.mentions],
        attachments: [],
      }),
      anchor: backward ? selectionEnd : selectionStart,
      head: backward ? selectionStart : selectionEnd,
      focused,
      scrollTop: input.scrollTop,
    });
    richRefState.current = true;
    setRich(true);
    if (pendingPlus.current)
      requestAnimationFrame(() =>
        richRef.current
          ?.querySelector<HTMLButtonElement>(
            "[data-promptbox-plus-control] button",
          )
          ?.click(),
      );
  }, [commit]);
  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(takeOver);
  }, [takeOver]);
  const previewChanged = useCallback(
    (open: boolean) => {
      previewOpen.current = open;
      if (!open) schedule();
    },
    [schedule],
  );
  const handoff = useMemo<Handoff>(
    () => ({
      attach(accept) {
        acceptRef.current = accept;
        schedule();
        return () => {
          if (acceptRef.current === accept) acceptRef.current = null;
        };
      },
    }),
    [schedule],
  );
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || rich) return;
    input.style.height = "0px";
    input.style.height = `${input.scrollHeight}px`;
  }, [props.value, rich]);
  useEffect(() => {
    if (
      rich ||
      coarse ||
      props.autoFocus === false ||
      document.activeElement?.closest("[data-sidebar-rename-editor]")
    )
      return;
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [coarse, props.autoFocus, rich]);
  const submit = useCallback(
    (modifier = false, fromVoice = false) => {
      const input = inputRef.current;
      if (!input) return;
      const latest = current.current;
      if (latest.submission?.disabled) {
        latest.submission.experimental_onBlockedSubmit?.();
        return;
      }
      if (
        latest.submission?.isSubmitting ||
        attaching ||
        (!fromVoice &&
          (latest.voice?.state === "recording" ||
            latest.voice?.state === "transcribing"))
      )
        return;
      const action = modifier
        ? (actions.current.modifier ?? actions.current.enter)
        : actions.current.enter;
      if (
        action.requiresInput &&
        !input.value.trim() &&
        !latest.attachments?.items?.length
      )
        return;
      commit(input.value);
      action.run();
    },
    [attaching, commit],
  );
  useLayoutEffect(() => {
    if (rich) return;
    const handle: PromptBoxHandle = {
      focusEnd: () => {
        const input = inputRef.current;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      },
      voice: {
        textBeforeCursor: () =>
          inputRef.current?.value
            .slice(0, inputRef.current.selectionStart)
            .trim() || null,
        playCompletionTransition: async () => {},
        deliverTranscript: (text, delivery) => {
          const input = inputRef.current;
          if (!input) return;
          const normalized = text.replace(/\s+/g, " ").trim();
          if (!normalized) return;
          const before = input.value.slice(0, input.selectionStart);
          const after = input.value.slice(input.selectionEnd);
          const insertion = `${before && !/\s$/.test(before) ? " " : ""}${normalized}${after && !/^\s/.test(after) ? " " : ""}`;
          input.setRangeText(
            insertion,
            input.selectionStart,
            input.selectionEnd,
            "end",
          );
          commit(input.value);
          if (delivery === "send") submit(false, true);
        },
      },
    };
    assignHandle(props.promptBoxRef, handle);
    return () => assignHandle(props.promptBoxRef, null);
  }, [commit, props.promptBoxRef, rich, submit]);
  const attachFiles = async (files: File[]) => {
    const attachments = current.current.attachments;
    if (!attachments?.onAttachFiles || files.length === 0) return;
    pendingAttachments.current++;
    setAttaching(true);
    setAttachmentError(null);
    try {
      const added = await attachments.onAttachFiles(files);
      attachments.onUpdate?.((items) => [...items, ...added]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not attach files";
      setAttachmentError(message);
      appToast.error(message);
    } finally {
      pendingAttachments.current--;
      setAttaching(pendingAttachments.current > 0);
      schedule();
    }
  };
  const voiceActive =
    props.voice?.state === "recording" || props.voice?.state === "transcribing";
  const empty = !props.value.trim() && !props.attachments?.items?.length;
  const canSubmit =
    (!actions.current.enter.requiresInput || !empty) &&
    !props.submission?.disabled &&
    !props.submission?.isSubmitting &&
    !attaching &&
    !voiceActive;
  const primaryVoice = coarse && empty && props.voice?.isSupported;
  return children(
    handoff,
    rich,
    (renderer) => (
      <StartupComposerLayout>
        {(api) => (
          <>
            {props.executionControls &&
              createPortal(
                props.executionControls,
                controlsNode,
                "startup-controls",
              )}
            <div
              className="relative w-full"
              data-progressive-composer={rich ? "rich" : "plain"}
            >
              {!rich && (
                <form
                  ref={plainRef}
                  data-promptbox=""
                  data-progressive-composer-plain=""
                  data-promptbox-voice-active={voiceActive ? "" : undefined}
                  className={cn(
                    "group/promptbox relative w-full",
                    COMPOSER_SHELL_CLASS,
                  )}
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                  }}
                  onFocusCapture={schedule}
                  onBlurCapture={schedule}
                  onDragOver={(event) => {
                    if (props.attachments?.onAttachFiles)
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (
                      props.attachments?.onAttachFiles &&
                      event.dataTransfer.files.length
                    ) {
                      event.preventDefault();
                      void attachFiles([...event.dataTransfer.files]);
                    }
                  }}
                >
                  {props.handoff && (
                    <div
                      inert={voiceActive ? true : undefined}
                      className="px-3 pt-1.5"
                    >
                      {props.handoff}
                    </div>
                  )}
                  {props.voice && props.voice.failedRecordings.length > 0 && (
                    <FailedVoiceRecordings
                      recordings={props.voice.failedRecordings}
                      className="px-1.5 pt-1.5"
                      retryDisabled={false}
                      onRetry={props.voice.retry}
                      onDownload={props.voice.download}
                      onDiscard={props.voice.discard}
                    />
                  )}
                  <div data-promptbox-input-region="" className="relative">
                    <div
                      data-promptbox-editor-scroll=""
                      className={cn(
                        "w-full overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 outline-none leading-relaxed",
                        COARSE_POINTER_TEXT_BASE_CLASS,
                      )}
                      style={{
                        minHeight:
                          !props.value &&
                          api.input.internal_DO_NOT_USE_composerSizing
                            ?.editorHeight == null
                            ? 44
                            : resolveComposerEditorMinHeightCss({
                                floorPx: props.minHeight ?? 68,
                                userHeightPx:
                                  api.input.internal_DO_NOT_USE_composerSizing
                                    ?.editorHeight ?? null,
                                layout: "root-compose",
                              }),
                        maxHeight:
                          "min(calc(70dvh - 3rem), var(--composer-editor-available-height, 100dvh))",
                      }}
                    >
                      <textarea
                        ref={inputRef}
                        id={props.id}
                        value={props.value}
                        placeholder={
                          props.placeholder ??
                          "Ask anything. @ to mention files, folders, or sections"
                        }
                        aria-label={
                          props.placeholder ??
                          "Ask anything. @ to mention files, folders, or sections"
                        }
                        rows={1}
                        className="block w-full resize-none border-0 bg-transparent p-0 leading-[1.7] outline-none placeholder:font-light placeholder:text-subtle-foreground"
                        disabled={api.inputLocked}
                        onChange={(event) => commit(event.target.value)}
                        onCompositionStart={() => {
                          composing.current = true;
                        }}
                        onCompositionEnd={() => {
                          composing.current = false;
                          schedule();
                        }}
                        onPaste={(event) => {
                          if (
                            event.clipboardData.files.length &&
                            props.attachments?.onAttachFiles
                          ) {
                            event.preventDefault();
                            void attachFiles([...event.clipboardData.files]);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            props.onEscape?.();
                            return;
                          }
                          if (
                            event.key !== "Enter" ||
                            event.shiftKey ||
                            composing.current ||
                            event.nativeEvent.isComposing ||
                            event.keyCode === 229
                          )
                            return;
                          event.preventDefault();
                          submit(event.metaKey || event.ctrlKey);
                        }}
                      />
                    </div>
                  </div>
                  <StartupAttachments onPreviewChange={previewChanged} />
                  {(props.attachments?.error ?? attachmentError) && (
                    <div
                      role="alert"
                      className="mx-3 mb-1 mt-1 text-xs text-destructive"
                    >
                      {props.attachments?.error ?? attachmentError}
                    </div>
                  )}
                  <div
                    data-promptbox-action-row=""
                    data-promptbox-execution-layout={
                      props.executionControls ? "stacked" : undefined
                    }
                    className="relative flex shrink-0 select-none flex-row flex-wrap items-center gap-3 pb-2 pl-3.5 pr-[13px] pt-1.5"
                  >
                    {voiceActive && props.voice && (
                      <div className="absolute inset-0 z-10 min-w-0">
                        <VoiceRecordingBar
                          isCompact={false}
                          state={
                            props.voice.state === "recording"
                              ? "recording"
                              : "transcribing"
                          }
                          delivery={props.voice.delivery}
                          stream={props.voice.stream}
                          microphoneWarning={props.voice.microphoneWarning}
                          submitIcon="ArrowUp"
                          onConfirm={props.voice.stop}
                          onSend={props.voice.send}
                          onCancel={props.voice.cancel}
                        />
                      </div>
                    )}
                    <>
                      <div
                        data-promptbox-leading-actions=""
                        data-promptbox-standard-actions=""
                        inert={voiceActive ? true : undefined}
                        className={cn(
                          "flex min-w-9 flex-1 flex-row items-center gap-1",
                          voiceActive && "invisible pointer-events-none",
                        )}
                      >
                        <div
                          data-promptbox-plus-control=""
                          className="contents"
                        >
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label="Prompt actions"
                                  className={cn(
                                    COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                                    CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                                    "-ml-1.5",
                                  )}
                                  onMouseDown={(event) =>
                                    event.preventDefault()
                                  }
                                  onClick={() => {
                                    pendingPlus.current = true;
                                    schedule();
                                  }}
                                >
                                  <Icon name="Plus" className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Prompt actions</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        <div
                          data-promptbox-execution-controls=""
                          className="contents"
                        >
                          {controls}
                        </div>
                      </div>
                      <div
                        data-promptbox-trailing-actions=""
                        data-promptbox-standard-actions=""
                        inert={voiceActive ? true : undefined}
                        className={cn(
                          "flex min-w-0 max-w-full shrink-0 flex-row flex-wrap items-center justify-end gap-1",
                          voiceActive && "invisible pointer-events-none",
                        )}
                      >
                        {props.voice && !primaryVoice && (
                          <VoiceInputButton
                            type="button"
                            size="icon"
                            variant="ghost"
                            warning={props.voice.microphoneWarning}
                            aria-label="Start voice input"
                            disabled={
                              !props.voice.isSupported ||
                              props.submission?.isSubmitting
                            }
                            className={cn(
                              COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                              ACTION_LAYOUT,
                            )}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => void props.voice?.start()}
                          >
                            <Icon name="Mic" className="size-4" />
                          </VoiceInputButton>
                        )}
                        <div
                          data-promptbox-submit-group=""
                          className="flex shrink-0 flex-row items-center"
                        >
                          {primaryVoice ? (
                            <VoiceInputButton
                              data-promptbox-submit-action=""
                              type="button"
                              size="sm"
                              variant="default"
                              warning={props.voice?.microphoneWarning ?? null}
                              aria-label="Start voice input"
                              className={cn(
                                "ml-1",
                                COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                                "rounded-full transition-colors",
                                "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
                                ACTION_LAYOUT,
                                "max-md:pointer-coarse:size-11",
                              )}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void props.voice?.start()}
                            >
                              <Icon name="Mic" className="size-4" />
                            </VoiceInputButton>
                          ) : (
                            <ComposerSubmitButton
                              data-promptbox-submit-action=""
                              disabled={!canSubmit}
                              aria-label={
                                props.submission?.title ?? "Submit (Enter)"
                              }
                              aria-busy={
                                props.submission?.isSubmitting || attaching
                              }
                              onMouseDown={(event) => event.preventDefault()}
                              className={cn(
                                "ml-1",
                                COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                                "transition-colors",
                                ACTION_LAYOUT,
                                COMPOSER_SUBMIT_CLASS,
                                props.submission?.label !== undefined &&
                                  "size-auto h-8 gap-1.5 px-2.5",
                                props.submission?.label !== undefined
                                  ? "max-md:pointer-coarse:h-11 max-md:pointer-coarse:min-w-11 max-md:pointer-coarse:w-auto max-md:pointer-coarse:aspect-auto"
                                  : "max-md:pointer-coarse:size-11",
                              )}
                            >
                              {props.submission?.isSubmitting || attaching ? (
                                <Icon
                                  name="Loading"
                                  className="size-4 animate-spin motion-reduce:animate-none"
                                />
                              ) : (
                                <>
                                  <Icon
                                    name={props.submission?.icon ?? "ArrowUp"}
                                    className="size-4"
                                  />
                                  {props.submission?.label !== undefined && (
                                    <span data-promptbox-submit-label="">
                                      {props.submission.label}
                                    </span>
                                  )}
                                </>
                              )}
                            </ComposerSubmitButton>
                          )}
                        </div>
                      </div>
                    </>
                  </div>
                </form>
              )}
              <div ref={richRef} style={rich ? undefined : PREPARING_STYLE}>
                {renderer}
              </div>
            </div>
          </>
        )}
      </StartupComposerLayout>
    ),
    controls,
  );
}

function StartupAttachments({
  onPreviewChange,
}: {
  onPreviewChange: (open: boolean) => void;
}) {
  const renderer = useComposerRendererApi();
  const attachments = renderer.input.attachments;
  const [expanded, setExpanded] = useState<number | null>(null);
  useLayoutEffect(() => {
    onPreviewChange(expanded !== null);
  }, [expanded, onPreviewChange]);
  const images = (attachments?.items ?? []).filter(
    (item) =>
      item.type === "localImage" ||
      item.mimeType?.startsWith("image/") ||
      item.mimeType?.startsWith("video/") ||
      /\.(mp4|m4v|mov|webm|ogv|ogg)(?:[?#].*)?$/i.test(item.path),
  );
  const image = expanded === null ? undefined : images[expanded];
  return (
    <>
      <ComposerAttachmentPreview
        attachments={attachments?.items ?? []}
        pendingUploads={attachments?.pendingUploads}
        attachmentProjectId={attachments?.projectId}
        attachmentSrc={renderer.attachmentSrc}
        resolveMentionLink={renderer.input.resolveMentionLink}
        onOpenImage={setExpanded}
        onRemoveAttachment={
          attachments?.onUpdate
            ? (path) =>
                attachments.onUpdate?.((items) =>
                  items.filter((item) => item.path !== path),
                )
            : undefined
        }
      />
      <ImageLightbox
        imageSrc={
          image
            ? renderer.attachmentSrc(
                image.path,
                image.sourceProjectId ?? attachments?.projectId,
              )
            : null
        }
        imageAlt={image?.name ?? "Attached image"}
        title="Attached media preview"
        mediaType={
          image &&
          (image.mimeType?.startsWith("video/") ||
            /\.(mp4|m4v|mov|webm|ogv|ogg)(?:[?#].*)?$/i.test(image.path))
            ? "video"
            : "image"
        }
        hasMultipleImages={images.length > 1}
        onPrevious={() =>
          setExpanded((index) =>
            index === null ? null : (index - 1 + images.length) % images.length,
          )
        }
        onNext={() =>
          setExpanded((index) =>
            index === null ? null : (index + 1) % images.length,
          )
        }
        onClose={() => setExpanded(null)}
      />
    </>
  );
}

function StartupControlsMount({ node }: { node: HTMLDivElement }) {
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (target.current && node.parentNode !== target.current)
      target.current.append(node);
  }, [node]);
  return <div ref={target} className="contents" />;
}

function StartupComposerLayout({
  children,
}: {
  children: (api: ExperimentalComposerRendererApi) => ReactNode;
}) {
  return children(useComposerRendererApi());
}
