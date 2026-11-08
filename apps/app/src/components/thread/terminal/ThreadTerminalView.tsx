import {
  markTerminalPerformance,
  measureTerminalPerformance,
} from "@/lib/terminal-performance";
import { rememberTerminalGrid } from "./terminal-grid-cache";
import { createTerminalFitWork } from "./terminal-fit-work";
import { createTerminalHiddenOutput } from "./terminal-hidden-output";
import {
  readTerminalFontFamily,
  readTerminalFontMetrics,
  TERMINAL_LINE_HEIGHT,
} from "./terminal-font";
export {
  resolveTerminalFontFamily,
  TERMINAL_FONT_FAMILY,
} from "./terminal-font";
import {
  createPrefetchedTerminalSocket,
  reconcilePrefetchedTerminalGrid,
  prefetchTerminalSocket,
  discardPrefetchedTerminalSocket,
} from "./terminal-socket-prefetch";
import { mountTerminalScreenLoadingPreview } from "./terminal-screen-loading-preview";
import { trackTerminalScrollability } from "./terminal-scrollbar";
import { fetchTerminalScreen } from "./terminal-screen-prefetch";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { flushSync } from "react-dom";
import "@xterm/xterm/css/xterm.css";
import type { IMarker, ITheme, Terminal as XTermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  getMediaQuerySnapshot,
  useMediaQuery,
} from "@bb/shared-ui/hooks/use-media-query";
import { appToast } from "@/components/ui/app-toast";
import { randomUuid } from "@/lib/random-uuid";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { useAppThemeEpoch } from "@/hooks/useAppTheme";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { terminalReplayWrites } from "./terminal-replay-writes";
import { flushTerminalReplay } from "./terminal-replay-flush";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  anchorPointFromMouseEvent,
  selectionAnchorFromPointerRelease,
  type MessageProseSelection,
  type SelectionAnchor,
  type SelectionAnchorPoint,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import { buildTerminalWebSocketUrl } from "./terminal-websocket-url";
import {
  importTerminalModules,
  importTerminalSearchAddon,
  importTerminalWebLinksAddon,
  importTerminalWebglAddon,
} from "./terminal-modules";
import { TerminalWebSocketTransport } from "@bb/client-core";
import {
  useAppCommandHandler,
  useAppCommandRunner,
} from "@/components/commands/AppCommandProvider";
import {
  createTerminalFileLinkProvider,
  parseTerminalReportedCwd,
} from "./terminal-file-links";
import {
  hasRunningLayoutAnimation,
  observeLayoutSignals,
  watchTerminalLayoutSettled,
} from "./terminal-layout-settle";
import {
  cancelTerminalOutputNextRenders,
  recordTerminalInputAccepted,
  recordTerminalInputWebSocketSent,
  recordTerminalOutputNextRender,
  recordTerminalOutputParsed,
  recordTerminalOutputReceived,
} from "./terminal-latency-diagnostics.js";
import { TerminalLinkOpenDialog } from "./TerminalLinkOpenDialog";
import { TerminalAttentionPane } from "./TerminalAttentionPane";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalCommandGutter } from "./TerminalCommandGutter";
import { TerminalSearch } from "./TerminalSearch";
import type { TerminalSearchAddonInstance } from "./terminal-search-addon";
import { loadOptionalTerminalSearchAddon } from "./terminal-search-addon";
import { TerminalTextSelectSheet } from "./TerminalTextSelectSheet";
import {
  terminalTextSnapshot,
  terminalTextSnapshotLineIndex,
} from "./terminal-text-snapshot";
import {
  createTerminalPinchGesture,
  startTerminalLongPress,
  type TerminalGestureTouch,
} from "./terminal-mobile-gestures";
import {
  createTerminalOutputLineAnchorTracker,
  createTerminalViewportReplaySaveGate,
  createTerminalViewportPersistence,
  startTerminalOutputReplay,
  createTerminalTouchViewportSaveScheduler,
  findTerminalOutputLineAnchor,
  readTerminalViewportAnchor,
  registerTerminalOutputBoundaryHandler,
  resolveTerminalViewportRestore,
  terminalViewportStorageKey,
  terminalViewportStorageForClient,
} from "./terminal-viewport";
import type { TerminalOutputLineAnchor } from "./terminal-viewport";
import {
  createTerminalOutputBoundaries,
  type TerminalOutputBoundaries,
} from "./terminal-output-boundaries";
import {
  createTerminalClipboardKeyHandler,
  pasteTerminalClipboard,
} from "./terminal-clipboard";
import {
  applyTerminalControl,
  encodeTerminalArrow,
  suppressDuplicateTerminalCompositionInput,
} from "./terminal-mobile-input";
import {
  createTerminalOsc8LinkHandler,
  isTerminalLinkActivation,
  requestTerminalLinkOpen,
  type TerminalLinkTarget,
} from "./terminal-links";
import {
  nextSharedTerminalSize,
  type TerminalGridSize,
} from "./terminal-shared-size";
import { listenForTerminalSizeClaims } from "./terminal-size-claims";
import { handleTerminalFileDrop } from "./terminal-file-drop";
import {
  registerTerminalOsc52Handler,
  terminalPromptLine,
} from "./terminal-shell-state";
import {
  osc52CopiedNotice,
  shouldAutoCopyOsc52,
} from "./terminal-osc52-policy";
import { parseTerminalProgressOsc } from "./terminal-progress";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  completeTerminalReplayPreview,
  createTerminalExitNoticeHandler,
  createTerminalReplayPreviewExitHandler,
  mountTerminalReplayPreview,
  resetTerminalExitNoticeForSession,
  routeTerminalExitNotice,
  updateTerminalReplayPreviewPtyGrid,
  TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS,
} from "./terminal-replay-preview";
import {
  applyTerminalSurfaceScale,
  attachTerminalScalePointerCoordinates,
  canRevealTerminalSurface,
  readTerminalSurfaceScale,
  terminalSurfacePresentation,
} from "./terminal-grid-presentation";
import {
  attachTerminalPromptTracker,
  type TerminalPromptTrackerState,
} from "./terminal-prompt-tracker";
import { dropMouseReportsWithoutPosition } from "./terminal-mouse-reports";
import { sendTerminalTapClick } from "./terminal-tap-click";
import { attachTerminalWheelLines } from "./terminal-wheel";
import { attachTerminalInteractions } from "./terminal-interactions";
import {
  disposeTerminalWithRenderer,
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
  observeTerminalWebglVisibility,
} from "./terminal-webgl-renderer";
export {
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
} from "./terminal-webgl-renderer";

const CLIPBOARD_BLOCKED_MESSAGE =
  "This connection can’t read the clipboard. Long-press a message box and choose Paste.";
const TERMINAL_UNICODE_VERSION = "11";
export const TERMINAL_ALLOW_PROPOSED_API = true;
const TERMINAL_TOUCH_FOCUS_MAX_DURATION_MS = 700;
const TERMINAL_TOUCH_FOCUS_MOVEMENT_THRESHOLD_PX = 10;

type TerminalFitScheduler = () => void;

interface ShouldFocusTerminalAfterAsyncMountArgs {
  currentFocusIsAvailable: boolean;
  hasExplicitFocusRequest: boolean;
  focusMovedDuringMount: boolean;
  isPanelOpen: boolean;
}

export function shouldFocusTerminalAfterAsyncMount({
  currentFocusIsAvailable,
  hasExplicitFocusRequest,
  focusMovedDuringMount,
  isPanelOpen,
}: ShouldFocusTerminalAfterAsyncMountArgs): boolean {
  if (!isPanelOpen) {
    return false;
  }
  if (focusMovedDuringMount && currentFocusIsAvailable) {
    return false;
  }
  return hasExplicitFocusRequest || !currentFocusIsAvailable;
}

interface TerminalTouchPoint extends SelectionAnchorPoint {
  identifier: number;
}

interface TerminalTouchFocusGesture {
  identifier: number;
  maximumMovementPx: number;
  startedAt: number;
  startPoint: SelectionAnchorPoint;
}

interface FocusTerminalFromTouchReleaseArgs {
  changedTouches: readonly TerminalTouchPoint[];
  focus: () => void;
  gesture: TerminalTouchFocusGesture | null;
  releasedAt: number;
  remainingTouchCount: number;
}

function terminalTouchMovement(
  startPoint: SelectionAnchorPoint,
  currentPoint: SelectionAnchorPoint,
): number {
  return Math.hypot(
    currentPoint.x - startPoint.x,
    currentPoint.y - startPoint.y,
  );
}

export function startTerminalTouchFocusGesture(
  touches: readonly TerminalTouchPoint[],
  startedAt: number,
): TerminalTouchFocusGesture | null {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (touch === undefined) {
    return null;
  }
  return {
    identifier: touch.identifier,
    maximumMovementPx: 0,
    startedAt,
    startPoint: { x: touch.x, y: touch.y },
  };
}

export function updateTerminalTouchFocusGesture(
  gesture: TerminalTouchFocusGesture | null,
  touches: readonly TerminalTouchPoint[],
): TerminalTouchFocusGesture | null {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (
    gesture === null ||
    touch === undefined ||
    touch.identifier !== gesture.identifier
  ) {
    return null;
  }
  return {
    ...gesture,
    maximumMovementPx: Math.max(
      gesture.maximumMovementPx,
      terminalTouchMovement(gesture.startPoint, touch),
    ),
  };
}

export function focusTerminalFromTouchRelease({
  changedTouches,
  focus,
  gesture,
  releasedAt,
  remainingTouchCount,
}: FocusTerminalFromTouchReleaseArgs): boolean {
  if (remainingTouchCount !== 0) {
    return false;
  }
  const completedGesture = updateTerminalTouchFocusGesture(
    gesture,
    changedTouches,
  );
  if (completedGesture === null) {
    return false;
  }
  const duration = releasedAt - completedGesture.startedAt;
  if (
    duration < 0 ||
    duration >= TERMINAL_TOUCH_FOCUS_MAX_DURATION_MS ||
    completedGesture.maximumMovementPx >
      TERMINAL_TOUCH_FOCUS_MOVEMENT_THRESHOLD_PX
  ) {
    return false;
  }
  focus();
  return true;
}

export function attachTerminalManualScrollIntentListeners(
  element: HTMLElement,
  onManualScrollIntent: (event: Event) => void,
) {
  const markManualScrollIntent = (event: Event) => onManualScrollIntent(event);
  const markManualScrollKeydownIntent = (event: KeyboardEvent) => {
    if (["PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      onManualScrollIntent(event);
    }
  };
  const options = { capture: true, passive: true } as const;
  element.addEventListener("wheel", markManualScrollIntent, options);
  element.addEventListener("touchmove", markManualScrollIntent, options);
  element.addEventListener("pointerdown", markManualScrollIntent, options);
  element.addEventListener("keydown", markManualScrollKeydownIntent, options);
  return () => {
    element.removeEventListener("wheel", markManualScrollIntent, true);
    element.removeEventListener("touchmove", markManualScrollIntent, true);
    element.removeEventListener("pointerdown", markManualScrollIntent, true);
    element.removeEventListener("keydown", markManualScrollKeydownIntent, true);
  };
}

type TerminalTouchListLike = ArrayLike<
  Pick<Touch, "clientX" | "clientY" | "identifier">
>;

interface TerminalTouchEventLike {
  changedTouches: TerminalTouchListLike;
  timeStamp: number;
  touches: TerminalTouchListLike;
}

function terminalTouchPoints(
  touches: TerminalTouchListLike,
): TerminalTouchPoint[] {
  return Array.from(touches, (touch) => ({
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

export function createTerminalTouchHandlers(terminalRef: {
  readonly current: Pick<XTermTerminal, "element" | "focus" | "modes"> | null;
}) {
  let gesture: TerminalTouchFocusGesture | null = null;
  return {
    cancel(): void {
      gesture = null;
    },
    end(event: TerminalTouchEventLike): void {
      const completed = gesture;
      gesture = null;
      const changedTouches = terminalTouchPoints(event.changedTouches);
      const tapped = focusTerminalFromTouchRelease({
        changedTouches,
        focus: () => terminalRef.current?.focus(),
        gesture: completed,
        releasedAt: event.timeStamp,
        remainingTouchCount: event.touches.length,
      });
      const terminal = terminalRef.current;
      const tap = changedTouches[0];
      if (tapped && terminal !== null && tap !== undefined) {
        sendTerminalTapClick(terminal, tap);
      }
    },
    move(event: TerminalTouchEventLike): void {
      gesture = updateTerminalTouchFocusGesture(
        gesture,
        terminalTouchPoints(event.touches),
      );
    },
    start(event: TerminalTouchEventLike): void {
      gesture = startTerminalTouchFocusGesture(
        terminalTouchPoints(event.touches),
        event.timeStamp,
      );
    },
  };
}

interface HasVisibleTerminalSizeArgs {
  containerElement: HTMLElement;
  entries?: readonly ResizeObserverEntry[];
}

function readResolvedCssColor(
  probe: HTMLElement,
  varName: string,
): string | undefined {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  if (!raw) {
    return undefined;
  }
  probe.style.color = raw;
  return getComputedStyle(probe).color;
}

type TerminalCssVariableReader = (name: string) => string | undefined;

export const TERMINAL_THEME_OPTIONS = { minimumContrastRatio: 7 };

export const TERMINAL_CELL_OPTIONS = {
  lineHeight: TERMINAL_LINE_HEIGHT,
  cursorBlink: false,
  cursorStyle: "block" as const,
  cursorInactiveStyle: "none" as const,
};

export function buildTerminalThemeFromCssColors(
  get: TerminalCssVariableReader,
): ITheme {
  return {
    background: get("--sidebar"),
    foreground: get("--ink"),
    cursor: get("--ink"),
    cursorAccent: get("--sidebar"),
    scrollbarSliderBackground: get("--terminal-scrollbar"),
    scrollbarSliderHoverBackground: get("--terminal-scrollbar-hover"),
    scrollbarSliderActiveBackground: get("--terminal-scrollbar-hover"),
    selectionBackground: get("--muted"),
    selectionInactiveBackground: get("--muted"),
    black: get("--terminal-ansi-0"),
    red: get("--terminal-ansi-1"),
    green: get("--terminal-ansi-2"),
    yellow: get("--terminal-ansi-3"),
    blue: get("--terminal-ansi-4"),
    magenta: get("--terminal-ansi-5"),
    cyan: get("--terminal-ansi-6"),
    white: get("--terminal-ansi-7"),
    brightBlack: get("--terminal-ansi-8"),
    brightRed: get("--terminal-ansi-9"),
    brightGreen: get("--terminal-ansi-10"),
    brightYellow: get("--terminal-ansi-11"),
    brightBlue: get("--terminal-ansi-12"),
    brightMagenta: get("--terminal-ansi-13"),
    brightCyan: get("--terminal-ansi-14"),
    brightWhite: get("--terminal-ansi-15"),
  };
}

export function terminalThemeDefaultColors(
  theme: ITheme,
): import("@bb/domain").TerminalDefaultColors | null {
  if (!theme.foreground || !theme.background) return null;
  const context = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const rgb = (color: string): import("@bb/domain").TerminalRgb => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  };
  return {
    foreground: rgb(theme.foreground),
    background: rgb(theme.background),
  };
}

function buildTerminalTheme(): ITheme {
  if (typeof document === "undefined") {
    return {};
  }
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const get = (name: string) => readResolvedCssColor(probe, name);
  const theme = buildTerminalThemeFromCssColors(get);
  probe.remove();
  return theme;
}

export function applyTerminalFontFamily(
  terminal: Pick<XTermTerminal, "options">,
  fontFamily: string,
  scheduleFit: TerminalFitScheduler,
): boolean {
  if (terminal.options.fontFamily === fontFamily) {
    return false;
  }
  terminal.options.fontFamily = fontFamily;
  scheduleFit();
  return true;
}

export function forceTerminalFontMeasurement(
  terminal: Pick<
    XTermTerminal,
    "options" | "clearTextureAtlas" | "refresh" | "rows"
  >,
): void {
  const fontFamily = terminal.options.fontFamily;
  terminal.options.fontFamily = `${fontFamily} `;
  terminal.options.fontFamily = fontFamily;
  terminal.clearTextureAtlas();
  terminal.refresh(0, terminal.rows - 1);
}

export function observeTerminalFontLoading(
  fontSet: Pick<
    FontFaceSet,
    "ready" | "addEventListener" | "removeEventListener"
  >,
  onFontsLoaded: () => void,
): () => void {
  let disposed = false;
  const refresh = () => {
    if (!disposed) {
      onFontsLoaded();
    }
  };
  fontSet.addEventListener("loadingdone", refresh);
  void fontSet.ready.then(refresh);
  return () => {
    disposed = true;
    fontSet.removeEventListener("loadingdone", refresh);
  };
}

export interface ThreadTerminalViewProps {
  parked?: boolean;
  onRetentionInvalidated?: () => void;
  retainNativeOutput?: boolean;
  attentionShownAsBanner?: boolean;
  autoFocus: boolean;
  isPanelOpen: boolean;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onSelectionAddToChat?: (text: string) => void;
  onSessionChange?: (session: TerminalSession) => void;
  onTitleChange?: TerminalTitleChangeHandler;
  onProgressChange?: (
    progress: number | null,
    outputSeq?: number,
    terminalId?: string,
  ) => void;
  onCwdChange?: (cwd: string) => void;
  onUserInput?: () => void;
  session: TerminalSession;
}

type TerminalTitleChangeHandler = (title: string) => void;

type TerminalConnectionNotice = "reconnecting" | "reconnected";
type TerminalReplayNotice = "reconnecting" | "unavailable";

const TERMINAL_RECONNECTING_NOTICE_DELAY_MS = 1_000;
const TERMINAL_RECONNECTED_NOTICE_DURATION_MS = 1_500;
const TERMINAL_RENDERER_SETTLE_MS = 150;
const EMPTY_TERMINAL_PROMPT_TRACKER: TerminalPromptTrackerState = {
  commandMarks: [],
  lineHeight: 16,
  promptLines: [],
  viewportLine: 0,
};

interface WriteTerminalStatusArgs {
  terminal: XTermTerminal;
  text: string;
}

interface WriteTerminalSessionStatusNoticeArgs {
  lastNotice: TerminalSessionStatusNoticeRef;
  session: TerminalSession;
  terminal: XTermTerminal;
}

interface TerminalOutputWriteArgs {
  data: string | Uint8Array;
  frameId?: number;
  replayData?: Uint8Array;
  isReplay: boolean;
  terminalId?: string;
  outputSequence?: number;
  replayCheckpointSequence?: number | null;
  outputBoundaries?: TerminalOutputBoundaries;
  onOutputParsed?: () => void;
  onParsed: () => void;
  replayWriteState: TerminalReplayWriteState;
  terminal: XTermTerminal;
  pipeline?: ReturnType<typeof createTerminalOutputPipeline>;
  replayPipeline?: Pick<
    ReturnType<typeof createTerminalOutputPipeline>,
    "push"
  >;
}

interface ForwardTerminalDataArgs {
  data: string;
  inputEventAt?: number;
  isUserInput: boolean;
  onInput: (
    dataBase64: string,
    inputEventAt?: number,
    isUserInput?: boolean,
  ) => void;
  onUserInput?: () => void;
  replayWriteState: TerminalReplayWriteState;
  sessionStatus: TerminalSession["status"];
}

interface OpenTerminalWebLinkArgs {
  onOpenLink: MarkdownPreviewLinkHandler;
  uri: string;
}

interface TerminalContextMenuState {
  link: TerminalLinkTarget | null;
  selectionText: string;
}

interface CaptureTerminalContextMenuStateArgs {
  link: TerminalLinkTarget | null;
  terminal: Pick<XTermTerminal, "getSelection"> | null;
}

interface TerminalReplayWriteState {
  suppressedWriteCount: number;
}

type TerminalSessionStatusNotice = "exited";
type TerminalSessionStatusNoticeRef = {
  current: TerminalSessionStatusNotice | null;
};

interface HandleTerminalServerMessageArgs {
  acknowledgeOutput: (nextSeq: number) => void;
  message: TerminalServerMessage;
  replayWrite?: { bytes: Uint8Array; sourceBytes: Uint8Array };
  terminalId?: string;
  onOutputFrameParsed?: () => void;
  onOutputParsed?: (sequence: number) => void;
  onOutputStart?: (sequence: number) => void;
  onReplayComplete: () => void;
  onSessionChange?: (session: TerminalSession) => void;
  replayNextSeq: number | null;
  replayWriteState: TerminalReplayWriteState;
  outputFrameId?: number;
  outputBoundaries?: TerminalOutputBoundaries;
  setReplayNextSeq: (nextSeq: number | null) => void;
  setReplayStartSequence?: (sequence: number) => void;
  terminal: XTermTerminal;
  pipeline?: ReturnType<typeof createTerminalOutputPipeline>;
  replayPipeline?: Pick<
    ReturnType<typeof createTerminalOutputPipeline>,
    "push"
  >;
  replayCheckpointSequence?: number | null;
  allowAttachedGrid?: boolean;
  onReplayStart?: (session: TerminalSession) => void;
  shouldProcessOutput?: () => boolean;
  writeExitNotice?: (text: string) => boolean;
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function encodeTerminalInputChunks(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += TERMINAL_DATA_MAX_BYTES
  ) {
    chunks.push(
      encodeBytesBase64(
        bytes.subarray(
          offset,
          Math.min(offset + TERMINAL_DATA_MAX_BYTES, bytes.byteLength),
        ),
      ),
    );
  }
  return chunks;
}

export function forwardTerminalData({
  data,
  inputEventAt,
  isUserInput,
  onInput,
  onUserInput,
  replayWriteState,
  sessionStatus,
}: ForwardTerminalDataArgs): void {
  if (
    sessionStatus !== "running" ||
    (replayWriteState.suppressedWriteCount > 0 && !isUserInput)
  ) {
    return;
  }
  const input = dropMouseReportsWithoutPosition(data);
  if (input.length === 0) {
    return;
  }

  for (const dataBase64 of encodeTerminalInputChunks(input)) {
    onInput(dataBase64, inputEventAt, isUserInput);
  }
  if (isUserInput) onUserInput?.();
}

export function subscribeToTerminalUserInput(
  terminal: XTermTerminal,
  listener: () => void,
): { dispose: () => void } | null {
  const core: unknown = Reflect.get(terminal, "_core");
  if (typeof core !== "object" || core === null) return null;
  const coreService: unknown = Reflect.get(core, "coreService");
  if (typeof coreService !== "object" || coreService === null) return null;
  const onUserInput: unknown = Reflect.get(coreService, "onUserInput");
  if (typeof onUserInput !== "function") return null;
  const disposable: unknown = onUserInput.call(coreService, listener);
  if (typeof disposable !== "object" || disposable === null) return null;
  const dispose: unknown = Reflect.get(disposable, "dispose");
  if (typeof dispose !== "function") return null;
  return { dispose: () => dispose.call(disposable) };
}

export function attachTerminalInputForwarding({
  onData,
  terminal,
}: {
  onData: (data: string, isUserInput: boolean) => void;
  terminal: XTermTerminal;
}): { dispose: () => void } {
  let userInputPending = false;
  const userInputSubscription = subscribeToTerminalUserInput(terminal, () => {
    userInputPending = true;
  });
  const dataSubscription = terminal.onData((data) => {
    const isUserInput = userInputPending;
    userInputPending = false;
    onData(data, isUserInput);
  });
  return {
    dispose: () => {
      userInputSubscription?.dispose();
      dataSubscription.dispose();
    },
  };
}

function hasVisibleTerminalSize({
  containerElement,
  entries,
}: HasVisibleTerminalSizeArgs): boolean {
  const entry = entries?.[0];
  const width = entry?.contentRect.width ?? containerElement.clientWidth;
  const height = entry?.contentRect.height ?? containerElement.clientHeight;
  return width > 0 && height > 0;
}

function buildTerminalSelection({
  anchor,
  containerElement,
  text,
}: {
  anchor: SelectionAnchor | null;
  containerElement: HTMLElement;
  text: string;
}): MessageProseSelection | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const selection: MessageProseSelection = {
    text: trimmedText,
    rect:
      anchor === null
        ? containerElement.getBoundingClientRect()
        : new DOMRect(anchor.point.x, anchor.point.y, 0, 0),
  };
  if (anchor !== null) {
    selection.anchorPoint = anchor.point;
    selection.anchorSide = anchor.side;
  }
  return selection;
}

function writeTerminalStatus({
  terminal,
  text,
}: WriteTerminalStatusArgs): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
}

function writeTerminalSessionStatusNotice({
  lastNotice,
  session,
  terminal,
}: WriteTerminalSessionStatusNoticeArgs): void {
  switch (session.status) {
    case "exited":
      if (lastNotice.current === "exited") {
        return;
      }
      lastNotice.current = "exited";
      writeTerminalStatus({
        terminal,
        text:
          session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${session.exitCode}`,
      });
      return;
    case "starting":
    case "running":
    case "disconnected":
      lastNotice.current = null;
      return;
  }
}

export async function writeRetainedTerminalOutput({
  retainNativeOutput = false,
  chunks,
  lastNotice,
  session,
  terminal,
  pipeline,
  onOutputStart,
  onOutputParsed,
}: {
  retainNativeOutput?: boolean;
  chunks: readonly { seq: number; data: Uint8Array }[];
  lastNotice: TerminalSessionStatusNoticeRef;
  session: TerminalSession;
  terminal: XTermTerminal;
  pipeline?: ReturnType<typeof createTerminalOutputPipeline>;
  onOutputStart?: (sequence: number) => void;
  onOutputParsed?: (sequence: number) => void;
}): Promise<void> {
  const readBuffer = () => {
    const buffer = terminal.buffer.active;
    const lines = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    );
    while (lines.at(-1) === "") lines.pop();
    return lines.join("\r\n");
  };
  let alternateFrame: string | null = null;
  const alternateExit = retainNativeOutput
    ? terminal.parser.registerCsiHandler(
        { prefix: "?", final: "l" },
        (params) => {
          if (
            terminal.buffer.active.type === "alternate" &&
            params.some((mode) => mode === 47 || mode === 1047 || mode === 1049)
          )
            alternateFrame = readBuffer();
          return false;
        },
      )
    : null;
  await new Promise<void>((resolve) => {
    const writeChunk = (index: number) => {
      const chunk = chunks[index];
      if (!chunk) {
        resolve();
        return;
      }
      onOutputStart?.(chunk.seq);
      const onParsed = () => {
        onOutputParsed?.(chunk.seq);
        writeChunk(index + 1);
      };
      if (pipeline) pipeline.push(chunk.data, onParsed);
      else terminal.write(chunk.data, onParsed);
    };
    writeChunk(0);
  });
  alternateExit?.dispose();
  if (alternateFrame !== null) {
    const primaryFrame = readBuffer();
    terminal.reset();
    await new Promise<void>((resolve) =>
      terminal.write(`${alternateFrame}\r\n${primaryFrame}\r\n`, resolve),
    );
  }
  writeTerminalSessionStatusNotice({ lastNotice, session, terminal });
  await new Promise<void>((resolve) => terminal.write("", resolve));
}

export function applyTerminalGridBeforeViewportRestore({
  pipeline,
  cols,
  rows,
  onGridApplied,
  restoreViewport,
  afterRestore,
}: {
  pipeline: ReturnType<typeof createTerminalOutputPipeline> | null | undefined;
  cols: number;
  rows: number;
  onGridApplied: () => void;
  restoreViewport: () => void;
  afterRestore: () => void;
}): void {
  const finish = () => {
    onGridApplied();
    restoreViewport();
    afterRestore();
  };
  if (!pipeline) {
    finish();
    return;
  }
  pipeline.setGrid(cols, rows, finish);
}

export function applyTerminalGridAndKeepViewport({
  pipeline,
  cols,
  rows,
  onGridApplied,
  restoreViewport,
}: {
  pipeline: ReturnType<typeof createTerminalOutputPipeline>;
  cols: number;
  rows: number;
  onGridApplied: () => void;
  restoreViewport: () => void;
}): void {
  pipeline.setGrid(cols, rows, () => {
    onGridApplied();
    restoreViewport();
  });
}

export function restoreTerminalViewportOnResize({
  terminal,
  canRestore,
  restoreViewport,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: {
  terminal: Pick<XTermTerminal, "onResize">;
  canRestore: () => boolean;
  restoreViewport: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frame: number) => void;
}): { dispose: () => void } {
  let frame: number | null = null;
  const subscription = terminal.onResize(() => {
    if (frame !== null) cancelFrame(frame);
    frame = requestFrame(() => {
      frame = null;
      if (canRestore()) restoreViewport();
    });
  });
  return {
    dispose: () => {
      subscription.dispose();
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}

export function createTerminalViewportLineAnchor(
  terminal: Pick<XTermTerminal, "buffer" | "registerMarker">,
): {
  clear: () => void;
  dispose: () => void;
  getLine: () => number | null;
  setLine: (line: number) => void;
} {
  let marker: IMarker | null = null;
  const clear = () => {
    if (marker !== null && !marker.isDisposed) marker.dispose();
    marker = null;
  };
  return {
    clear,
    dispose: clear,
    getLine: () =>
      marker === null || marker.isDisposed || marker.line < 0
        ? null
        : marker.line,
    setLine: (line) => {
      clear();
      const buffer = terminal.buffer.active;
      marker = terminal.registerMarker(line - (buffer.baseY + buffer.cursorY));
    },
  };
}

export function restoreTerminalViewportToRetainedLine({
  terminal,
  lineAnchor,
}: {
  terminal: Pick<XTermTerminal, "scrollToLine">;
  lineAnchor: Pick<
    ReturnType<typeof createTerminalViewportLineAnchor>,
    "getLine"
  >;
}): boolean {
  const line = lineAnchor.getLine();
  if (line === null) return false;
  terminal.scrollToLine(line);
  return true;
}

function openTerminalWebLink({
  onOpenLink,
  uri,
}: OpenTerminalWebLinkArgs): void {
  if (onOpenLink({ href: uri })) {
    return;
  }
  openUrlInExternalBrowser(uri);
}

export function captureTerminalContextMenuState({
  link,
  terminal,
}: CaptureTerminalContextMenuStateArgs): TerminalContextMenuState {
  return {
    link,
    selectionText: terminal?.getSelection() ?? "",
  };
}

export function writeTerminalOutput({
  data,
  frameId,
  replayData,
  isReplay,
  terminalId = "",
  outputSequence,
  outputBoundaries,
  onOutputParsed,
  onParsed,
  replayWriteState,
  terminal,
  pipeline,
  replayPipeline,
  replayCheckpointSequence,
}: TerminalOutputWriteArgs): void {
  const sourceBytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bytes = sourceBytes;
  if (outputSequence !== undefined && outputBoundaries !== undefined) {
    bytes = outputBoundaries.insert(sourceBytes, outputSequence);
  }
  const write = (callback: () => void, applyMarkerGrids: boolean) => {
    if (pipeline) pipeline.push(bytes, callback, applyMarkerGrids, isReplay);
    else terminal.write(bytes, callback);
  };
  if (!isReplay) {
    write(() => {
      recordTerminalOutputParsed(terminalId, frameId, performance.now());
      onOutputParsed?.();
      if (
        replayCheckpointSequence !== null &&
        replayCheckpointSequence !== undefined &&
        outputSequence !== undefined &&
        outputSequence >= replayCheckpointSequence &&
        replayPipeline
      ) {
        replayPipeline.push(replayData ?? sourceBytes, onParsed);
      } else {
        onParsed();
      }
    }, true);
    return;
  }

  replayWriteState.suppressedWriteCount += 1;
  const preview =
    replayPipeline &&
    !(
      replayCheckpointSequence !== null &&
      replayCheckpointSequence !== undefined &&
      outputSequence !== undefined &&
      outputSequence < replayCheckpointSequence
    )
      ? replayPipeline
      : undefined;
  let primaryDone = false;
  let previewDone = preview === undefined;
  const complete = () => {
    if (!primaryDone || !previewDone) return;
    replayWriteState.suppressedWriteCount -= 1;
    onParsed();
  };
  write(() => {
    primaryDone = true;
    recordTerminalOutputParsed(terminalId, frameId, performance.now());
    onOutputParsed?.();
    complete();
  }, false);
  preview?.push(replayData ?? sourceBytes, () => {
    previewDone = true;
    complete();
  });
}

export function handleTerminalServerMessage({
  acknowledgeOutput,
  message,
  replayWrite,
  terminalId = "",
  onOutputFrameParsed,
  onOutputParsed,
  onOutputStart,
  onReplayComplete,
  onSessionChange,
  replayNextSeq,
  replayWriteState,
  outputFrameId,
  outputBoundaries,
  setReplayNextSeq,
  setReplayStartSequence,
  terminal,
  pipeline,
  replayPipeline,
  replayCheckpointSequence,
  allowAttachedGrid = true,
  onReplayStart,
  shouldProcessOutput,
  writeExitNotice,
}: HandleTerminalServerMessageArgs): void {
  if (message.type === "output" && shouldProcessOutput?.() === false) {
    return;
  }
  switch (message.type) {
    case "attached":
      if (message.replayStartSeq < message.nextSeq) {
        onReplayStart?.(message.session);
      }
      if (allowAttachedGrid) {
        if (pipeline)
          pipeline.setGrid(message.session.cols, message.session.rows);
        else terminal.resize(message.session.cols, message.session.rows);
      }
      onSessionChange?.(message.session);
      if (message.session.status === "exited") {
        writeExitNotice?.(
          message.session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${message.session.exitCode}`,
        );
      }
      setReplayNextSeq(message.nextSeq);
      setReplayStartSequence?.(message.replayStartSeq);
      if (message.replayStartSeq === message.nextSeq) {
        setReplayNextSeq(null);
        onReplayComplete();
      }
      return;
    case "pong":
      return;
    case "session-updated":
      onSessionChange?.(message.session);
      if (message.session.status === "exited") {
        writeExitNotice?.(
          message.session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${message.session.exitCode}`,
        );
      }
      return;
    case "output": {
      const nextSeq = message.chunk.seq + 1;
      writeTerminalOutput({
        data: replayWrite?.bytes ?? decodeBase64Bytes(message.chunk.dataBase64),
        replayData: replayWrite?.sourceBytes,
        frameId: outputFrameId,
        isReplay: replayNextSeq !== null && message.chunk.seq < replayNextSeq,
        terminalId,
        onOutputParsed: onOutputFrameParsed,
        onParsed: () => {
          onOutputParsed?.(message.chunk.seq);
          if (outputBoundaries === undefined) onOutputStart?.(nextSeq);
          acknowledgeOutput(nextSeq);
          if (
            replayNextSeq !== null &&
            message.chunk.seq < replayNextSeq &&
            nextSeq === replayNextSeq
          ) {
            setReplayNextSeq(null);
            onReplayComplete();
          }
        },
        replayWriteState,
        terminal,
        pipeline,
        replayPipeline,
        replayCheckpointSequence,
        outputSequence: message.chunk.seq,
        outputBoundaries: replayWrite ? undefined : outputBoundaries,
      });
      return;
    }
    case "error":
      writeTerminalStatus({
        terminal,
        text: `Terminal error: ${message.message}`,
      });
      return;
    case "exited":
      onSessionChange?.(message.session);
      {
        const text =
          message.session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${message.session.exitCode}`;
        if (!writeExitNotice?.(text)) writeTerminalStatus({ terminal, text });
      }
      return;
  }
}

export function ThreadTerminalView({
  retainNativeOutput = false,
  attentionShownAsBanner = false,
  autoFocus,
  isPanelOpen: panelOpen,
  parked = false,
  onRetentionInvalidated,
  onAutoFocusHandled,
  onOpenLink,
  onSelectionAddToChat,
  onSessionChange,
  onTitleChange,
  onProgressChange,
  onCwdChange,
  onUserInput,
  session,
}: ThreadTerminalViewProps) {
  const isPanelOpen = panelOpen && !parked;
  const parkedRef = useRef(parked);
  parkedRef.current = parked;
  const retentionInvalidatedRef = useRef(onRetentionInvalidated);
  retentionInvalidatedRef.current = onRetentionInvalidated;
  const parkTransportRef = useRef<((parked: boolean) => void) | null>(null);
  const returningRef = useRef(false);
  const restoringFocusRef = useRef(false);
  useLayoutEffect(() => {
    if (parked) returningRef.current = true;
    parkTransportRef.current?.(parked);
  }, [parked]);
  const [handoffOwnerToken, setHandoffOwnerToken] = useState(() =>
    wsManager.getDeviceHandoffClientToken(),
  );
  useEffect(
    () => wsManager.onDeviceHandoffClientToken(setHandoffOwnerToken),
    [],
  );
  const isTouchDevice = useMediaQuery("(pointer: coarse)");
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY);
  const attentionClearRequestRef = useRef<string | null>(null);
  const [controlActive, setControlActive] = useState(false);
  const controlActiveRef = useRef(false);
  const changeControlActive = (active: boolean) => {
    controlActiveRef.current = active;
    setControlActive(active);
  };

  const clearAttentionOnInput = useCallback(() => {
    if (session.attention == null) return;
    const requestKey = `${session.id}:${session.attention.seq}`;
    if (attentionClearRequestRef.current === requestKey) return;
    attentionClearRequestRef.current = requestKey;
    void sdk.terminals.experimental_attention
      .clear({ terminalId: session.id })
      .then((updatedSession) => onSessionChange?.(updatedSession))
      .catch(() => {
        attentionClearRequestRef.current = null;
        appToast.error("Couldn't clear terminal attention.");
      });
  }, [onSessionChange, session.attention, session.id]);
  const clearAttentionOnInputRef = useRef(clearAttentionOnInput);
  clearAttentionOnInputRef.current = clearAttentionOnInput;
  const claimSizeRef = useRef<(() => void) | null>(null);
  const [showFitControl, setShowFitControl] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [promptTrackerState, setPromptTrackerState] = useState(
    EMPTY_TERMINAL_PROMPT_TRACKER,
  );
  const [terminalSearchAddon, setTerminalSearchAddon] =
    useState<TerminalSearchAddonInstance | null>(null);
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const terminalSearchOpenRef = useRef(false);
  terminalSearchOpenRef.current = terminalSearchOpen;
  const [textSnapshot, setTextSnapshot] = useState<string | null>(null);
  const [textSnapshotInitialLine, setTextSnapshotInitialLine] = useState<
    number | null
  >(null);
  const [terminalFontSize, setTerminalFontSize] = useState(
    () => readTerminalFontMetrics().fontSize,
  );
  const terminalFontSizeRef = useRef(terminalFontSize);
  const defaultFontSizeRef = useRef(terminalFontSize);
  const longPressGestureRef = useRef<{
    cancel: () => void;
    move: (touches: readonly TerminalGestureTouch[]) => void;
  } | null>(null);
  const pinchGestureRef = useRef<ReturnType<
    typeof createTerminalPinchGesture
  > | null>(null);
  const [activeSelection, setActiveSelection] =
    useState<MessageProseSelection | null>(null);
  const [pendingTerminalLink, setPendingTerminalLink] =
    useState<TerminalLinkTarget | null>(null);
  const [connectionNotice, setConnectionNotice] =
    useState<TerminalConnectionNotice | null>(null);
  const [restoringSession, setRestoringSession] = useState(
    session.status === "running",
  );
  const [replayNotice, setReplayNotice] = useState<TerminalReplayNotice | null>(
    null,
  );
  const [contextMenuState, setContextMenuState] =
    useState<TerminalContextMenuState>({
      link: null,
      selectionText: "",
    });
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingReplayRevealRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (
      pendingReplayRevealRef.current === session.id &&
      !restoringSession &&
      containerRef.current?.dataset.replayHeld === "false" &&
      !viewRef.current?.querySelector(
        "[data-terminal-screen-loading-preview], [data-terminal-restoring]",
      )
    ) {
      markTerminalPerformance("terminal-replay-revealed", {
        detail: { terminalId: session.id },
      });
      pendingReplayRevealRef.current = null;
    }
  }, [restoringSession, session.id]);
  const webglVisibilityRef = useRef<ReturnType<
    typeof observeTerminalWebglVisibility
  > | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const compositionInputGuardRef = useRef<ReturnType<
    typeof suppressDuplicateTerminalCompositionInput
  > | null>(null);
  const promptLinesRef = useRef<number[]>([]);
  const hoveredTerminalLinkRef = useRef<TerminalLinkTarget | null>(null);
  const pointerStartPointRef = useRef<SelectionAnchorPoint | null>(null);
  const pointerIsDownRef = useRef(false);
  const terminalSelectionGestureRef = useRef(false);
  const touchFocusGestureRef = useRef<TerminalTouchFocusGesture | null>(null);
  const touchHandlersRef = useRef<ReturnType<
    typeof createTerminalTouchHandlers
  > | null>(null);
  const touchHandlers = useCallback(() => {
    touchHandlersRef.current ??= createTerminalTouchHandlers(terminalRef);
    return touchHandlersRef.current;
  }, []);
  const lastPointerReleaseAnchorRef = useRef<SelectionAnchor | null>(null);
  const handleFileDropRef = useRef<((files: FileList) => void) | null>(null);
  const onSessionChangeRef = useRef<
    ((session: TerminalSession) => void) | undefined
  >(onSessionChange);
  const onTitleChangeRef = useRef<TerminalTitleChangeHandler | undefined>(
    onTitleChange,
  );
  const onProgressChangeRef = useRef(onProgressChange);
  const onCwdChangeRef = useRef(onCwdChange);
  const onUserInputRef = useRef<(() => void) | undefined>(onUserInput);
  const onAutoFocusHandledRef = useRef<(() => void) | undefined>(
    onAutoFocusHandled,
  );
  const autoFocusRef = useRef(autoFocus);
  const isPanelOpenRef = useRef(isPanelOpen);
  const previousPanelOpenRef = useRef(isPanelOpen);
  const reportDocumentVisibilityRef = useRef<(() => void) | null>(null);
  const sessionStatusRef = useRef<TerminalSession["status"]>(session.status);
  const sessionRef = useRef(session);
  const lastStatusNoticeRef = useRef<TerminalSessionStatusNotice | null>(null);
  const lastStatusNoticeSessionRef = useRef(session.id);
  resetTerminalExitNoticeForSession({
    lastNotice: lastStatusNoticeRef,
    lastSessionId: lastStatusNoticeSessionRef,
    sessionId: session.id,
  });
  const scheduleFitRef = useRef<TerminalFitScheduler | null>(null);
  const terminalVisibilityReporterRef = useRef<(() => void) | null>(null);
  const systemConfig = useSystemConfig();
  const copyOnSelectRef = useRef(false);
  const lastUserInputAtRef = useRef<number | null>(null);
  copyOnSelectRef.current =
    systemConfig.data?.generalSettings.terminalCopyOnSelect === true;
  const preferredTheme = usePreferredTheme();
  const appThemeEpoch = useAppThemeEpoch();
  const appNavigation = useAppNavigationHost();
  const appNavigationRef = useRef(appNavigation);
  useEffect(() => {
    appNavigationRef.current = appNavigation;
  }, [appNavigation]);
  const commandRunner = useAppCommandRunner();
  const handleOpenLinkByPreference = useCallback<MarkdownPreviewLinkHandler>(
    ({ href }) => appNavigation.openUrl({ url: href }),
    [appNavigation],
  );
  const effectiveOnOpenLink = onOpenLink ?? handleOpenLinkByPreference;
  const onOpenLinkRef = useRef<MarkdownPreviewLinkHandler>(effectiveOnOpenLink);
  promptLinesRef.current = promptTrackerState.promptLines;
  const jumpToPrompt = useCallback((direction: "previous" | "next") => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const line = terminalPromptLine(
      promptLinesRef.current,
      terminal.buffer.active.viewportY,
      direction,
    );
    if (line !== null) terminal.scrollToLine(line);
  }, []);

  autoFocusRef.current = autoFocus;
  isPanelOpenRef.current = isPanelOpen;
  sessionStatusRef.current = session.status;
  sessionRef.current = session;
  onAutoFocusHandledRef.current = onAutoFocusHandled;
  onOpenLinkRef.current = effectiveOnOpenLink;
  onSessionChangeRef.current = onSessionChange;
  onTitleChangeRef.current = onTitleChange;
  onProgressChangeRef.current = onProgressChange;
  onCwdChangeRef.current = onCwdChange;
  onUserInputRef.current = onUserInput;

  const reportTerminalSelection = useCallback(
    (anchor: SelectionAnchor | null, selectionText?: string) => {
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!terminal || !container) {
        setActiveSelection(null);
        return;
      }
      if (pointerIsDownRef.current) {
        return;
      }
      terminalSelectionGestureRef.current = false;
      const text = selectionText ?? terminal.getSelection();
      setActiveSelection(
        buildTerminalSelection({
          anchor,
          containerElement: container,
          text,
        }),
      );
    },
    [],
  );

  const copyTerminalSelection = useCallback((text: string) => {
    void copyToClipboardWithToast(text, {
      successMessage: null,
      errorMessage: null,
    });
  }, []);

  const copyTerminalSelectionOnSelect = useCallback((text: string) => {
    void copyToClipboardWithToast(text, {
      successMessage: "Selection copied",
      errorMessage: "Failed to copy selection",
    });
  }, []);

  const clearTerminalSelection = useCallback(() => {
    terminalRef.current?.clearSelection();
    setActiveSelection(null);
  }, []);

  const dismissTerminalSelectionMenu = useCallback(() => {
    if (terminalSelectionGestureRef.current) {
      setActiveSelection(null);
      return;
    }
    clearTerminalSelection();
  }, [clearTerminalSelection]);

  const isTerminalCommandAvailable = ({
    target,
  }: {
    target: EventTarget | null;
  }) =>
    terminalRef.current !== null &&
    (target === null ||
      (target instanceof Node && viewRef.current?.contains(target) === true));
  useAppCommandHandler(
    "terminal.find",
    () => {
      setActiveSelection(null);
      setTerminalSearchOpen(true);
      return true;
    },
    0,
    isPanelOpen,
    isTerminalCommandAvailable,
  );
  const handleTerminalCommandKeyDown = (event: ReactKeyboardEvent) => {
    const command = commandRunner.getShortcutCommand(event.nativeEvent, [
      "terminal.find",
    ]);
    if (command === null || !commandRunner.dispatch(command, event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const updateHoveredTerminalLink = useCallback(
    (target: TerminalLinkTarget | null) => {
      hoveredTerminalLinkRef.current = target;
    },
    [],
  );

  const openTerminalLink = useCallback((uri: string) => {
    openTerminalWebLink({
      onOpenLink: onOpenLinkRef.current,
      uri,
    });
  }, []);

  const confirmTerminalLinkOpen = useCallback(
    (target: TerminalLinkTarget) => {
      setPendingTerminalLink(null);
      openTerminalLink(target.uri);
    },
    [openTerminalLink],
  );

  const requestOpenTerminalLink = useCallback(
    (target: TerminalLinkTarget) => {
      requestTerminalLinkOpen({
        openLink: openTerminalLink,
        requestConfirmation: setPendingTerminalLink,
        target,
      });
    },
    [openTerminalLink],
  );

  const captureTerminalContextMenu = useCallback(() => {
    setContextMenuState(
      captureTerminalContextMenuState({
        link: hoveredTerminalLinkRef.current,
        terminal: terminalRef.current,
      }),
    );
  }, []);

  const copyTerminalContextValue = useCallback(
    (text: string, successMessage: string) => {
      void copyToClipboardWithToast(text, {
        successMessage,
        errorMessage: "Failed to copy",
      });
    },
    [],
  );

  const pasteFromClipboard = useCallback(() => {
    const terminal = terminalRef.current;
    if (terminal === null || sessionStatusRef.current !== "running") {
      return;
    }
    void pasteTerminalClipboard({
      terminal,
      readText: () => navigator.clipboard.readText(),
      isActive: () =>
        terminalRef.current === terminal &&
        sessionStatusRef.current === "running",
    }).catch(() => {
      appToast.error(CLIPBOARD_BLOCKED_MESSAGE);
    });
  }, []);

  const handleSelectionAddToChat = useCallback(
    (text: string) => {
      onSelectionAddToChat?.(text);
      clearTerminalSelection();
    },
    [clearTerminalSelection, onSelectionAddToChat],
  );

  const handleTerminalPointerDown = useCallback(
    (event: Pick<PointerEvent, "button" | "clientX" | "clientY">) => {
      if (event.button !== 0) {
        if (event.button === 1) {
          terminalRef.current?.focus();
        }
        return;
      }
      pointerIsDownRef.current = true;
      terminalSelectionGestureRef.current = true;
      pointerStartPointRef.current = anchorPointFromMouseEvent(event);
    },
    [],
  );

  const handleTerminalPointerRelease = useCallback(
    (event: Pick<PointerEvent, "button" | "clientX" | "clientY">) => {
      if (event.button !== 0) {
        return;
      }
      const anchor = selectionAnchorFromPointerRelease(
        pointerStartPointRef.current,
        { clientX: event.clientX, clientY: event.clientY },
      );
      lastPointerReleaseAnchorRef.current = anchor;
      pointerIsDownRef.current = false;
      pointerStartPointRef.current = null;
      window.requestAnimationFrame(() => {
        reportTerminalSelection(anchor);
      });
    },
    [reportTerminalSelection],
  );

  const handleTerminalPointerCancel = useCallback(() => {
    pointerStartPointRef.current = null;
    pointerIsDownRef.current = false;
    window.requestAnimationFrame(() => {
      reportTerminalSelection(lastPointerReleaseAnchorRef.current);
    });
  }, [reportTerminalSelection]);

  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (pointerIsDownRef.current) {
        handleTerminalPointerRelease(event);
      }
    };
    const cancel = () => {
      if (pointerIsDownRef.current) {
        handleTerminalPointerCancel();
      }
    };
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", cancel);
    return () => {
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [handleTerminalPointerRelease, handleTerminalPointerCancel]);

  const handleTerminalTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchFocusGestureRef.current = startTerminalTouchFocusGesture(
        terminalTouchPoints(event.touches),
        event.timeStamp,
      );
    },
    [],
  );

  const handleTerminalTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchFocusGestureRef.current = updateTerminalTouchFocusGesture(
        touchFocusGestureRef.current,
        terminalTouchPoints(event.touches),
      );
    },
    [],
  );

  const handleTerminalTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const gesture = touchFocusGestureRef.current;
      touchFocusGestureRef.current = null;
      focusTerminalFromTouchRelease({
        changedTouches: terminalTouchPoints(event.changedTouches),
        focus: () => terminalRef.current?.focus(),
        gesture,
        releasedAt: event.timeStamp,
        remainingTouchCount: event.touches.length,
      });
    },
    [],
  );

  const handleTerminalTouchCancel = useCallback(() => {
    touchFocusGestureRef.current = null;
  }, []);

  useEffect(() => {
    touchFocusGestureRef.current = null;
    touchHandlersRef.current?.cancel();
    setActiveSelection(null);
    setTextSnapshot(null);
    updateHoveredTerminalLink(null);
    setPendingTerminalLink(null);
    setContextMenuOpen(false);
    if (parked) {
      longPressGestureRef.current?.cancel();
      setTerminalSearchOpen(false);
    }
    setContextMenuState({ link: null, selectionText: "" });
  }, [parked, session.id, updateHoveredTerminalLink]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const holdForFittedGrid =
      container.closest("[data-native-terminal-thread]") !== null;
    setRestoringSession(sessionStatusRef.current === "running");

    let activeElementAtMount = document.activeElement;
    container.style.containerType = "inline-size";

    const earlySocketUrl = buildTerminalWebSocketUrl({
      handoffOwnerToken:
        wsManager.getDeviceHandoffClientToken() ?? handoffOwnerToken,
      terminalId: session.id,
    });
    if (sessionStatusRef.current === "running")
      prefetchTerminalSocket(earlySocketUrl);
    let disposed = false;
    let transport: TerminalWebSocketTransport | null = null;
    let terminal: XTermTerminal | null = null;
    let webglRenderer: ReturnType<typeof loadTerminalWebglRenderer> | null =
      null;
    let rendererDeadline: ReturnType<typeof setTimeout> | undefined;
    let fitAddon: FitAddon | null = null;
    const fitWork = createTerminalFitWork();
    let replayNextSeq: number | null = null;
    let replayNextSequence = 0;
    const replayWriteState: TerminalReplayWriteState = {
      suppressedWriteCount: 0,
    };
    let resizeAnimationFrame: number | null = null;
    let connectionNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
    let retainedReplayTimeout: ReturnType<typeof setTimeout> | null = null;
    let terminalInteractions: ReturnType<
      typeof attachTerminalInteractions
    > | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let selectionChangeDisposable: { dispose: () => void } | null = null;
    let terminalRenderSubscription: { dispose: () => void } | null = null;
    let terminalResizeSubscription: { dispose: () => void } | null = null;
    let viewportLineAnchor: ReturnType<
      typeof createTerminalViewportLineAnchor
    > | null = null;
    let terminalKeyDisposable: { dispose: () => void } | null = null;
    let terminalInputForwarding: { dispose: () => void } | null = null;
    let shellOscDisposable: { dispose: () => void } | null = null;
    let terminalProgressDisposable: { dispose: () => void } | null = null;
    let osc52Disposable: { dispose: () => void } | null = null;
    let outputBoundaryDisposable: { dispose: () => void } | null = null;
    let stopObservingFonts: (() => void) | null = null;
    let detachViewportListeners: (() => void) | null = null;
    let replayStartSequence = 0;
    let latestOutputSequence = 0;
    let anchoredOutputSequence = 0;
    const outputLineAnchors: TerminalOutputLineAnchor[] = [];
    const outputLineAnchorTracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => terminal?.registerMarker(),
      getCurrentLine: () => {
        const buffer = terminal?.buffer.active;
        return buffer ? buffer.baseY + buffer.cursorY : 0;
      },
    });
    let parsingOutputSequence: number | null = null;
    const recordOutputStart = (sequence: number) => {
      parsingOutputSequence = sequence;
      const outputAnchor = outputLineAnchorTracker.recordOutputStart(sequence);
      if (!outputAnchor) return;
      outputLineAnchors.push(outputAnchor);
      if (outputLineAnchors.length > 4096) {
        const removed = outputLineAnchors.splice(
          0,
          outputLineAnchors.length - 4096,
        );
        outputLineAnchorTracker.forget(removed);
      }
    };
    let savedOutputLineAnchor: TerminalOutputLineAnchor | null = null;
    const updateSavedOutputLineAnchor = (
      anchor: TerminalOutputLineAnchor | null,
    ) => {
      savedOutputLineAnchor = outputLineAnchorTracker.updatePinnedAnchor(
        savedOutputLineAnchor,
        anchor,
        outputLineAnchors,
      );
    };
    const updateViewportLineAnchor = (line: number) => {
      const activeBuffer = terminal?.buffer.active;
      if (activeBuffer && line < activeBuffer.baseY) {
        viewportLineAnchor?.setLine(line);
      } else {
        viewportLineAnchor?.clear();
      }
    };
    let hasRestoredViewport = false;
    let hasManualScrollIntent = false;
    let manualScrollTimeout: ReturnType<typeof setTimeout> | null = null;
    const viewportStorageKey = terminalViewportStorageKey(session.id);
    const viewportStorage = terminalViewportStorageForClient(window);
    let savedViewportAnchor = readTerminalViewportAnchor(
      viewportStorage,
      viewportStorageKey,
    );
    const viewportPersistence = createTerminalViewportPersistence({
      key: viewportStorageKey,
      storage: viewportStorage,
    });
    const viewportReplaySaveGate = createTerminalViewportReplaySaveGate();
    anchoredOutputSequence = savedViewportAnchor?.outputSequence ?? 0;
    const noteManualScrollIntent = () => {
      hasManualScrollIntent = true;
      viewportLineAnchor?.clear();
      if (manualScrollTimeout !== null) {
        clearTimeout(manualScrollTimeout);
      }
      manualScrollTimeout = setTimeout(() => {
        hasManualScrollIntent = false;
        manualScrollTimeout = null;
      }, 250);
    };
    let stopWatchingLayout: (() => void) | null = null;
    let sizeClaims: ReturnType<typeof listenForTerminalSizeClaims> | null =
      null;
    let sharedSize: TerminalGridSize | null = null;
    let markerGridActive = false;
    let replayCompleted = false;
    let replayStarted = false;
    let replayTimingNextSeq: number | null = null;
    let replayTimingFirstFrame = false;
    let messageEventTimestamp = 0;
    const pendingExitNotices: string[] = [];
    let replayCheckpointSequence: number | null = null;
    let localFitGrid: TerminalGridSize | null = null;
    let claimedFitGrid: TerminalGridSize | null = null;
    let checkReplayReveal: (() => void) | null = null;
    let replayRevealTimeout: ReturnType<typeof setTimeout> | null = null;
    let replayRevealGeneration = 0;
    let completeReplayReveal: (() => void) | null = null;
    let fittedGridHeld = false;
    let fittedGridRevealed = false;
    let fittedGridFallback = false;
    let screenLoadingPreview: ReturnType<
      typeof mountTerminalScreenLoadingPreview
    > | null = null;
    let keepScreenLoadingPreview = false;
    const clearScreenLoadingPreview = () => {
      screenLoadingPreview?.dispose();
      screenLoadingPreview = null;
    };
    const terminalFontOptions = {
      ...readTerminalFontMetrics(),
      fontSize: terminalFontSizeRef.current,
      ...TERMINAL_CELL_OPTIONS,
    };
    let initialRendererSettled = retainNativeOutput;
    let resolveRendererSettled = () => {};
    const rendererSettled = new Promise<void>((resolve) => {
      resolveRendererSettled = resolve;
    });
    if (initialRendererSettled) resolveRendererSettled();
    let initialLayoutSettled = false;
    let initialFitComplete = false;
    let retainedOutputReplayed = sessionStatusRef.current !== "exited";
    let retainedOutputGrid: TerminalGridSize | null = null;
    let latestPtyGrid: TerminalGridSize = {
      cols: sessionRef.current.cols,
      rows: sessionRef.current.rows,
    };
    let terminalInputClaimed = false;
    let detachPointerCoordinates: (() => void) | null = null;
    let detachGridVisibilityListeners: (() => void) | null = null;
    let replayPreview: ReturnType<typeof mountTerminalReplayPreview> | null =
      null;
    const flushPendingExitNotices = () => {
      if (terminal === null || pendingExitNotices.length === 0) return;
      for (const text of pendingExitNotices.splice(0)) {
        writeTerminalStatus({ terminal, text });
      }
    };
    let paintedScreenKept = false;
    let processExitedSeen = false;
    let retryStalledReplay: () => void = () => undefined;
    const releaseReplayPreview = () => {
      paintedScreenKept = false;
      replayPreview?.release();
      clearScreenLoadingPreview();
      setRestoringSession(false);
      setReplayNotice(null);
    };
    let exitedBeforeReplayCompleted = false;
    let replayPreviewExitApplied = false;
    const handleReplayPreviewExit = createTerminalReplayPreviewExitHandler({
      getReplayState: () => ({
        hasReplaySurface: replayPreview !== null,
        replayCompleted,
      }),
      isApplied: () => replayPreviewExitApplied,
      isPending: () => exitedBeforeReplayCompleted,
      markApplied: () => {
        replayPreviewExitApplied = true;
      },
      markPending: () => {
        exitedBeforeReplayCompleted = true;
      },
      releasePreview: releaseReplayPreview,
      processExited: () => replayPreview?.processExited(),
    });
    const keepPaintedScreen = () => {
      paintedScreenKept = true;
      replayPreview?.showFallback();
      setReplayNotice("reconnecting");
    };
    const abandonReplayPreview = () => {
      flushPendingExitNotices();
      if (replayPreview === null || replayCompleted) {
        releaseReplayPreview();
        return;
      }
      if (replayPreview.fallback) replayPreview.hold({ countdown: false });
      replayPreview.showFallback();
      paintedScreenKept = true;
      setReplayNotice("unavailable");
    };
    let outputPipeline: ReturnType<typeof createTerminalOutputPipeline> | null =
      null;
    let containerHasSize = hasVisibleTerminalSize({
      containerElement: container,
    });
    let terminalVisible: boolean | null = null;
    let hasReceivedInitialAttach = false;
    let lastParsedOutputNextSeq = 0;
    let lastQueuedOutputNextSeq = 0;
    const hiddenOutput = createTerminalHiddenOutput(() =>
      retentionInvalidatedRef.current?.(),
    );
    let flushHiddenOutput = () => {};
    let parkedOutputTimer: ReturnType<typeof setTimeout> | null = null;
    let parkedOutputDraining = false;
    const reportDocumentVisibility = () => {
      if (
        document.visibilityState !== "visible" ||
        !containerHasSize ||
        !isPanelOpenRef.current
      ) {
        cancelTerminalOutputNextRenders(session.id);
      }
      const nextVisible =
        document.visibilityState === "visible" &&
        containerHasSize &&
        isPanelOpenRef.current;
      if (transport === null) return;
      if (!holdForFittedGrid && !isPanelOpenRef.current && !parkedRef.current)
        hiddenOutput.invalidate();
      const wasVisible = terminalVisible;
      if (wasVisible === nextVisible) return;
      terminalVisible = nextVisible;
      if (nextVisible) webglVisibilityRef.current?.sync();
      transport?.setVisible(nextVisible);
      if (nextVisible) {
        if (!returningRef.current) sizeClaims?.claimIfFocused();
        scheduleFitRef.current?.();
      }
      if (wasVisible === false && nextVisible) flushHiddenOutput();
    };
    terminalVisibilityReporterRef.current = reportDocumentVisibility;
    reportDocumentVisibilityRef.current = reportDocumentVisibility;

    let liveBottomBeforeGridResize = false;
    let liveBottomResizeClearFrame: number | null = null;
    const captureLiveViewportBeforeGridResize = () => {
      const activeBuffer = terminal?.buffer.active;
      liveBottomBeforeGridResize =
        activeBuffer !== undefined &&
        activeBuffer.viewportY === activeBuffer.baseY;
      if (activeBuffer && !liveBottomBeforeGridResize) {
        viewportLineAnchor?.setLine(activeBuffer.viewportY);
      }
    };
    const clearLiveViewportBeforeGridResize = () => {
      if (liveBottomResizeClearFrame !== null) {
        window.cancelAnimationFrame(liveBottomResizeClearFrame);
      }
      liveBottomResizeClearFrame = window.requestAnimationFrame(() => {
        liveBottomResizeClearFrame = null;
        liveBottomBeforeGridResize = false;
      });
    };

    async function mountTerminal(
      containerElement: HTMLDivElement,
    ): Promise<void> {
      containerElement.style.opacity = "0";
      let paddingLeft = "0px";
      let horizontalPadding = 0;
      const needsFittedGrid = () =>
        holdForFittedGrid && sessionStatusRef.current !== "exited";
      const fittedGridReady = () => {
        const fit = localFitGrid;
        return (
          fit !== null &&
          fit.cols > 0 &&
          fit.rows > 0 &&
          containerHasSize &&
          hasReceivedInitialAttach &&
          replayCompleted &&
          initialRendererSettled &&
          initialLayoutSettled &&
          claimedFitGrid?.cols === fit.cols &&
          claimedFitGrid.rows === fit.rows &&
          latestPtyGrid.cols === fit.cols &&
          latestPtyGrid.rows === fit.rows &&
          terminal?.cols === fit.cols &&
          terminal.rows === fit.rows
        );
      };
      const holdFittedGrid = () => {
        if (
          !needsFittedGrid() ||
          fittedGridFallback ||
          fittedGridHeld ||
          fittedGridRevealed
        )
          return;
        fittedGridHeld = true;
        const generation = ++replayRevealGeneration;
        containerElement.dataset.replayHeld = "true";
        containerElement.style.opacity = "0";
        setRestoringSession(true);
        if (replayCompleted) replayPreview?.hold({ countdown: false });
        const release = () => {
          if (disposed || generation !== replayRevealGeneration) return;
          checkReplayReveal = null;
          if (replayRevealTimeout !== null) clearTimeout(replayRevealTimeout);
          replayRevealTimeout = null;
          fittedGridHeld = false;
          fittedGridRevealed = true;
          markTerminalPerformance("terminal-fitted-grid-revealed");
          containerElement.dataset.replayHeld = "false";
          if (fittedGridFallback) {
            containerElement.style.opacity = "";
            if (terminal?.element) terminal.element.style.visibility = "";
          }
          const complete = completeReplayReveal;
          completeReplayReveal = null;
          const finish = () => {
            setRestoringSession(false);
            complete?.();
            updateGridVisibility();
          };
          if (needsFittedGrid()) flushSync(finish);
          else finish();
        };
        checkReplayReveal = () => {
          if (
            disposed ||
            generation !== replayRevealGeneration ||
            !fittedGridReady()
          )
            return;
          release();
        };
        replayRevealTimeout = setTimeout(() => {
          if (disposed || generation !== replayRevealGeneration) return;
          fittedGridFallback = true;
          release();
        }, 15_000);
      };
      holdFittedGrid();
      const updateGridVisibility = () => {
        if (terminal === null) {
          return;
        }
        containerElement.dataset.renderGridCols = String(terminal.cols);
        containerElement.dataset.renderGridRows = String(terminal.rows);
        const ownsTerminal =
          terminalInputClaimed &&
          document.hasFocus() &&
          terminal.element?.contains(document.activeElement) === true;
        const displayGrid = retainedOutputGrid ?? latestPtyGrid;
        const canReveal =
          localFitGrid !== null &&
          (sessionStatusRef.current === "exited" ||
            initialFitComplete ||
            (terminal.cols === localFitGrid.cols &&
              terminal.rows === localFitGrid.rows)) &&
          (!retainNativeOutput ||
            sessionStatusRef.current !== "exited" ||
            retainedOutputGrid !== null) &&
          canRevealTerminalSurface({
            fitGrid: localFitGrid,
            isOwner: ownsTerminal && !retainNativeOutput,
            ptyGrid: displayGrid,
            rendererGrid: { cols: terminal.cols, rows: terminal.rows },
          });
        const presentation = terminalSurfacePresentation({
          grid: displayGrid,
          fitGrid: localFitGrid,
          fontSize: terminalFontSizeRef.current,
          isOwner: ownsTerminal,
          minimumFontSize: defaultFontSizeRef.current,
          running: sessionStatusRef.current === "running",
        });
        setShowFitControl(presentation.showFitControl);
        containerElement.dataset.ptyGridCols = String(latestPtyGrid.cols);
        containerElement.dataset.ptyGridRows = String(latestPtyGrid.rows);
        if (terminal.element) {
          terminal.element.style.maxWidth = needsFittedGrid() ? "100%" : "";
          terminal.element.style.overflow = needsFittedGrid() ? "hidden" : "";
        }
        if (needsFittedGrid() && fittedGridRevealed && !fittedGridReady())
          return;
        if (needsFittedGrid() && !fittedGridReady()) holdFittedGrid();
        checkReplayReveal?.();
        if (
          (replayPreview !== null && !replayCompleted) ||
          (needsFittedGrid() && containerElement.dataset.replayHeld === "true")
        )
          return;
        if (!needsFittedGrid() || !fittedGridRevealed)
          containerElement.style.opacity = "0";
        const scrollRetainedOutput =
          !needsFittedGrid() &&
          (retainedOutputGrid !== null
            ? getMediaQuerySnapshot(COMPACT_VIEWPORT_QUERY)
            : presentation.panHorizontally);
        containerElement.style.overflowX = scrollRetainedOutput ? "auto" : "";
        containerElement.style.overflowY = scrollRetainedOutput ? "auto" : "";
        containerElement.style.touchAction = scrollRetainedOutput
          ? "pan-x pan-y"
          : "";
        const scale = retainedOutputGrid !== null ? 1 : presentation.scale;
        if (terminal.element) {
          applyTerminalSurfaceScale(
            terminal.element,
            scale,
            !scrollRetainedOutput && !needsFittedGrid(),
          );
        }
        const rendererWidth =
          containerElement.getBoundingClientRect().width - horizontalPadding;
        const paintedWidth =
          terminal.element
            ?.querySelector<HTMLElement>(".xterm-screen")
            ?.getBoundingClientRect().width ?? 0;
        const widthFits =
          rendererWidth > 0 &&
          (scrollRetainedOutput || paintedWidth <= rendererWidth + 1);
        if (canReveal && widthFits) {
          if (replayCompleted && replayPreview !== null) {
            replayPreview.dispose();
            replayPreview = null;
          }
          if (terminal.element) terminal.element.style.visibility = "";
          containerElement.style.opacity = "";
          return;
        }
      };
      const screenPromise =
        sessionRef.current.status === "exited" || pendingExitNotices.length > 0
          ? Promise.resolve(null)
          : fetchTerminalScreen(session.id, session.threadId ?? undefined);
      let modulesReady = false;
      void screenPromise.then((snapshot) => {
        if (
          disposed ||
          replayStarted ||
          replayCompleted ||
          snapshot == null ||
          !snapshot.complete ||
          snapshot.truncated
        )
          return;
        keepScreenLoadingPreview =
          snapshot.cols !== latestPtyGrid.cols ||
          snapshot.gridRows !== latestPtyGrid.rows;
        if (modulesReady && !keepScreenLoadingPreview) return;
        screenLoadingPreview = mountTerminalScreenLoadingPreview({
          container: containerElement,
          snapshot,
          ...terminalFontOptions,
        });
      });
      markTerminalPerformance("terminal-xterm-import-start");
      const requiredModulesPromise = importTerminalModules();
      const [{ Terminal }, { FitAddon: LoadedFitAddon }, { Unicode11Addon }] =
        await requiredModulesPromise;
      markTerminalPerformance("terminal-xterm-import-end");
      modulesReady = true;
      if (disposed) {
        return;
      }

      const osc8LinkHandler = createTerminalOsc8LinkHandler({
        onActivate: requestOpenTerminalLink,
        onHover: (target) => {
          if (!disposed) {
            updateHoveredTerminalLink(target);
          }
        },
      });

      terminal = new Terminal({
        ...TERMINAL_THEME_OPTIONS,
        allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
        convertEol: true,
        ...terminalFontOptions,
        linkHandler: osc8LinkHandler,
        scrollback: 10_000,
        theme: buildTerminalTheme(),
      });
      terminalProgressDisposable = terminal.parser.registerOscHandler(
        9,
        (payload) => {
          const progress = parseTerminalProgressOsc(payload);
          if (progress === undefined) return false;
          onProgressChangeRef.current?.(
            progress,
            parsingOutputSequence ?? undefined,
            session.id,
          );
          return true;
        },
      );
      terminalRenderSubscription = terminal.onRender(() => {
        if (
          document.visibilityState === "visible" &&
          containerHasSize &&
          isPanelOpenRef.current
        ) {
          recordTerminalOutputNextRender(session.id, performance.now());
        }
      });
      setPromptTrackerState(EMPTY_TERMINAL_PROMPT_TRACKER);
      shellOscDisposable = attachTerminalPromptTracker({
        onChange: setPromptTrackerState,
        onCwdChange: (cwd) => onCwdChangeRef.current?.(cwd),
        terminal,
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          event.altKey &&
          event.shiftKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          jumpToPrompt(event.key === "ArrowUp" ? "previous" : "next");
          return false;
        }
        return createTerminalClipboardKeyHandler({
          terminal: activeTerminal,
          copy: (text) => copyTerminalContextValue(text, "Selection copied"),
          paste: pasteFromClipboard,
        })(event);
      });
      terminalRef.current = terminal;
      osc52Disposable = registerTerminalOsc52Handler(
        { parser: terminal.parser },
        (text) => {
          const offerCopyHandoff = () => {
            const now = Date.now();
            window.dispatchEvent(
              new CustomEvent("bb-device-handoff", {
                detail: {
                  type: "device-handoff",
                  id: `${now}-${Math.random()}`,
                  createdAt: now,
                  expiresAt: now + 120_000,
                  originLabel: sessionRef.current.title,
                  request: {
                    kind: "copy-text",
                    text,
                    origin: {
                      ...(sessionRef.current.threadId === null
                        ? {}
                        : { threadId: sessionRef.current.threadId }),
                      terminalSessionId: session.id,
                    },
                  },
                },
              }),
            );
          };
          if (
            !shouldAutoCopyOsc52({
              copyOnSelect: copyOnSelectRef.current,
              lastUserInputAt: lastUserInputAtRef.current,
              now: Date.now(),
              text,
            })
          ) {
            offerCopyHandoff();
            return;
          }
          void copyToClipboardWithToast(text, {
            successMessage: osc52CopiedNotice(text),
            errorMessage: null,
          }).then((copied) => {
            if (!copied) offerCopyHandoff();
          });
        },
        () => replayWriteState.suppressedWriteCount > 0,
      );
      outputPipeline = createTerminalOutputPipeline(
        terminal,
        (grid, apply) => {
          markerGridActive = true;
          if (apply && !hasReceivedInitialAttach) {
            latestPtyGrid = grid;
          }
          updateTerminalReplayPreviewPtyGrid(
            replayPreview,
            hasReceivedInitialAttach ? latestPtyGrid : grid,
            apply,
          );
          updateGridVisibility();
        },
        (cols, rows) => {
          containerElement.dataset.renderGridCols = String(cols);
          containerElement.dataset.renderGridRows = String(rows);
          updateGridVisibility();
        },
        {
          flushWrites: () => parkedRef.current,
          beforeResize: () => captureLiveViewportBeforeGridResize(),
          afterResize: () => {
            terminal?.refresh(0, terminal.rows - 1);
            clearLiveViewportBeforeGridResize();
          },
          flushReplay: () => {
            if (terminal) flushTerminalReplay(terminal, "primary");
          },
        },
      );
      let reportedCwd: string | null = null;
      terminal.parser.registerOscHandler(7, (data) => {
        reportedCwd = parseTerminalReportedCwd(data) ?? reportedCwd;
        return false;
      });
      terminal.registerLinkProvider(
        createTerminalFileLinkProvider({
          terminal,
          getCwd: () => reportedCwd ?? sessionRef.current.initialCwd,
          hostId: sessionRef.current.hostId,
          openFile: (intent) => {
            appNavigationRef.current.openFilePreview(intent);
          },
        }),
      );
      fitAddon = new LoadedFitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
      markTerminalPerformance("terminal-xterm-open-start");
      terminal.open(containerElement);
      terminal.element?.classList.add("bg-sidebar");
      if (terminal.element) terminal.element.style.visibility = "hidden";
      if (terminal.textarea) terminal.textarea.style.visibility = "visible";
      const rendererStyle = getComputedStyle(
        terminal.element ?? containerElement,
      );
      paddingLeft = rendererStyle.paddingLeft;
      horizontalPadding =
        (parseFloat(paddingLeft) || 0) +
        (parseFloat(rendererStyle.paddingRight) || 0);
      markTerminalPerformance("terminal-xterm-open-end");
      if (initialRendererSettled)
        markTerminalPerformance("terminal-initial-renderer-settled");
      trackTerminalScrollability(terminal);
      const viewport =
        terminal.element?.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport) {
        viewport.style.backgroundColor = "inherit";
      }
      void loadOptionalTerminalSearchAddon(importTerminalSearchAddon)
        .then((searchAddonModule) => {
          if (disposed || searchAddonModule === null || terminal === null) {
            return;
          }
          try {
            const searchAddon = new searchAddonModule.SearchAddon();
            terminal.loadAddon(searchAddon);
            setTerminalSearchAddon(searchAddon);
          } catch {
            setTerminalSearchAddon(null);
          }
        })
        .catch(() => undefined);
      void importTerminalWebLinksAddon()
        .then(({ WebLinksAddon }) => {
          if (disposed || terminal === null) return;
          try {
            terminal.loadAddon(
              new WebLinksAddon(
                (event, uri) => {
                  if (!isTerminalLinkActivation(event)) return;
                  requestOpenTerminalLink({ source: "detected-url", uri });
                },
                {
                  hover: (_event, uri) => {
                    updateHoveredTerminalLink({ source: "detected-url", uri });
                  },
                  leave: () => updateHoveredTerminalLink(null),
                },
              ),
            );
          } catch {
            return;
          }
        })
        .catch(() => undefined);
      const initialRendererReady = loadOptionalTerminalWebglAddon(
        importTerminalWebglAddon,
      )
        .then((webglAddonModule) => {
          if (
            disposed ||
            webglAddonModule === null ||
            terminal === null ||
            retainNativeOutput ||
            initialRendererSettled
          ) {
            return;
          }
          webglRenderer = loadTerminalWebglRenderer(
            terminal,
            () => new webglAddonModule.WebglAddon(),
            {
              root: containerElement,
              visible: false,
              onRendererChange: (renderer) => {
                if (disposed || terminal === null) return;
                markTerminalPerformance("terminal-renderer-changed", {
                  detail: { terminalId: session.id, renderer },
                });
                fitWork.invalidate();
                scheduleFitRef.current?.();
                if (
                  !initialRendererSettled &&
                  (renderer === "webgl" ||
                    webglRenderer?.initialAttemptComplete)
                )
                  settleInitialRenderer();
              },
            },
          );
          webglVisibilityRef.current = observeTerminalWebglVisibility({
            root: containerElement,
            renderer: webglRenderer,
            isPanelOpen: () => isPanelOpenRef.current,
            onVisible: () => scheduleFitRef.current?.(),
          });
        })
        .catch(() => undefined);
      viewportLineAnchor = createTerminalViewportLineAnchor(terminal);
      outputLineAnchorTracker.reset();
      const outputBoundaryToken = randomUuid();
      const outputBoundaries =
        createTerminalOutputBoundaries(outputBoundaryToken);
      outputBoundaryDisposable = registerTerminalOutputBoundaryHandler(
        terminal.parser,
        outputBoundaryToken,
        recordOutputStart,
      );
      const restoreViewport = (afterGridResize = false) => {
        const activeBuffer = terminal?.buffer.active;
        if (!terminal || !activeBuffer) {
          return;
        }
        if (
          (afterGridResize && liveBottomBeforeGridResize) ||
          savedViewportAnchor?.distanceFromTail === 0
        ) {
          terminal.scrollToBottom();
          viewportLineAnchor?.clear();
          hasRestoredViewport = true;
          viewportReplaySaveGate.finishRestore();
          return;
        }
        if (
          afterGridResize &&
          viewportLineAnchor !== null &&
          restoreTerminalViewportToRetainedLine({
            terminal,
            lineAnchor: viewportLineAnchor,
          })
        ) {
          console.debug("Terminal viewport restore", {
            terminalId: session.id,
            branch: "retained-line-marker",
            anchor: savedViewportAnchor,
            line: viewportLineAnchor.getLine(),
          });
          hasRestoredViewport = true;
          viewportReplaySaveGate.finishRestore();
          return;
        }
        const restoreOutputLineAnchors =
          savedOutputLineAnchor === null
            ? outputLineAnchors
            : [...outputLineAnchors, savedOutputLineAnchor];
        const line = resolveTerminalViewportRestore(
          {
            anchor: savedViewportAnchor,
            baseY: activeBuffer.baseY,
            outputLineAnchors: restoreOutputLineAnchors,
            replayNextSequence,
            replayStartSequence,
          },
          (branch) => {
            console.debug("Terminal viewport restore", {
              terminalId: session.id,
              branch,
              anchor: savedViewportAnchor,
              replayStartSequence,
              replayNextSequence,
            });
          },
        );
        terminal.scrollToLine(line);
        updateViewportLineAnchor(line);
        hasRestoredViewport = true;
        viewportReplaySaveGate.finishRestore();
      };
      terminalResizeSubscription = restoreTerminalViewportOnResize({
        terminal,
        canRestore: () => hasRestoredViewport && !hasManualScrollIntent,
        restoreViewport: () => restoreViewport(true),
      });
      const flushViewportOnPageHide = () => viewportPersistence.flush();
      window.addEventListener("pagehide", flushViewportOnPageHide);
      const saveViewportAnchor = () => {
        if (
          !hasRestoredViewport ||
          !viewportReplaySaveGate.canSave(hasManualScrollIntent) ||
          terminal === null
        ) {
          return;
        }
        const activeBuffer = terminal.buffer.active;
        const distanceFromTail = Math.max(
          0,
          activeBuffer.baseY - activeBuffer.viewportY,
        );
        let lineOffset = savedViewportAnchor?.lineOffset ?? 0;
        if (hasManualScrollIntent) {
          const visibleLine = activeBuffer.viewportY;
          const mappedOutput = findTerminalOutputLineAnchor(
            outputLineAnchors,
            visibleLine,
          );
          updateSavedOutputLineAnchor(mappedOutput ?? null);
          lineOffset = mappedOutput
            ? Math.max(0, visibleLine - mappedOutput.line)
            : 0;
          anchoredOutputSequence =
            mappedOutput?.sequence ?? latestOutputSequence;
          updateViewportLineAnchor(visibleLine);
        }
        viewportPersistence.schedule({
          distanceFromTail,
          lineOffset,
          outputSequence: anchoredOutputSequence,
        });
        savedViewportAnchor = {
          distanceFromTail,
          lineOffset,
          outputSequence: anchoredOutputSequence,
        };
      };
      const touchViewportSaveScheduler =
        createTerminalTouchViewportSaveScheduler({
          getViewportY: () => terminal?.buffer.active.viewportY ?? 0,
          requestFrame: (callback) => window.requestAnimationFrame(callback),
          cancelFrame: (handle) => window.cancelAnimationFrame(handle),
          save: saveViewportAnchor,
        });
      const detachManualScrollIntentListeners =
        attachTerminalManualScrollIntentListeners(containerElement, (event) => {
          noteManualScrollIntent();
          if (event.type === "touchmove") touchViewportSaveScheduler.schedule();
        });
      const viewportScrollDisposable = terminal.onScroll(saveViewportAnchor);
      detachViewportListeners = () => {
        viewportScrollDisposable.dispose();
        touchViewportSaveScheduler.dispose();
        detachManualScrollIntentListeners();
        window.removeEventListener("pagehide", flushViewportOnPageHide);
        viewportPersistence.dispose();
        if (manualScrollTimeout !== null) {
          clearTimeout(manualScrollTimeout);
          manualScrollTimeout = null;
        }
      };
      document.addEventListener("focusin", updateGridVisibility);
      document.addEventListener("focusout", updateGridVisibility);
      window.addEventListener("focus", updateGridVisibility);
      window.addEventListener("blur", updateGridVisibility);
      window.addEventListener("resize", updateGridVisibility);
      detachGridVisibilityListeners = () => {
        document.removeEventListener("focusin", updateGridVisibility);
        document.removeEventListener("focusout", updateGridVisibility);
        window.removeEventListener("focus", updateGridVisibility);
        window.removeEventListener("blur", updateGridVisibility);
        window.removeEventListener("resize", updateGridVisibility);
      };
      if (terminal.element) {
        detachPointerCoordinates = attachTerminalScalePointerCoordinates(
          terminal.element,
          () =>
            terminal?.element ? readTerminalSurfaceScale(terminal.element) : 1,
        );
      }
      containerElement.dataset.renderGridCols = String(terminal.cols);
      containerElement.dataset.renderGridRows = String(terminal.rows);
      containerElement.dataset.replayHeld = fittedGridHeld ? "true" : "false";
      attachTerminalWheelLines(terminal);
      if (sessionRef.current.status !== "exited") {
        writeTerminalSessionStatusNotice({
          lastNotice: lastStatusNoticeRef,
          session: sessionRef.current,
          terminal,
        });
      }
      const prepareClaimedGrid = () => {
        const grid = claimedFitGrid;
        if (
          !fittedGridRevealed &&
          replayCompleted &&
          grid !== null &&
          terminal !== null &&
          outputPipeline !== null &&
          (terminal.cols !== grid.cols || terminal.rows !== grid.rows)
        ) {
          applyTerminalGridAndKeepViewport({
            pipeline: outputPipeline,
            cols: grid.cols,
            rows: grid.rows,
            onGridApplied: updateGridVisibility,
            restoreViewport: () => {
              if (hasRestoredViewport && !hasManualScrollIntent) {
                restoreViewport(true);
              }
            },
          });
        }
      };
      const fitTerminal = () => {
        if (!fitAddon || !terminal) {
          return;
        }
        if (
          !initialRendererSettled ||
          !isPanelOpenRef.current ||
          document.visibilityState !== "visible" ||
          !hasVisibleTerminalSize({ containerElement })
        ) {
          return;
        }
        if (webglVisibilityRef.current?.sync() === false) return;
        const activeTerminal = terminal;
        const activeFitAddon = fitAddon;
        fitWork.run({
          container: containerElement,
          terminal: activeTerminal,
          ptyGrid: latestPtyGrid,
          layoutSettled: initialLayoutSettled,
          rendererSettled: initialRendererSettled,
          retainedOutputReplayed,
          work: () => {
            if (screenLoadingPreview)
              measureTerminalPerformance("terminal-fit-snapshot-refresh", () =>
                screenLoadingPreview?.refresh(
                  activeTerminal.options.lineHeight ?? 1,
                ),
              );
            updateGridVisibility();
            const fitted = measureTerminalPerformance(
              "terminal-fit-propose-dimensions",
              () => activeFitAddon.proposeDimensions(),
            );
            if (
              fitted === undefined ||
              !Number.isFinite(fitted.cols) ||
              !Number.isFinite(fitted.rows) ||
              fitted.cols <= 0 ||
              fitted.rows <= 0
            ) {
              return false;
            }
            if (
              localFitGrid?.cols !== fitted.cols ||
              localFitGrid.rows !== fitted.rows
            )
              fittedGridFallback = false;
            localFitGrid = { cols: fitted.cols, rows: fitted.rows };
            if (initialLayoutSettled) initialFitComplete = true;
            containerElement.dataset.fitGridCols = String(fitted.cols);
            containerElement.dataset.fitGridRows = String(fitted.rows);
            if (replayPreview)
              measureTerminalPerformance("terminal-fit-preview-layout", () =>
                replayPreview?.setFitGrid(fitted.cols, fitted.rows),
              );
            if (retainNativeOutput && sessionStatusRef.current === "exited") {
              if (retainedOutputReplayed) {
                retainedOutputGrid = latestPtyGrid;
                activeTerminal.resize(
                  retainedOutputGrid.cols,
                  retainedOutputGrid.rows,
                );
              }
              updateGridVisibility();
              return true;
            }
            updateGridVisibility();
            if (initialLayoutSettled && initialRendererSettled) {
              if (holdForFittedGrid && sessionStatusRef.current === "running") {
                rememberTerminalGrid(
                  session.id,
                  containerElement,
                  activeTerminal.options.fontSize ?? 13,
                  fitted,
                  activeTerminal.options.fontFamily ?? readTerminalFontFamily(),
                  activeTerminal.options.lineHeight ?? TERMINAL_LINE_HEIGHT,
                  Number(activeTerminal.options.fontWeight),
                );
              }
              const claimFit =
                holdForFittedGrid &&
                (containerElement.dataset.replayHeld === "true" ||
                  fittedGridRevealed) &&
                transport !== null &&
                (claimedFitGrid?.cols !== fitted.cols ||
                  claimedFitGrid.rows !== fitted.rows);
              if (transport)
                reconcilePrefetchedTerminalGrid(earlySocketUrl, fitted);
              transport?.sendResize(fitted.cols, fitted.rows, claimFit);
              if (claimFit) {
                if (claimedFitGrid === null)
                  markTerminalPerformance("terminal-first-fitted-grid-claimed");
                markTerminalPerformance("terminal-fitted-grid-claimed");
                claimedFitGrid = { ...fitted };
                prepareClaimedGrid();
              }
            }
            return true;
          },
        });
        checkReplayReveal?.();
      };
      const scheduleFit: TerminalFitScheduler = () => {
        if (resizeAnimationFrame !== null) {
          return;
        }
        resizeAnimationFrame = window.requestAnimationFrame(() => {
          resizeAnimationFrame = null;
          fitTerminal();
        });
      };
      function settleInitialRenderer() {
        if (disposed || terminal === null || initialRendererSettled) return;
        clearTimeout(rendererDeadline);
        initialRendererSettled = true;
        if (webglRenderer?.renderer === "dom") {
          webglVisibilityRef.current?.dispose();
          webglVisibilityRef.current = null;
          webglRenderer.dispose();
          webglRenderer = null;
        }
        markTerminalPerformance("terminal-initial-renderer-settled");
        measureTerminalPerformance(
          "terminal-initial-renderer-fit",
          fitTerminal,
        );
        markTerminalPerformance("terminal-initial-renderer-fit-end");
        resolveRendererSettled();
      }
      if (!initialRendererSettled) {
        rendererDeadline = setTimeout(
          settleInitialRenderer,
          TERMINAL_RENDERER_SETTLE_MS,
        );
        void initialRendererReady.then(() => {
          if (disposed) return;
          fitWork.invalidate();
          scheduleFit();
          if (
            initialRendererSettled ||
            webglRenderer === null ||
            webglRenderer.initialAttemptComplete
          ) {
            settleInitialRenderer();
          }
        });
      }
      fitTerminal();
      const fontSet = document.fonts;
      if (fontSet !== undefined) {
        void fontSet.ready.then(() => {
          if (!disposed)
            markTerminalPerformance("terminal-initial-fonts-ready");
        });
        stopObservingFonts = observeTerminalFontLoading(fontSet, () => {
          if (terminal === null) {
            return;
          }
          fitWork.invalidate();
          forceTerminalFontMeasurement(terminal);
          replayPreview?.refreshFonts();
          scheduleFit();
        });
      }
      scheduleFitRef.current = scheduleFit;
      resizeObserver = new ResizeObserver((entries) => {
        updateGridVisibility();
        const hasSize = hasVisibleTerminalSize({ containerElement, entries });
        if (hasSize !== containerHasSize) {
          containerHasSize = hasSize;
          reportDocumentVisibility();
        }
        if (!hasSize) {
          return;
        }
        scheduleFit();
      });
      resizeObserver.observe(containerElement);
      const currentActiveElement = document.activeElement;
      if (
        !terminalSearchOpenRef.current &&
        shouldFocusTerminalAfterAsyncMount({
          currentFocusIsAvailable:
            currentActiveElement !== null &&
            currentActiveElement !== document.body &&
            currentActiveElement.isConnected,
          hasExplicitFocusRequest: autoFocusRef.current,
          focusMovedDuringMount: currentActiveElement !== activeElementAtMount,
          isPanelOpen: isPanelOpenRef.current,
        })
      ) {
        terminal.focus();
        onAutoFocusHandledRef.current?.();
      }
      activeElementAtMount = null;

      const activeTerminal = terminal!;
      const getReplayState = () => ({
        hasReplaySurface: replayPreview !== null,
        replayStarted,
        replayCompleted,
        needsHistoryRestore: lastParsedOutputNextSeq === 0,
      });
      const routeQueuedExitNotice = (text: string) => {
        const state = getReplayState();
        routeTerminalExitNotice({
          hasReplaySurface: () => state.hasReplaySurface,
          isReplayStarted: () => state.replayStarted,
          isReplayComplete: () => state.replayCompleted,
          needsHistoryRestore: () => state.needsHistoryRestore,
          restoreTerminalHistory,
          pushReplay: (bytes) => replayPreview?.push(bytes, () => undefined),
          queueNotice: (notice) => pendingExitNotices.push(notice),
          text,
          writeTerminal: (notice) =>
            writeTerminalStatus({ terminal: activeTerminal, text: notice }),
        });
      };
      const restoreTerminalHistory = async () => {
        const output = await sdk.terminals.output({
          terminalId: sessionRef.current.id,
          tailBytes: 64 * 1024,
        });
        for (const chunk of output.chunks) {
          if (disposed) return;
          await new Promise<void>((resolve) => {
            const bytes = decodeBase64Bytes(chunk.dataBase64);
            if (outputPipeline) outputPipeline.push(bytes, resolve);
            else activeTerminal.write(bytes, resolve);
          });
          lastParsedOutputNextSeq = Math.max(
            lastParsedOutputNextSeq,
            chunk.seq + 1,
          );
        }
      };
      const routeExitNotice = createTerminalExitNoticeHandler({
        getLastStatusNotice: () => lastStatusNoticeRef.current,
        setLastStatusNotice: (status) => {
          lastStatusNoticeRef.current = status;
        },
        getReplayState: () => ({
          hasReplaySurface: replayPreview !== null,
          replayStarted,
          replayCompleted,
          needsHistoryRestore: lastParsedOutputNextSeq === 0,
        }),
        pushReplay: (bytes) => replayPreview?.push(bytes, () => undefined),
        queueNotice: (notice) => pendingExitNotices.push(notice),
        restoreTerminalHistory,
        writeTerminal: (text) =>
          writeTerminalStatus({ terminal: activeTerminal, text }),
      });
      let reconnecting = false;
      let reconnectingNoticeVisible = false;
      let outputFrameId: number | null = null;
      const clearConnectionNoticeTimeout = () => {
        if (connectionNoticeTimeout !== null) {
          clearTimeout(connectionNoticeTimeout);
          connectionNoticeTimeout = null;
        }
      };
      const resetTerminalOutput = () => {
        lastQueuedOutputNextSeq = 0;
        hiddenOutput.clear();
        outputLineAnchorTracker.reset();
        outputLineAnchors.length = 0;
        savedOutputLineAnchor = null;
        replayCheckpointSequence = null;
        replayPreview?.dispose();
        replayPreview = null;
        activeTerminal.reset();
        outputBoundaries.reset();
        parsingOutputSequence = null;
        outputLineAnchorTracker.reset();
      };
      const handleMessage = (
        message: TerminalServerMessage,
        replayWrite?: { bytes: Uint8Array; sourceBytes: Uint8Array },
        parseParkedOutput = false,
      ) => {
        if (message.type === "exited" || message.type === "error")
          retentionInvalidatedRef.current?.();
        if (message.type === "output") {
          if (
            !parseParkedOutput &&
            (terminalVisible !== true || !isPanelOpenRef.current)
          ) {
            hiddenOutput.push(message.chunk, lastQueuedOutputNextSeq);
            scheduleParkedOutput();
            return;
          }
          if (message.chunk.seq < lastQueuedOutputNextSeq) return;
          lastQueuedOutputNextSeq = message.chunk.seq + 1;
        }
        if (message.type === "attached") {
          replayRevealGeneration += 1;
          fittedGridHeld = false;
          fittedGridRevealed = false;
          fittedGridFallback = false;
          completeReplayReveal = null;
          if (hasReceivedInitialAttach) claimedFitGrid = null;
          checkReplayReveal = null;
          if (replayRevealTimeout !== null) clearTimeout(replayRevealTimeout);
          replayRevealTimeout = null;
          scheduleFit();
          replayTimingNextSeq = message.nextSeq;
          replayTimingFirstFrame = false;
        }
        if (
          message.type === "output" &&
          replayTimingNextSeq !== null &&
          message.chunk.seq < replayTimingNextSeq
        ) {
          if (!replayTimingFirstFrame) {
            replayTimingFirstFrame = true;
            markTerminalPerformance("terminal-replay-first-frame-received", {
              startTime: messageEventTimestamp,
              detail: { terminalId: session.id },
            });
          }
          if (message.chunk.seq + 1 === replayTimingNextSeq) {
            markTerminalPerformance("terminal-replay-last-frame-received", {
              startTime: messageEventTimestamp,
              detail: { terminalId: session.id },
            });
          }
        }
        if (
          message.type === "exited" ||
          ((message.type === "session-updated" ||
            message.type === "attached") &&
            message.session.status === "exited")
        ) {
          processExitedSeen = true;
        }
        if (message.type === "error") {
          if (
            processExitedSeen ||
            replayPreview === null ||
            replayCompleted ||
            message.code === "terminal_exited" ||
            message.code === "terminal_not_found" ||
            message.code === "terminal_not_running"
          ) {
            abandonReplayPreview();
          } else {
            retryStalledReplay();
          }
        }
        if (message.type === "exited") handleReplayPreviewExit();
        if (message.type === "output") {
          latestOutputSequence = Math.max(
            latestOutputSequence,
            message.chunk.seq,
          );
        }
        const currentOutputFrameId =
          message.type === "output" ? outputFrameId : null;
        if (message.type === "output") {
          outputFrameId = null;
          if (!replayCompleted) replayPreview?.noteProgress();
        }
        if (message.type === "attached" || message.type === "session-updated") {
          if (message.type === "attached") {
            hasReceivedInitialAttach = true;
          }
          const { cols, rows } = message.session;
          const isOwnNudgeEcho =
            message.type === "session-updated" &&
            activeTransport.consumeRepaintNudgeEcho(
              { cols, rows },
              message.resizeSeq,
            );
          latestPtyGrid = { cols, rows };
          updateGridVisibility();
          const nextSize = nextSharedTerminalSize(
            sharedSize,
            { cols, rows },
            isOwnNudgeEcho,
          );
          if (nextSize !== null) {
            sharedSize = nextSize;
            replayPreview?.resize(nextSize.cols, nextSize.rows);
            scheduleFit();
          } else {
            replayPreview?.resize(cols, rows);
          }
          if (message.session.status === "exited") {
            handleReplayPreviewExit();
          }
          if (
            message.type === "attached" ||
            !replayCompleted ||
            replayWriteState.suppressedWriteCount > 0
          ) {
            const changed =
              activeTerminal.cols !== cols || activeTerminal.rows !== rows;
            if (changed) {
              captureLiveViewportBeforeGridResize();
              activeTerminal.resize(cols, rows);
            }
            updateGridVisibility();
            if (changed) clearLiveViewportBeforeGridResize();
          } else if (outputPipeline) {
            applyTerminalGridAndKeepViewport({
              pipeline: outputPipeline,
              cols,
              rows,
              onGridApplied: updateGridVisibility,
              restoreViewport: () => {
                if (hasRestoredViewport && !hasManualScrollIntent) {
                  restoreViewport(true);
                }
              },
            });
          }
        }
        handleTerminalServerMessage({
          acknowledgeOutput: (nextSeq) => {
            lastParsedOutputNextSeq = Math.max(
              lastParsedOutputNextSeq,
              nextSeq,
            );
            activeTransport.acknowledgeOutput(nextSeq);
          },
          message,
          replayWrite,
          terminalId: session.id,
          onOutputFrameParsed: () => {
            if (
              message.type === "output" &&
              message.chunk.seq + 1 === replayTimingNextSeq
            ) {
              markTerminalPerformance("terminal-replay-primary-xterm-parsed", {
                detail: { terminalId: session.id },
              });
            }
            if (
              !disposed &&
              hasReceivedInitialAttach &&
              outputPipeline &&
              (activeTerminal.cols !== latestPtyGrid.cols ||
                activeTerminal.rows !== latestPtyGrid.rows)
            ) {
              applyTerminalGridAndKeepViewport({
                pipeline: outputPipeline,
                cols: latestPtyGrid.cols,
                rows: latestPtyGrid.rows,
                onGridApplied: updateGridVisibility,
                restoreViewport: () => {
                  if (hasRestoredViewport && !hasManualScrollIntent) {
                    restoreViewport(true);
                  }
                },
              });
            }
            if (
              document.visibilityState !== "visible" ||
              !containerHasSize ||
              !isPanelOpenRef.current
            ) {
              cancelTerminalOutputNextRenders(session.id);
            }
          },
          onReplayComplete: () => {
            replayCompleted = true;
            scheduleParkedOutput();
            prepareClaimedGrid();
            markTerminalPerformance("terminal-replay-screens-parsed");
            const revealReplay = () => {
              pendingReplayRevealRef.current = session.id;
              markTerminalPerformance("terminal-replay-parsed", {
                detail: { terminalId: session.id },
              });
              setRestoringSession(false);
              keepScreenLoadingPreview = false;
              clearScreenLoadingPreview();
              containerElement.dataset.replayHeld = "false";
              if (needsFittedGrid() && fittedGridReady()) {
                replayPreview?.dispose();
                replayPreview = null;
              }
              activeTransport.resetRetryBackoff();
              for (const text of pendingExitNotices.splice(0)) {
                routeQueuedExitNotice(text);
              }
              completeTerminalReplayPreview({
                hasPendingExit: exitedBeforeReplayCompleted,
                markExitApplied: () => {
                  replayPreviewExitApplied = true;
                },
                clearPendingExit: () => {
                  exitedBeforeReplayCompleted = false;
                },
                releasePreview: releaseReplayPreview,
                processExited: () => replayPreview?.processExited(),
              });
              applyTerminalGridBeforeViewportRestore({
                pipeline: outputPipeline,
                cols: latestPtyGrid.cols,
                rows: latestPtyGrid.rows,
                onGridApplied: updateGridVisibility,
                restoreViewport,
                afterRestore: () => {
                  if (!disposed)
                    activeTerminal.refresh(0, activeTerminal.rows - 1);
                },
              });
            };
            if (needsFittedGrid() && !fittedGridFallback) {
              completeReplayReveal = revealReplay;
              replayPreview?.hold({ countdown: false });
              holdFittedGrid();
              checkReplayReveal?.();
            } else revealReplay();
          },
          onSessionChange: (updatedSession) => {
            if (message.type === "attached")
              measureTerminalPerformance(
                "terminal-attached-session-change",
                () => onSessionChangeRef.current?.(updatedSession),
              );
            else onSessionChangeRef.current?.(updatedSession);
          },
          onOutputStart: recordOutputStart,
          onOutputParsed: (sequence) => {
            if (sequence + 1 === replayTimingNextSeq) {
              markTerminalPerformance("terminal-replay-last-xterm-callback", {
                detail: { terminalId: session.id },
              });
            }
            const savedSequence = savedViewportAnchor?.outputSequence;
            if (
              savedSequence !== undefined &&
              sequence >= savedSequence &&
              savedOutputLineAnchor === null
            ) {
              updateSavedOutputLineAnchor(
                outputLineAnchors.find(
                  (candidate) => candidate.sequence === savedSequence,
                ) ?? null,
              );
            }
          },
          replayNextSeq,
          replayWriteState,
          outputFrameId: currentOutputFrameId ?? undefined,
          onReplayStart: () => {
            replayStarted = true;
            setRestoringSession(true);
            containerElement.dataset.replayHeld = "true";
            viewportReplaySaveGate.beginReplay();
            replayCompleted = false;
            replayPreviewExitApplied = false;
            setReplayNotice(paintedScreenKept ? "reconnecting" : null);
            if (replayPreview === null || replayPreview.fallback) {
              replayPreview?.dispose();
              replayCheckpointSequence = null;
              const replayGrid = latestPtyGrid;
              markTerminalPerformance("terminal-replay-preview-create-start");
              const previewTerminal = new Terminal({
                ...TERMINAL_THEME_OPTIONS,
                allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
                cols: replayGrid.cols,
                rows: replayGrid.rows,
                ...terminalFontOptions,
                theme: activeTerminal.options.theme,
              });
              previewTerminal.loadAddon(new Unicode11Addon());
              previewTerminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
              replayPreview = mountTerminalReplayPreview({
                container: containerElement,
                holdUntilReleased: true,
                onHoldExpired: () => retryStalledReplay(),
                initialFitGrid: localFitGrid,
                isOwner: () =>
                  terminalInputClaimed &&
                  document.hasFocus() &&
                  activeTerminal.element?.contains(document.activeElement) ===
                    true,
                liveTerminal: activeTerminal,
                paddingLeft,
                readyToPaint: () =>
                  initialRendererSettled &&
                  document.fonts?.status !== "loading",
                terminal: previewTerminal,
              });
              replayPreview.setPtyGrid(replayGrid.cols, replayGrid.rows);
              markTerminalPerformance("terminal-replay-preview-create-end");
              if (paintedScreenKept) keepPaintedScreen();
            }
          },
          setReplayNextSeq: (nextSeq) => {
            replayNextSeq = nextSeq;
            if (nextSeq !== null) replayNextSequence = nextSeq;
          },
          setReplayStartSequence: (sequence) => {
            replayStartSequence = sequence;
            latestOutputSequence = Math.max(latestOutputSequence, sequence);
            startTerminalOutputReplay({
              outputLineAnchors,
              sequence,
              tracker: outputLineAnchorTracker,
            });
          },
          terminal: activeTerminal,
          pipeline: outputPipeline ?? undefined,
          replayPipeline: replayPreview ?? undefined,
          replayCheckpointSequence,
          writeExitNotice: routeExitNotice,
          outputBoundaries,
          allowAttachedGrid: false,
          shouldProcessOutput: () =>
            parseParkedOutput ||
            (terminalVisible === true && isPanelOpenRef.current),
        });
        if (
          message.type === "output" &&
          message.chunk.seq + 1 === replayTimingNextSeq
        ) {
          markTerminalPerformance("terminal-replay-last-frame-dispatched", {
            detail: { terminalId: session.id },
          });
        }
      };
      const activeTransport = new TerminalWebSocketTransport({
        createSocket: createPrefetchedTerminalSocket,
        terminalId: session.id,
        now: () => performance.now(),
        onInputAccepted: recordTerminalInputAccepted,
        onInputSent: recordTerminalInputWebSocketSent,
        onOutputFrameReceived: (terminalId, timestamp) => {
          outputFrameId = recordTerminalOutputReceived(terminalId, timestamp);
        },
        onMessageEvent: (timestamp) => {
          const now = performance.now();
          messageEventTimestamp =
            timestamp >= 0 && timestamp <= now ? timestamp : now;
        },
        onRepaintNudgeSizeReleased: (size) => {
          const nextSize = nextSharedTerminalSize(sharedSize, size, false);
          if (nextSize !== null) {
            sharedSize = nextSize;
            if (!markerGridActive) {
              latestPtyGrid = nextSize;
              if (outputPipeline) {
                applyTerminalGridAndKeepViewport({
                  pipeline: outputPipeline,
                  cols: nextSize.cols,
                  rows: nextSize.rows,
                  onGridApplied: updateGridVisibility,
                  restoreViewport: () => {
                    if (hasRestoredViewport && !hasManualScrollIntent) {
                      restoreViewport(true);
                    }
                  },
                });
              }
            }
            scheduleFit();
          }
        },
        onSocketError: () => retentionInvalidatedRef.current?.(),
        onConnectionState: (state) => {
          if (disposed) {
            return;
          }
          fitWork.invalidate();
          if (state === "reconnecting" || state === "closed")
            retentionInvalidatedRef.current?.();
          if (state === "closed") abandonReplayPreview();
          if (
            state === "reconnecting" &&
            !replayCompleted &&
            replayPreview?.fallback === true
          ) {
            replayPreview.hold({ countdown: false });
            setReplayNotice(paintedScreenKept ? "reconnecting" : null);
          }
          if (state === "reconnecting") {
            if (terminalVisible === false) hiddenOutput.invalidate();
            if (reconnecting) {
              return;
            }
            reconnecting = true;
            clearConnectionNoticeTimeout();
            setConnectionNotice(null);
            connectionNoticeTimeout = setTimeout(() => {
              connectionNoticeTimeout = null;
              fitWork.invalidate();
              reconnectingNoticeVisible = true;
              setConnectionNotice("reconnecting");
            }, TERMINAL_RECONNECTING_NOTICE_DELAY_MS);
            return;
          }
          reconnecting = false;
          clearConnectionNoticeTimeout();
          if (state === "attached" && reconnectingNoticeVisible) {
            setConnectionNotice("reconnected");
            connectionNoticeTimeout = setTimeout(() => {
              connectionNoticeTimeout = null;
              setConnectionNotice(null);
            }, TERMINAL_RECONNECTED_NOTICE_DURATION_MS);
          } else {
            setConnectionNotice(null);
          }
          reconnectingNoticeVisible = false;
        },
        onInputOverflow: (maxBytes) => {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: `Terminal input queue is full (${maxBytes} bytes); input was not sent`,
          });
        },
        onInvalidMessage: () => {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Terminal received an invalid server message",
          });
        },
        onMessage: handleMessage,
        onReplayBatch: (chunks) => {
          if (terminalVisible !== true || !isPanelOpenRef.current) {
            for (const chunk of chunks)
              hiddenOutput.push(chunk, lastQueuedOutputNextSeq);
            scheduleParkedOutput();
            return;
          }
          markTerminalPerformance("terminal-replay-batch-dispatch-start");
          measureTerminalPerformance("terminal-replay-batch-dispatch", () => {
            for (const write of terminalReplayWrites(
              chunks,
              outputBoundaries,
              replayCheckpointSequence,
            )) {
              handleMessage({ type: "output", chunk: write.chunk }, write);
            }
          });
        },
        onSequenceGap: () => {
          if (terminalVisible !== true || !isPanelOpenRef.current) {
            hiddenOutput.invalidate();
            return;
          }
          resetTerminalOutput();
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Some terminal output was unavailable after reconnect",
          });
        },
        shouldReconnect: () =>
          !disposed && sessionStatusRef.current === "running",
        url: buildTerminalWebSocketUrl({
          handoffOwnerToken:
            wsManager.getDeviceHandoffClientToken() ?? handoffOwnerToken,
          terminalId: session.id,
        }),
      });
      transport = activeTransport;
      const drainParkedOutput = async () => {
        parkedOutputTimer = null;
        if (disposed || !parkedRef.current || !replayCompleted) return;
        parkedOutputDraining = true;
        const started = performance.now();
        try {
          do {
            const chunks = hiddenOutput.takeBatch(8 * 1024);
            if (chunks.length === 0) break;
            for (const write of terminalReplayWrites(
              chunks,
              outputBoundaries,
              replayCheckpointSequence,
            )) {
              handleMessage(
                { type: "output", chunk: write.chunk },
                write,
                true,
              );
            }
            if (outputPipeline)
              await new Promise<void>((resolve) =>
                outputPipeline!.whenParsed(resolve),
              );
          } while (
            !disposed &&
            parkedRef.current &&
            performance.now() - started < 4
          );
        } finally {
          parkedOutputDraining = false;
          scheduleParkedOutput(0);
        }
      };
      const scheduleParkedOutput = (delay = 250) => {
        if (
          parkedOutputTimer !== null ||
          parkedOutputDraining ||
          !replayCompleted ||
          !hiddenOutput.hasPending ||
          disposed ||
          !parkedRef.current
        )
          return;
        parkedOutputTimer = setTimeout(() => {
          void drainParkedOutput();
        }, delay);
      };
      parkTransportRef.current = (nextParked) => {
        markTerminalPerformance(
          nextParked ? "terminal-view-parked" : "terminal-view-adopted",
          { detail: { terminalId: session.id } },
        );
        activeTransport.setParked(nextParked);
        if (nextParked) scheduleParkedOutput();
        else if (parkedOutputTimer !== null) {
          clearTimeout(parkedOutputTimer);
          parkedOutputTimer = null;
        }
        webglVisibilityRef.current?.sync();
        reportDocumentVisibility();
      };
      if (parkedRef.current) {
        activeTransport.setParked(true);
        scheduleParkedOutput();
      }
      flushHiddenOutput = () => {
        const chunks = hiddenOutput.take();
        if (chunks === null) {
          activeTransport.replayOutputFrom(lastQueuedOutputNextSeq);
          return;
        }
        const replayEnd = replayNextSeq;
        const firstLive =
          replayEnd === null
            ? -1
            : chunks.findIndex((chunk) => chunk.seq >= replayEnd);
        const groups =
          firstLive > 0
            ? [chunks.slice(0, firstLive), chunks.slice(firstLive)]
            : [chunks];
        for (const group of groups) {
          for (const write of terminalReplayWrites(
            group,
            outputBoundaries,
            replayCheckpointSequence,
          )) {
            handleMessage({ type: "output", chunk: write.chunk }, write);
          }
        }
      };
      claimSizeRef.current = () => {
        terminalInputClaimed = true;
        activeTerminal.focus();
        clearTimeout(rendererDeadline);
        initialRendererSettled = true;
        initialLayoutSettled = true;
        resolveRendererSettled();
        activeTransport.markLayoutSettled();
        activeTransport.claimSize(true);
        fitTerminal();
      };
      retryStalledReplay = () => {
        if (processExitedSeen || exitedBeforeReplayCompleted) {
          abandonReplayPreview();
          return;
        }
        keepPaintedScreen();
        activeTransport.retry();
      };
      fitTerminal();
      reportDocumentVisibility();
      sizeClaims = listenForTerminalSizeClaims({
        claim: (reclaim) => {
          if (parkedRef.current || restoringFocusRef.current) return;
          returningRef.current = false;
          activeTransport.claimSize(reclaim);
        },
        element: containerElement,
        textarea: activeTerminal.textarea,
      });
      sizeClaims.claimIfFocused();
      document.addEventListener("visibilitychange", reportDocumentVisibility);
      if (holdForFittedGrid && sessionStatusRef.current === "running") {
        activeTransport.start();
      }
      stopWatchingLayout = watchTerminalLayoutSettled({
        graceFrames: holdForFittedGrid ? 0 : 8,
        stableFramesRequired: holdForFittedGrid ? 1 : 2,
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        measure: () => {
          const rect = containerElement.getBoundingClientRect();
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            hasRunningLayoutAnimation(containerElement) ||
            document.fonts?.status === "loading"
          ) {
            return null;
          }
          if (holdForFittedGrid) return `${rect.width}x${rect.height}`;
          if (
            !initialRendererSettled ||
            !isPanelOpenRef.current ||
            document.visibilityState !== "visible"
          )
            return null;
          const fitted = fitAddon?.proposeDimensions();
          if (
            fitted === undefined ||
            !Number.isFinite(fitted.cols) ||
            !Number.isFinite(fitted.rows)
          ) {
            return null;
          }
          return `${rect.width}x${rect.height}:${fitted?.cols}x${fitted?.rows}`;
        },
        onSettled: () => {
          if (disposed) {
            return;
          }
          captureLiveViewportBeforeGridResize();
          initialLayoutSettled = true;
          markTerminalPerformance("terminal-initial-layout-settled");
          measureTerminalPerformance(
            "terminal-initial-layout-fit",
            fitTerminal,
          );
          activeTransport.markLayoutSettled();
          if (hasRestoredViewport && !hasManualScrollIntent) {
            restoreViewport(true);
          }
          clearLiveViewportBeforeGridResize();
        },
        ready: document.fonts?.ready,
        settleReady: holdForFittedGrid ? rendererSettled : undefined,
        subscribe: (onSignal) =>
          observeLayoutSignals({
            affectsContainer: (target) =>
              target instanceof Node && target.contains(containerElement),
            document,
            fontSet: document.fonts,
            onSignal,
          }),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
      });
      if (
        sessionRef.current.status === "exited" ||
        pendingExitNotices.length > 0
      ) {
        let retainedReplayFailed = false;
        const revealRetainedFallback = () => {
          if (disposed || retainedReplayFailed) return;
          retainedReplayFailed = true;
          retainedOutputReplayed = true;
          fitTerminal();
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Terminal history unavailable",
          });
          writeTerminalSessionStatusNotice({
            lastNotice: lastStatusNoticeRef,
            session: sessionRef.current,
            terminal: activeTerminal,
          });
        };
        try {
          const outputPromise = sdk.terminals.output({
            terminalId: sessionRef.current.id,
            tailBytes: 64 * 1024,
          });
          retainedReplayTimeout = setTimeout(() => {
            retainedReplayTimeout = null;
            revealRetainedFallback();
          }, TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS);
          const output = await outputPromise;
          if (!disposed) {
            if (retainedReplayFailed) {
              resetTerminalOutput();
              lastStatusNoticeRef.current = null;
              pendingExitNotices.length = 0;
              retainedReplayFailed = false;
            }
            await writeRetainedTerminalOutput({
              chunks: output.chunks.map((chunk) => ({
                seq: chunk.seq,
                data: decodeBase64Bytes(chunk.dataBase64),
              })),
              retainNativeOutput,
              lastNotice: lastStatusNoticeRef,
              session: sessionRef.current,
              terminal: activeTerminal,
              pipeline: outputPipeline ?? undefined,
              onOutputStart: recordOutputStart,
              onOutputParsed: (sequence) => {
                const outputAnchor = outputLineAnchors.find(
                  (candidate) => candidate.sequence === sequence,
                );
                if (sequence === savedViewportAnchor?.outputSequence) {
                  updateSavedOutputLineAnchor(outputAnchor ?? null);
                }
              },
            });
            if (disposed) return;
            if (retainNativeOutput) {
              retainedOutputReplayed = true;
              fitTerminal();
            }
            flushPendingExitNotices();
            replayStartSequence = output.chunks[0]?.seq ?? output.nextSeq;
            latestOutputSequence = output.chunks.at(-1)?.seq ?? output.nextSeq;
            replayNextSequence = output.nextSeq;
            restoreViewport();
          }
        } catch {
          revealRetainedFallback();
        } finally {
          if (retainedReplayTimeout !== null) {
            clearTimeout(retainedReplayTimeout);
            retainedReplayTimeout = null;
          }
        }
      } else if (!holdForFittedGrid) {
        void (async () => {
          try {
            const snapshot = await screenPromise;
            if (
              !disposed &&
              !replayStarted &&
              !replayCompleted &&
              snapshot !== null &&
              snapshot.complete &&
              !snapshot.truncated &&
              snapshot.dataBase64 !== undefined &&
              snapshot.checkpointSeq !== undefined &&
              snapshot.cols === latestPtyGrid.cols &&
              snapshot.gridRows === latestPtyGrid.rows
            ) {
              const previewTerminal = new Terminal({
                ...TERMINAL_THEME_OPTIONS,
                allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
                cols: snapshot.cols,
                rows: snapshot.gridRows,
                ...terminalFontOptions,
                theme: buildTerminalTheme(),
              });
              previewTerminal.loadAddon(new Unicode11Addon());
              previewTerminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
              replayPreview = mountTerminalReplayPreview({
                container: containerElement,
                initialFitGrid: localFitGrid,
                isOwner: () =>
                  terminalInputClaimed &&
                  document.hasFocus() &&
                  activeTerminal.element?.contains(document.activeElement) ===
                    true,
                liveTerminal: activeTerminal,
                paddingLeft,
                readyToPaint: () =>
                  initialRendererSettled &&
                  document.fonts?.status !== "loading",
                terminal: previewTerminal,
              });
              replayCheckpointSequence = snapshot.checkpointSeq;
              const snapshotFrame = decodeBase64Bytes(snapshot.dataBase64);
              await new Promise<void>((resolve) =>
                replayPreview?.push(snapshotFrame, resolve),
              );
            }
          } catch {
            if (!replayStarted) {
              replayCheckpointSequence = null;
              replayPreview?.dispose();
              replayPreview = null;
            }
          }
        })();
        activeTransport.start();
      }
      if (disposed) return;
      const sendTerminalInput = (
        dataBase64: string,
        inputEventAt?: number,
        isUserInput = true,
      ) => activeTransport.sendInput(dataBase64, inputEventAt, isUserInput);
      handleFileDropRef.current = (files) => {
        const desktop = window.bbDesktop;
        handleTerminalFileDrop({
          files: Array.from(files),
          getPathForFile: desktop?.getPathForFile,
          isRunning: sessionStatusRef.current === "running",
          sendInput: (input) =>
            forwardTerminalData({
              data: input,
              isUserInput: true,
              onInput: sendTerminalInput,
              onUserInput: onUserInputRef.current,
              replayWriteState,
              sessionStatus: sessionStatusRef.current,
            }),
        });
      };
      terminalInteractions = attachTerminalInteractions({
        element: containerElement.parentElement ?? containerElement,
        getSelection: () => activeTerminal.getSelection(),
        onPointerDown: (event) => {
          if (
            event.target instanceof Node &&
            activeTerminal.element?.contains(event.target)
          ) {
            terminalInputClaimed = true;
            lastUserInputAtRef.current = Date.now();
            updateGridVisibility();
          }
          handleTerminalPointerDown(event);
        },
        onPointerRelease: (event) => {
          if (pointerIsDownRef.current) lastUserInputAtRef.current = Date.now();
          handleTerminalPointerRelease(event);
        },
        onPointerCancel: handleTerminalPointerCancel,
        onSelection: (text) => {
          if (terminalSearchOpenRef.current) return;
          reportTerminalSelection(lastPointerReleaseAnchorRef.current, text);
        },
        copySelection: (text) => {
          if (copyOnSelectRef.current && !terminalSearchOpenRef.current) {
            copyTerminalSelectionOnSelect(text);
          }
        },
        onFilesDrop: (files) => handleFileDropRef.current?.(files),
      });
      terminalKeyDisposable = activeTerminal.onKey(() => {
        if (!terminalInputClaimed) {
          terminalInputClaimed = true;
          updateGridVisibility();
        }
        clearAttentionOnInputRef.current();
      });
      terminalInputForwarding = attachTerminalInputForwarding({
        onData: (data, isUserInput) => {
          const inputEventAt = isUserInput ? performance.now() : undefined;
          if (isUserInput) {
            lastUserInputAtRef.current = Date.now();
            clearAttentionOnInputRef.current();
          }
          if (controlActiveRef.current) {
            data = applyTerminalControl(data);
            controlActiveRef.current = false;
            setControlActive(false);
          }
          forwardTerminalData({
            data,
            inputEventAt,
            isUserInput,
            onInput: sendTerminalInput,
            onUserInput: onUserInputRef.current,
            replayWriteState,
            sessionStatus: sessionStatusRef.current,
          });
        },
        terminal: activeTerminal,
      });
      setTerminalReady(true);
      activeTerminal.onTitleChange((title) => {
        if (replayWriteState.suppressedWriteCount > 0) {
          return;
        }
        if (sessionStatusRef.current !== "running") {
          return;
        }
        onTitleChangeRef.current?.(title);
      });
      selectionChangeDisposable = activeTerminal.onSelectionChange(
        terminalInteractions.onSelectionChange,
      );
    }

    void mountTerminal(container).catch((error) => {
      discardPrefetchedTerminalSocket(earlySocketUrl);
      clearScreenLoadingPreview();
      if (!disposed) {
        setRestoringSession(false);
        container.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });

    return () => {
      disposed = true;
      if (parkedOutputTimer !== null) clearTimeout(parkedOutputTimer);
      hiddenOutput.clear();
      flushHiddenOutput = () => {};
      clearScreenLoadingPreview();
      outputLineAnchorTracker.dispose();
      viewportLineAnchor?.dispose();
      viewportLineAnchor = null;
      controlActiveRef.current = false;
      setControlActive(false);
      setTerminalReady(false);
      setTerminalSearchAddon(null);
      setTerminalSearchOpen(false);
      stopObservingFonts?.();
      stopWatchingLayout?.();
      detachViewportListeners?.();
      sizeClaims?.dispose();
      checkReplayReveal = null;
      if (replayRevealTimeout !== null) clearTimeout(replayRevealTimeout);
      sizeClaims = null;
      if (resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      if (liveBottomResizeClearFrame !== null) {
        window.cancelAnimationFrame(liveBottomResizeClearFrame);
      }
      if (connectionNoticeTimeout !== null) {
        clearTimeout(connectionNoticeTimeout);
      }
      if (retainedReplayTimeout !== null) {
        clearTimeout(retainedReplayTimeout);
      }
      setConnectionNotice(null);
      resizeObserver?.disconnect();
      replayPreview?.dispose();
      replayPreview = null;
      detachPointerCoordinates?.();
      detachPointerCoordinates = null;
      detachGridVisibilityListeners?.();
      detachGridVisibilityListeners = null;
      selectionChangeDisposable?.dispose();
      terminalKeyDisposable?.dispose();
      terminalKeyDisposable = null;
      terminalInputForwarding?.dispose();
      terminalInputForwarding = null;
      shellOscDisposable?.dispose();
      terminalProgressDisposable?.dispose();
      osc52Disposable?.dispose();
      outputBoundaryDisposable?.dispose();
      terminalInteractions?.dispose();
      terminalRenderSubscription?.dispose();
      terminalRenderSubscription = null;
      terminalResizeSubscription?.dispose();
      terminalResizeSubscription = null;
      cancelTerminalOutputNextRenders(session.id);
      handleFileDropRef.current = null;
      if (reportDocumentVisibilityRef.current === reportDocumentVisibility) {
        reportDocumentVisibilityRef.current = null;
      }
      document.removeEventListener(
        "visibilitychange",
        reportDocumentVisibility,
      );
      parkTransportRef.current = null;
      transport?.dispose();
      discardPrefetchedTerminalSocket(earlySocketUrl);
      webglVisibilityRef.current?.dispose();
      webglVisibilityRef.current = null;
      clearTimeout(rendererDeadline);
      disposeTerminalWithRenderer(terminal, webglRenderer);
      terminalRef.current = null;
      scheduleFitRef.current = null;
      if (terminalVisibilityReporterRef.current === reportDocumentVisibility) {
        terminalVisibilityReporterRef.current = null;
      }
    };
  }, [
    copyTerminalContextValue,
    pasteFromClipboard,
    reportTerminalSelection,
    copyTerminalSelection,
    copyTerminalSelectionOnSelect,
    handleTerminalPointerDown,
    handleTerminalPointerRelease,
    handleTerminalPointerCancel,
    jumpToPrompt,
    requestOpenTerminalLink,
    retainNativeOutput,
    session.id,
    session.threadId,
    handoffOwnerToken,
    updateHoveredTerminalLink,
  ]);

  useEffect(() => {
    const panelWasOpen = previousPanelOpenRef.current;
    previousPanelOpenRef.current = isPanelOpen;
    if (panelWasOpen === isPanelOpen) return;
    reportDocumentVisibilityRef.current?.();
  }, [isPanelOpen]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!isTouchDevice || terminal?.element == null) return;
    const compositionInputGuard = suppressDuplicateTerminalCompositionInput(
      terminal.element.parentElement ?? terminal.element,
      (data) => terminal.input(data),
    );
    compositionInputGuardRef.current = compositionInputGuard;
    return () => {
      compositionInputGuard.dispose();
      compositionInputGuardRef.current = null;
    };
  }, [isTouchDevice, terminalReady]);

  useEffect(() => {
    if (!isPanelOpen) {
      cancelTerminalOutputNextRenders(session.id);
    }
    if (!isPanelOpen || !autoFocus) {
      return;
    }
    const terminal = terminalRef.current;
    if (terminal !== null && !terminalSearchOpenRef.current) {
      restoringFocusRef.current = returningRef.current;
      try {
        terminal.focus();
      } finally {
        restoringFocusRef.current = false;
      }
      onAutoFocusHandledRef.current?.();
    }
    scheduleFitRef.current?.();
  }, [autoFocus, isPanelOpen, session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    scheduleFitRef.current?.();
    if (session.status === "exited") {
      return;
    }
    writeTerminalSessionStatusNotice({
      lastNotice: lastStatusNoticeRef,
      session,
      terminal,
    });
  }, [session]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    applyTerminalFontFamily(terminal, readTerminalFontFamily(), () =>
      scheduleFitRef.current?.(),
    );
    terminal.options.theme = buildTerminalTheme();
  }, [preferredTheme, appThemeEpoch]);

  const sentThemeColorsRef = useRef("");
  const themeControllerRef = useRef("");
  const themeSendPendingRef = useRef(false);
  const syncThemeColorsRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !terminalReady || !handoffOwnerToken) return;
    const viewerKey = JSON.stringify([session.id, handoffOwnerToken]);
    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (
          disposed ||
          parkedRef.current ||
          themeSendPendingRef.current ||
          (themeControllerRef.current !== viewerKey &&
            (!document.hasFocus() ||
              !terminal.element?.contains(document.activeElement)))
        )
          return;
        const colors = terminalThemeDefaultColors(terminal.options.theme ?? {});
        if (!colors) return;
        const key = JSON.stringify([session.id, handoffOwnerToken, colors]);
        if (key === sentThemeColorsRef.current) return;
        themeSendPendingRef.current = true;
        attempts++;
        void sdk.terminals
          .experimental_setDefaultColors({
            terminalId: session.id,
            viewerToken: handoffOwnerToken,
            ...colors,
          })
          .then(() => {
            sentThemeColorsRef.current = key;
            themeControllerRef.current = viewerKey;
          })
          .catch(() => {
            themeControllerRef.current = "";
            if (!disposed && attempts < 2) sync();
          })
          .finally(() => {
            themeSendPendingRef.current = false;
            if (disposed) syncThemeColorsRef.current?.();
          });
      }, 100);
    };
    const release = () => {
      sentThemeColorsRef.current = "";
      attempts = 0;
    };
    syncThemeColorsRef.current = sync;
    sync();
    terminal.element?.addEventListener("focusin", sync);
    terminal.element?.addEventListener("focusout", release);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", release);
    return () => {
      disposed = true;
      syncThemeColorsRef.current = null;
      clearTimeout(timer);
      terminal.element?.removeEventListener("focusin", sync);
      terminal.element?.removeEventListener("focusout", release);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", release);
    };
  }, [
    preferredTheme,
    appThemeEpoch,
    terminalReady,
    handoffOwnerToken,
    session.id,
  ]);

  const connectionNoticeText =
    session.status === "disconnected"
      ? "Terminal disconnected"
      : connectionNotice === "reconnecting"
        ? "Reconnecting…"
        : connectionNotice === "reconnected"
          ? "Reconnected"
          : replayNotice === "reconnecting"
            ? "Reconnecting…"
            : replayNotice === "unavailable"
              ? "Terminal output unavailable"
              : restoringSession
                ? "Restoring session…"
                : null;
  useEffect(() => {
    webglVisibilityRef.current?.sync();
    terminalVisibilityReporterRef.current?.();
  }, [isPanelOpen]);

  const gestureTouches = (
    touches: ArrayLike<{
      identifier: number;
      clientX: number;
      clientY: number;
    }>,
  ): TerminalGestureTouch[] =>
    Array.from(touches, (touch) => ({
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
    }));
  const stopRetainedHistoryTouchPropagation = (
    event: ReactTouchEvent<HTMLDivElement>,
  ) => {
    if (
      retainNativeOutput &&
      session.status === "exited" &&
      getMediaQuerySnapshot(COMPACT_VIEWPORT_QUERY)
    ) {
      event.stopPropagation();
    }
  };
  useEffect(() => {
    const metrics = readTerminalFontMetrics();
    const size = metrics.fontSize;
    if (terminalRef.current)
      terminalRef.current.options.fontWeight = metrics.fontWeight;
    const previousDefault = defaultFontSizeRef.current;
    defaultFontSizeRef.current = size;
    if (terminalFontSizeRef.current !== previousDefault) return;
    terminalFontSizeRef.current = size;
    setTerminalFontSize(size);
    if (terminalRef.current !== null) {
      terminalRef.current.options.fontSize = size;
      scheduleFitRef.current?.();
    }
  }, [isCompactViewport, preferredTheme, appThemeEpoch]);

  const ensurePinchGesture = () => {
    pinchGestureRef.current ??= createTerminalPinchGesture({
      getFontSize: () => terminalFontSizeRef.current,
      setFontSize: (requestedSize) => {
        const size = Math.max(12, requestedSize);
        if (size === terminalFontSizeRef.current) return;
        terminalFontSizeRef.current = size;
        setTerminalFontSize(size);
        const terminal = terminalRef.current;
        if (terminal !== null) {
          terminal.options.fontSize = size;
          terminal.refresh(0, terminal.rows - 1);
        }
      },
      fitAndResize: () => scheduleFitRef.current?.(),
    });
    return pinchGestureRef.current;
  };
  const beginTerminalLongPress = (
    touches: ArrayLike<{
      identifier: number;
      clientX: number;
      clientY: number;
    }>,
  ) => {
    longPressGestureRef.current?.cancel();
    const points = gestureTouches(touches);
    longPressGestureRef.current = startTerminalLongPress(
      points,
      (point) => {
        const terminal = terminalRef.current;
        const screen =
          terminal?.element?.querySelector<HTMLElement>(".xterm-screen");
        if (
          terminal === null ||
          terminal === undefined ||
          screen === null ||
          screen === undefined
        ) {
          return 0;
        }
        const bounds = screen.getBoundingClientRect();
        const rowHeight = bounds.height / Math.max(1, terminal.rows);
        const row = Math.floor((point.y - bounds.top) / rowHeight);
        return (
          terminal.buffer.active.viewportY +
          Math.max(0, Math.min(terminal.rows - 1, row))
        );
      },
      (bufferLine) => {
        const terminal = terminalRef.current;
        if (terminal === null) return;
        setTextSnapshotInitialLine(
          terminalTextSnapshotLineIndex(terminal, bufferLine),
        );
        setTextSnapshot(terminalTextSnapshot(terminal));
      },
      (callback, delay) => {
        const id = window.setTimeout(callback, delay);
        return { cancel: () => window.clearTimeout(id) };
      },
    );
  };
  const contextMenuLink = contextMenuState.link;
  const contextMenuSelectionText = contextMenuState.selectionText;
  return (
    <div
      ref={viewRef}
      className="relative flex h-full min-h-0 flex-col"
      data-app-terminal=""
      onKeyDownCapture={handleTerminalCommandKeyDown}
    >
      {connectionNoticeText !== null ? (
        <div
          role="status"
          data-terminal-restoring={
            connectionNoticeText === "Restoring session…" ? "" : undefined
          }
          style={{ position: "absolute" }}
          className={`pointer-events-none right-2 top-1 z-10 max-w-full rounded-md bg-sidebar px-2 py-1 text-xs shadow-sm ${connectionNoticeText === "Restoring session…" ? "text-muted-foreground" : "text-foreground"}`}
        >
          {connectionNoticeText}
        </div>
      ) : null}
      {terminalReady && !restoringSession && showFitControl ? (
        <div
          style={{ position: "absolute" }}
          className={`right-2 z-10 flex items-center justify-end gap-2 rounded-md bg-sidebar px-2 py-1 text-xs shadow-sm ${connectionNoticeText === null ? "top-1" : "top-10"}`}
        >
          <button
            type="button"
            data-compact-touch="code"
            className="shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-state-hover"
            onClick={() => claimSizeRef.current?.()}
          >
            Fit to this screen
          </button>
        </div>
      ) : null}
      <ContextMenu
        open={!parked && contextMenuOpen}
        onOpenChange={(open) => {
          setContextMenuOpen(open);
          if (!open) {
            setContextMenuState({ link: null, selectionText: "" });
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <TerminalAttentionPane
            attention={session.attention}
            bannerOnly={attentionShownAsBanner}
            className={`group/terminal-pane relative min-h-0 w-full flex-1 overflow-hidden bg-sidebar pt-2 md:pt-4 ${isTouchDevice ? (showFitControl || (retainNativeOutput && session.status === "exited") ? "touch-pan-x touch-pan-y" : "touch-pan-y") : ""}`}
            onContextMenuCapture={captureTerminalContextMenu}
            onTouchStart={(event) => {
              stopRetainedHistoryTouchPropagation(event);
              beginTerminalLongPress(event.touches);
              ensurePinchGesture().start(gestureTouches(event.touches));
              touchHandlers().start(event);
              handleTerminalTouchStart(event);
            }}
            onTouchMove={(event) => {
              stopRetainedHistoryTouchPropagation(event);
              const points = gestureTouches(event.touches);
              longPressGestureRef.current?.move(points);
              ensurePinchGesture().move(points);
              touchHandlers().move(event);
              handleTerminalTouchMove(event);
            }}
            onTouchEnd={(event) => {
              stopRetainedHistoryTouchPropagation(event);
              longPressGestureRef.current?.cancel();
              ensurePinchGesture().end();
              touchHandlers().end(event);
              handleTerminalTouchEnd(event);
            }}
            onTouchCancel={(event) => {
              stopRetainedHistoryTouchPropagation(event);
              longPressGestureRef.current?.cancel();
              ensurePinchGesture().cancel();
              touchHandlers().cancel();
              handleTerminalTouchCancel();
            }}
          >
            <div
              ref={containerRef}
              data-terminal-renderer="dom"
              data-terminal-context-loss-count="0"
              data-terminal-font-size={terminalFontSize}
              data-terminal-grid-cache-id={session.id}
              className="box-border h-full min-h-0 w-full overflow-hidden"
            />
            <TerminalCommandGutter
              commandMarks={promptTrackerState.commandMarks}
              lineHeight={promptTrackerState.lineHeight}
              rows={session.rows}
              viewportLine={promptTrackerState.viewportLine}
            />
            <TerminalSearch
              terminalId={session.id}
              addon={terminalSearchAddon}
              terminal={terminalRef.current}
              touch={isTouchDevice}
              hideTrigger={attentionShownAsBanner}
              open={terminalSearchOpen}
              onOpenChange={setTerminalSearchOpen}
            />
          </TerminalAttentionPane>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-36"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!parkedRef.current) terminalRef.current?.focus();
          }}
        >
          {contextMenuLink !== null ? (
            <>
              <ContextMenuItem
                onSelect={() => requestOpenTerminalLink(contextMenuLink)}
              >
                Open Link
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => openUrlInExternalBrowser(contextMenuLink.uri)}
              >
                Open Link Externally
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  copyTerminalContextValue(contextMenuLink.uri, "Link copied")
                }
              >
                Copy Link
              </ContextMenuItem>
            </>
          ) : null}
          {contextMenuLink !== null && contextMenuSelectionText.length > 0 ? (
            <ContextMenuSeparator />
          ) : null}
          {contextMenuSelectionText.length > 0 ? (
            <ContextMenuItem
              onSelect={() =>
                copyTerminalContextValue(
                  contextMenuSelectionText,
                  "Selection copied",
                )
              }
            >
              Copy
            </ContextMenuItem>
          ) : null}
          {contextMenuLink !== null || contextMenuSelectionText.length > 0 ? (
            <ContextMenuSeparator />
          ) : null}
          <ContextMenuItem
            disabled={session.status !== "running"}
            onSelect={pasteFromClipboard}
          >
            Paste
          </ContextMenuItem>
        </ContextMenuContent>
        <TimelineSelectionMenu
          selection={parked ? null : activeSelection}
          onAddToChat={
            onSelectionAddToChat === undefined
              ? undefined
              : handleSelectionAddToChat
          }
          onDismiss={dismissTerminalSelectionMenu}
        />
        <TerminalLinkOpenDialog
          target={parked ? null : pendingTerminalLink}
          onConfirm={confirmTerminalLinkOpen}
          onOpenChange={(open) => {
            if (!open) {
              setPendingTerminalLink(null);
            }
          }}
        />
      </ContextMenu>
      {isTouchDevice ? (
        <TerminalMobileControls
          className={attentionShownAsBanner ? "py-0" : undefined}
          controlActive={controlActive}
          disabled={!terminalReady || session.status !== "running"}
          readOnlyDisabled={
            !terminalReady ||
            (session.status !== "running" && session.status !== "exited")
          }
          onControlChange={(active) => {
            changeControlActive(active);
            if (active) terminalRef.current?.focus();
          }}
          onPreviousPrompt={() => jumpToPrompt("previous")}
          onNextPrompt={() => jumpToPrompt("next")}
          onArrow={(key) => {
            const terminal = terminalRef.current;
            if (!terminal) return;
            changeControlActive(false);
            compositionInputGuardRef.current?.flushPendingInput();
            terminal.input(
              encodeTerminalArrow(
                key,
                terminal.modes.applicationCursorKeysMode,
              ),
            );
          }}
          onInput={(data) => {
            changeControlActive(false);
            compositionInputGuardRef.current?.flushPendingInput();
            terminalRef.current?.input(data);
          }}
          onKeyboardToggle={() => {
            const terminal = terminalRef.current;
            if (!terminal) return;
            if (document.activeElement === terminal.textarea) terminal.blur();
            else terminal.focus();
          }}
          onSearch={() => setTerminalSearchOpen(true)}
          searchAvailable={
            terminalSearchAddon !== null && !attentionShownAsBanner
          }
          onPaste={() => {
            changeControlActive(false);
            pasteFromClipboard();
          }}
          onSelectText={() => {
            const terminal = terminalRef.current;
            if (!terminal) return;
            terminal.blur();
            setTextSnapshotInitialLine(null);
            setTextSnapshot(terminalTextSnapshot(terminal));
          }}
        />
      ) : null}
      {isTouchDevice ? (
        <TerminalTextSelectSheet
          open={!parked && textSnapshot !== null}
          text={textSnapshot ?? ""}
          initialLine={textSnapshotInitialLine}
          onOpenChange={(open) => {
            if (!open) {
              setTextSnapshotInitialLine(null);
              setTextSnapshot(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}
