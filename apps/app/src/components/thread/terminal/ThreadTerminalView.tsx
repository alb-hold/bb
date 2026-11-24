import { TerminalSizeClaimControl } from "./TerminalSizeClaimControl";
import { releaseParkedTerminalRendering } from "./terminal-parked-rendering";
import {
  markTerminalPerformance,
  measureTerminalPerformance,
} from "@/lib/terminal-performance";
import { readCachedTerminalGrid, rememberTerminalGrid } from "./terminal-grid-cache";
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
import type {
  IDisposable,
  IMarker,
  ITheme,
  Terminal as XTermTerminal,
} from "@xterm/xterm";
import {
  holdTerminalPaint,
  revealTerminalAfterRender,
} from "./terminal-paint-gate";
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
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";
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
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
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
import { forwardLateImeInput } from "./terminal-late-ime-input";
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

async function withAsyncFinally<T>(
  action: () => Promise<T>,
  finalize: () => void,
): Promise<T> {
  try {
    return await action();
  } finally {
    finalize();
  }
}

async function withAsyncCatchAndFinally(
  action: () => Promise<void>,
  onError: () => void,
  finalize: () => void,
): Promise<void> {
  try {
    await action();
  } catch {
    onError();
  } finally {
    finalize();
  }
}

async function withAsyncCatch<T>(
  action: () => Promise<T>,
  onError: () => void,
): Promise<T | undefined> {
  try {
    return await action();
  } catch {
    onError();
    return undefined;
  }
}

function focusTerminalAndResetFlag(
  terminal: XTermTerminal,
  flag: { current: boolean },
): void {
  try {
    terminal.focus();
  } finally {
    flag.current = false;
  }
}

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
  cursorInactiveStyle: "outline" as const,
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
  onSurfaceVisible?: () => void;
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
  const readBuffer = (buffer = terminal.buffer.active) => {
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
  if (retainNativeOutput && terminal.buffer.active.type === "alternate") {
    const primaryFrame = readBuffer(terminal.buffer.normal);
    const frame = readBuffer(terminal.buffer.alternate);
    terminal.reset();
    const combined =
      primaryFrame.length > 0
        ? `${primaryFrame}\r\n${frame}\r\n`
        : `${frame}\r\n`;
    await new Promise<void>((resolve) => terminal.write(combined, resolve));
  } else if (alternateFrame !== null) {
    const primaryFrame = readBuffer(terminal.buffer.normal);
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
  onSurfaceVisible,
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
  const retentionInvalidatedRef = useRef(onRetentionInvalidated);
  const surfaceVisibleRef = useRef(onSurfaceVisible);
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
  const handoffOwnerTokenRef = useRef(handoffOwnerToken);
  const activeTransportRef = useRef<TerminalWebSocketTransport | null>(null);
  useEffect(() => {
    activeTransportRef.current?.rebindUrl(
      buildTerminalWebSocketUrl({
        handoffOwnerToken:
          wsManager.getDeviceHandoffClientToken() ?? handoffOwnerToken,
        terminalId: session.id,
      }),
    );
  }, [handoffOwnerToken, session.id]);
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
  const claimSizeRef = useRef<(() => void) | null>(null);
  const [showFitControl, setShowFitControl] = useState(false);
  const [truncatedSessionId, setTruncatedSessionId] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [scrolledAboveBottom, setScrolledAboveBottom] = useState(false);
  const [promptTrackerState, setPromptTrackerState] = useState(
    EMPTY_TERMINAL_PROMPT_TRACKER,
  );
  const [terminalSearchAddon, setTerminalSearchAddon] =
    useState<TerminalSearchAddonInstance | null>(null);
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [findFocusRequest, setFindFocusRequest] = useState<number | null>(null);
  const terminalSearchOpenRef = useRef(false);
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
    let handlers = touchHandlersRef.current;
    if (handlers === null) {
      handlers = createTerminalTouchHandlers(terminalRef);
      touchHandlersRef.current = handlers;
    }
    return handlers;
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
  useLayoutEffect(() => {
    resetTerminalExitNoticeForSession({
      lastNotice: lastStatusNoticeRef,
      lastSessionId: lastStatusNoticeSessionRef,
      sessionId: session.id,
    });
  }, [session.id]);
  const scheduleFitRef = useRef<TerminalFitScheduler | null>(null);
  const invalidateFitRef = useRef<(() => void) | null>(null);
  const terminalVisibilityReporterRef = useRef<(() => void) | null>(null);
  const systemConfig = useSystemConfig();
  const copyOnSelectRef = useRef(false);
  const lastUserInputAtRef = useRef<number | null>(null);
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

  useLayoutEffect(() => {
    parkedRef.current = parked;
    retentionInvalidatedRef.current = onRetentionInvalidated;
    surfaceVisibleRef.current = onSurfaceVisible;
    handoffOwnerTokenRef.current = handoffOwnerToken;
    clearAttentionOnInputRef.current = clearAttentionOnInput;
    terminalSearchOpenRef.current = terminalSearchOpen;
    copyOnSelectRef.current =
      systemConfig.data?.generalSettings.terminalCopyOnSelect === true;
    promptLinesRef.current = promptTrackerState.promptLines;
    autoFocusRef.current = autoFocus;
    isPanelOpenRef.current = isPanelOpen;
    sessionStatusRef.current = session.status;
    sessionRef.current = session;
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = session.status === "exited";
    }
    onAutoFocusHandledRef.current = onAutoFocusHandled;
    onOpenLinkRef.current = effectiveOnOpenLink;
    onSessionChangeRef.current = onSessionChange;
    onTitleChangeRef.current = onTitleChange;
    onProgressChangeRef.current = onProgressChange;
    onCwdChangeRef.current = onCwdChange;
    onUserInputRef.current = onUserInput;
  }, [
    autoFocus,
    clearAttentionOnInput,
    effectiveOnOpenLink,
    handoffOwnerToken,
    isPanelOpen,
    onAutoFocusHandled,
    onCwdChange,
    onProgressChange,
    onRetentionInvalidated,
    onSessionChange,
    onSurfaceVisible,
    onTitleChange,
    onUserInput,
    parked,
    promptTrackerState.promptLines,
    session,
    session.status,
    systemConfig.data?.generalSettings.terminalCopyOnSelect,
    terminalSearchOpen,
  ]);

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
      setFindFocusRequest((request) => (request ?? 0) + 1);
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

  const [terminalUiResetKey, setTerminalUiResetKey] = useState(
    () => `${session.id}/${parked}`,
  );
  const nextTerminalUiResetKey = `${session.id}/${parked}`;
  if (terminalUiResetKey !== nextTerminalUiResetKey) {
    setTerminalUiResetKey(nextTerminalUiResetKey);
    setActiveSelection(null);
    setFindFocusRequest(null);
    setTextSnapshot(null);
    setTextSnapshotInitialLine(null);
    setPendingTerminalLink(null);
    setContextMenuState({ link: null, selectionText: "" });
    setContextMenuOpen(false);
    if (parked) setTerminalSearchOpen(false);
  }

  useEffect(() => {
    touchFocusGestureRef.current = null;
    touchHandlersRef.current?.cancel();
    updateHoveredTerminalLink(null);
    if (parked) {
      longPressGestureRef.current?.cancel();
    }
  }, [parked, session.id, updateHoveredTerminalLink]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const holdForFittedGrid =
      container.closest("[data-native-terminal-thread]") !== null;
    setRestoringSession(sessionStatusRef.current === "running");

    container.style.containerType = "inline-size";

    const earlySocketUrl = buildTerminalWebSocketUrl({
      handoffOwnerToken:
        wsManager.getDeviceHandoffClientToken() ??
        handoffOwnerTokenRef.current,
      terminalId: session.id,
    });
    if (sessionStatusRef.current === "running")
      prefetchTerminalSocket(earlySocketUrl);
    const lifecycle = {
      disposed: false,
      activeElementAtMount: document.activeElement as Element | null,
      transport: null as TerminalWebSocketTransport | null,
      retryStalledReplay: () => {},
      stopWatchingLayout: null as (() => void) | null,
      resizeAnimationFrame: null as number | null,
      connectionNoticeTimeout: null as ReturnType<typeof setTimeout> | null,
      checkReplayReveal: null as (() => void) | null,
      fittedGridFallback: false,
      replayPreviewExitApplied: false,
      lastParsedOutputNextSeq: 0,
      replayPreview: null as ReturnType<typeof mountTerminalReplayPreview> | null,
      replayCompleted: false,
      localFitGrid: null as TerminalGridSize | null,
      replayRevealTimeout: null as ReturnType<typeof setTimeout> | null,
      keepScreenLoadingPreview: false,
      exitedBeforeReplayCompleted: false,
      reconnectingNoticeVisible: false,
      restoreParkedRendering: null as (() => void) | null,
      completeReplayReveal: null as (() => void) | null,
      fittedGridHeld: false,
      screenLoadingPreview: null as ReturnType<
        typeof mountTerminalScreenLoadingPreview
      > | null,
      initialLayoutSettled: false,
      paintReveal: null as IDisposable | null,
      markerGridActive: false,
      replayStarted: false,
      sharedSize: null as TerminalGridSize | null,
      initialRendererSettled: retainNativeOutput,
      flushHiddenOutput: () => {},
      replayCheckpointSequence: null as number | null,
      replayRevealGeneration: 0,
      retainedOutputGrid: null as TerminalGridSize | null,
      latestPtyGrid: {
        cols: sessionRef.current.cols,
        rows: sessionRef.current.rows,
      },
      terminalResizeSubscription: null as { dispose: () => void } | null,
      claimedFitGrid: null as TerminalGridSize | null,
      replayNextSeq: null as number | null,
      terminalRenderSubscription: null as { dispose: () => void } | null,
      reportedCwd: null as string | null,
      terminal: null as XTermTerminal | null,
      viewportLineAnchor: null as ReturnType<
        typeof createTerminalViewportLineAnchor
      > | null,
      fittedGridRevealed: false,
      initialFitComplete: false,
      replayNextSequence: 0,
      webglRenderer: null as ReturnType<typeof loadTerminalWebglRenderer> | null,
      sizeClaims: null as ReturnType<typeof listenForTerminalSizeClaims> | null,
      replayStartSequence: 0,
      replayTimingFirstFrame: false,
      replayTimingNextSeq: null as number | null,
      processExitedSeen: false,
      messageEventTimestamp: 0,
      outputFrameId: null as number | null,
      hasReceivedInitialAttach: false,
      isReconnecting: false,
      parkedOutputTimer: null as ReturnType<typeof setTimeout> | null,
      parkedOutputDraining: false,
      terminalInputClaimed: false,
      retainedOutputReplayed: sessionStatusRef.current !== "exited",
      retainedReplayFailed: false,
      retainedReplayTimeout: null as ReturnType<typeof setTimeout> | null,
      terminalProgressDisposable: null as { dispose: () => void } | null,
      shellOscDisposable: null as { dispose: () => void } | null,
      osc52Disposable: null as { dispose: () => void } | null,
      outputPipeline: null as ReturnType<typeof createTerminalOutputPipeline> | null,
      fitAddon: null as FitAddon | null,
      outputBoundaryDisposable: null as { dispose: () => void } | null,
      detachViewportListeners: null as (() => void) | null,
      rendererDeadline: undefined as ReturnType<typeof setTimeout> | undefined,
      stopObservingFonts: null as (() => void) | null,
      latestOutputSequence: 0,
      hasRestoredViewport: false,
      detachPointerCoordinates: null as (() => void) | null,
      anchoredOutputSequence: 0,
      detachGridVisibilityListeners: null as (() => void) | null,
      lateImeInputDisposable: null as { dispose: () => void } | null,
      savedViewportAnchor: null as ReturnType<typeof readTerminalViewportAnchor>,
      hasManualScrollIntent: false,
      selectionChangeDisposable: null as { dispose: () => void } | null,
      unobserveContainerResize: null as (() => void) | null,
      manualScrollTimeout: null as ReturnType<typeof setTimeout> | null,
      containerHasSize: false,
      terminalKeyDisposable: null as { dispose: () => void } | null,
      terminalInputForwarding: null as { dispose: () => void } | null,
      lastQueuedOutputNextSeq: 0,
      savedOutputLineAnchor: null as TerminalOutputLineAnchor | null,
      terminalVisible: null as boolean | null,
      parsingOutputSequence: null as number | null,
      terminalInteractions: null as ReturnType<
        typeof attachTerminalInteractions
      > | null,
    };
    const fitWork = createTerminalFitWork();
    const replayWriteState: TerminalReplayWriteState = {
      suppressedWriteCount: 0,
    };
    const outputLineAnchors: TerminalOutputLineAnchor[] = [];
    const outputLineAnchorTracker = createTerminalOutputLineAnchorTracker({
      registerMarker: () => lifecycle.terminal?.registerMarker(),
      getCurrentLine: () => {
        const buffer = lifecycle.terminal?.buffer.active;
        return buffer ? buffer.baseY + buffer.cursorY : 0;
      },
    });
    const recordOutputStart = (sequence: number) => {
      lifecycle.parsingOutputSequence = sequence;
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
    const updateSavedOutputLineAnchor = (
      anchor: TerminalOutputLineAnchor | null,
    ) => {
      lifecycle.savedOutputLineAnchor = outputLineAnchorTracker.updatePinnedAnchor(
        lifecycle.savedOutputLineAnchor,
        anchor,
        outputLineAnchors,
      );
    };
    const updateViewportLineAnchor = (line: number) => {
      const activeBuffer = lifecycle.terminal?.buffer.active;
      if (activeBuffer && line < activeBuffer.baseY) {
        lifecycle.viewportLineAnchor?.setLine(line);
      } else {
        lifecycle.viewportLineAnchor?.clear();
      }
    };
    const viewportStorageKey = terminalViewportStorageKey(session.id);
    const viewportStorage = terminalViewportStorageForClient(window);
    lifecycle.savedViewportAnchor = readTerminalViewportAnchor(
      viewportStorage,
      viewportStorageKey,
    );
    const viewportPersistence = createTerminalViewportPersistence({
      key: viewportStorageKey,
      storage: viewportStorage,
    });
    const viewportReplaySaveGate = createTerminalViewportReplaySaveGate();
    lifecycle.anchoredOutputSequence = lifecycle.savedViewportAnchor?.outputSequence ?? 0;
    const noteManualScrollIntent = () => {
      lifecycle.hasManualScrollIntent = true;
      lifecycle.viewportLineAnchor?.clear();
      if (lifecycle.manualScrollTimeout !== null) {
        clearTimeout(lifecycle.manualScrollTimeout);
      }
      lifecycle.manualScrollTimeout = setTimeout(() => {
        lifecycle.hasManualScrollIntent = false;
        lifecycle.manualScrollTimeout = null;
      }, 250);
    };
    const pendingExitNotices: string[] = [];
    const clearScreenLoadingPreview = () => {
      lifecycle.screenLoadingPreview?.dispose();
      lifecycle.screenLoadingPreview = null;
    };
    const terminalFontOptions = {
      ...readTerminalFontMetrics(),
      fontSize: terminalFontSizeRef.current,
      ...TERMINAL_CELL_OPTIONS,
    };
    let resolveRendererSettled = () => {};
    const rendererSettled = new Promise<void>((resolve) => {
      resolveRendererSettled = resolve;
    });
    if (lifecycle.initialRendererSettled) resolveRendererSettled();
    const flushPendingExitNotices = () => {
      if (lifecycle.terminal === null || pendingExitNotices.length === 0) return;
      for (const text of pendingExitNotices.splice(0)) {
        writeTerminalStatus({ terminal: lifecycle.terminal, text });
      }
    };
    let paintedScreenKept = false;
    const releaseReplayPreview = () => {
      paintedScreenKept = false;
      lifecycle.replayPreview?.release();
      clearScreenLoadingPreview();
      setRestoringSession(false);
      setReplayNotice(null);
    };
    const handleReplayPreviewExit = createTerminalReplayPreviewExitHandler({
      getReplayState: () => ({
        hasReplaySurface: lifecycle.replayPreview !== null,
        replayCompleted: lifecycle.replayCompleted,
      }),
      isApplied: () => lifecycle.replayPreviewExitApplied,
      isPending: () => lifecycle.exitedBeforeReplayCompleted,
      markApplied: () => {
        lifecycle.replayPreviewExitApplied = true;
      },
      markPending: () => {
        lifecycle.exitedBeforeReplayCompleted = true;
      },
      releasePreview: releaseReplayPreview,
      processExited: () => lifecycle.replayPreview?.processExited(),
    });
    const keepPaintedScreen = () => {
      paintedScreenKept = true;
      lifecycle.replayPreview?.showFallback();
      setReplayNotice("reconnecting");
    };
    const abandonReplayPreview = () => {
      flushPendingExitNotices();
      if (lifecycle.replayPreview === null || lifecycle.replayCompleted) {
        releaseReplayPreview();
        return;
      }
      if (lifecycle.replayPreview.fallback) lifecycle.replayPreview.hold({ countdown: false });
      lifecycle.replayPreview.showFallback();
      paintedScreenKept = true;
      setReplayNotice("unavailable");
    };
    lifecycle.containerHasSize = hasVisibleTerminalSize({
      containerElement: container,
    });
    const hiddenOutput = createTerminalHiddenOutput(() =>
      retentionInvalidatedRef.current?.(),
    );
    const reportDocumentVisibility = () => {
      if (
        document.visibilityState !== "visible" ||
        !lifecycle.containerHasSize ||
        !isPanelOpenRef.current
      ) {
        cancelTerminalOutputNextRenders(session.id);
      }
      const nextVisible =
        document.visibilityState === "visible" &&
        lifecycle.containerHasSize &&
        isPanelOpenRef.current;
      if (lifecycle.transport === null) return;
      if (!holdForFittedGrid && !isPanelOpenRef.current && !parkedRef.current)
        hiddenOutput.invalidate();
      const wasVisible = lifecycle.terminalVisible;
      if (wasVisible === nextVisible) return;
      lifecycle.terminalVisible = nextVisible;
      if (nextVisible) webglVisibilityRef.current?.sync();
      lifecycle.transport?.setVisible(nextVisible);
      if (nextVisible) {
        if (!returningRef.current) lifecycle.sizeClaims?.claimIfFocused();
        scheduleFitRef.current?.();
      }
      if (wasVisible === false && nextVisible) lifecycle.flushHiddenOutput();
    };
    terminalVisibilityReporterRef.current = reportDocumentVisibility;
    reportDocumentVisibilityRef.current = reportDocumentVisibility;

    let liveBottomBeforeGridResize = false;
    let liveBottomResizeClearFrame: number | null = null;
    const captureLiveViewportBeforeGridResize = () => {
      const activeBuffer = lifecycle.terminal?.buffer.active;
      liveBottomBeforeGridResize =
        activeBuffer !== undefined &&
        activeBuffer.viewportY === activeBuffer.baseY;
      if (activeBuffer && !liveBottomBeforeGridResize) {
        lifecycle.viewportLineAnchor?.setLine(activeBuffer.viewportY);
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
        const fit = lifecycle.localFitGrid;
        return (
          fit !== null &&
          fit.cols > 0 &&
          fit.rows > 0 &&
          lifecycle.containerHasSize &&
          lifecycle.hasReceivedInitialAttach &&
          lifecycle.replayCompleted &&
          lifecycle.initialRendererSettled &&
          lifecycle.initialLayoutSettled &&
          lifecycle.claimedFitGrid?.cols === fit.cols &&
          lifecycle.claimedFitGrid.rows === fit.rows &&
          lifecycle.latestPtyGrid.cols === fit.cols &&
          lifecycle.latestPtyGrid.rows === fit.rows &&
          lifecycle.terminal?.cols === fit.cols &&
          lifecycle.terminal.rows === fit.rows
        );
      };
      const holdFittedGrid = () => {
        if (
          !needsFittedGrid() ||
          lifecycle.fittedGridFallback ||
          lifecycle.fittedGridHeld ||
          lifecycle.fittedGridRevealed
        )
          return;
        lifecycle.fittedGridHeld = true;
        const generation = ++lifecycle.replayRevealGeneration;
        containerElement.dataset.replayHeld = "true";
        containerElement.style.opacity = "0";
        setRestoringSession(true);
        if (lifecycle.replayCompleted) lifecycle.replayPreview?.hold({ countdown: false });
        const release = () => {
          if (lifecycle.disposed || generation !== lifecycle.replayRevealGeneration) return;
          lifecycle.checkReplayReveal = null;
          if (lifecycle.replayRevealTimeout !== null) clearTimeout(lifecycle.replayRevealTimeout);
          lifecycle.replayRevealTimeout = null;
          lifecycle.fittedGridHeld = false;
          lifecycle.fittedGridRevealed = true;
          markTerminalPerformance("terminal-fitted-grid-revealed");
          containerElement.dataset.replayHeld = "false";
          if (lifecycle.fittedGridFallback) containerElement.style.opacity = "";
          const complete = lifecycle.completeReplayReveal;
          lifecycle.completeReplayReveal = null;
          const finish = () => {
            setRestoringSession(false);
            complete?.();
            updateGridVisibility();
          };
          if (needsFittedGrid()) flushSync(finish);
          else finish();
        };
        lifecycle.checkReplayReveal = () => {
          if (
            lifecycle.disposed ||
            generation !== lifecycle.replayRevealGeneration ||
            !fittedGridReady()
          )
            return;
          release();
        };
        lifecycle.replayRevealTimeout = setTimeout(() => {
          if (lifecycle.disposed || generation !== lifecycle.replayRevealGeneration) return;
          lifecycle.fittedGridFallback = true;
          release();
        }, 15_000);
      };
      holdFittedGrid();
      const updateGridVisibility = () => {
        if (lifecycle.terminal === null) {
          return;
        }
        containerElement.dataset.renderGridCols = String(lifecycle.terminal.cols);
        containerElement.dataset.renderGridRows = String(lifecycle.terminal.rows);
        const ownsTerminal =
          lifecycle.terminalInputClaimed &&
          document.hasFocus() &&
          lifecycle.terminal.element?.contains(document.activeElement) === true;
        const displayGrid = lifecycle.retainedOutputGrid ?? lifecycle.latestPtyGrid;
        const canReveal =
          lifecycle.localFitGrid !== null &&
          (sessionStatusRef.current === "exited" ||
            lifecycle.initialFitComplete ||
            (lifecycle.terminal.cols === lifecycle.localFitGrid.cols &&
              lifecycle.terminal.rows === lifecycle.localFitGrid.rows)) &&
          (!retainNativeOutput ||
            sessionStatusRef.current !== "exited" ||
            lifecycle.retainedOutputGrid !== null) &&
          canRevealTerminalSurface({
            fitGrid: lifecycle.localFitGrid,
            isOwner: ownsTerminal && !retainNativeOutput,
            ptyGrid: displayGrid,
            rendererGrid: { cols: lifecycle.terminal.cols, rows: lifecycle.terminal.rows },
          });
        const presentation = terminalSurfacePresentation({
          grid: displayGrid,
          fitGrid: lifecycle.localFitGrid,
          fontSize: terminalFontSizeRef.current,
          isOwner: ownsTerminal,
          minimumFontSize: defaultFontSizeRef.current,
          running: sessionStatusRef.current === "running",
        });
        setShowFitControl(presentation.showFitControl);
        containerElement.dataset.ptyGridCols = String(lifecycle.latestPtyGrid.cols);
        containerElement.dataset.ptyGridRows = String(lifecycle.latestPtyGrid.rows);
        if (lifecycle.terminal.element) {
          lifecycle.terminal.element.style.maxWidth = needsFittedGrid() ? "100%" : "";
          lifecycle.terminal.element.style.overflow = needsFittedGrid() ? "hidden" : "";
        }
        if (needsFittedGrid() && lifecycle.fittedGridRevealed && !fittedGridReady())
          return;
        if (needsFittedGrid() && !fittedGridReady()) holdFittedGrid();
        lifecycle.checkReplayReveal?.();
        if (
          (lifecycle.replayPreview !== null && !lifecycle.replayCompleted) ||
          (needsFittedGrid() && containerElement.dataset.replayHeld === "true")
        )
          return;
        if (!needsFittedGrid() || !lifecycle.fittedGridRevealed)
          containerElement.style.opacity = "0";
        const scrollRetainedOutput =
          !needsFittedGrid() &&
          lifecycle.retainedOutputGrid === null &&
          presentation.panHorizontally;
        containerElement.style.overflowX = scrollRetainedOutput ? "auto" : "";
        containerElement.style.overflowY = scrollRetainedOutput ? "auto" : "";
        containerElement.style.touchAction = scrollRetainedOutput
          ? "pan-x pan-y"
          : "";
        const scale = lifecycle.retainedOutputGrid !== null ? 1 : presentation.scale;
        if (lifecycle.terminal.element) {
          applyTerminalSurfaceScale(
            lifecycle.terminal.element,
            scale,
            !scrollRetainedOutput &&
              !needsFittedGrid() &&
              lifecycle.retainedOutputGrid === null,
          );
        }
        const rendererWidth =
          containerElement.getBoundingClientRect().width - horizontalPadding;
        const paintedWidth =
          lifecycle.terminal.element
            ?.querySelector<HTMLElement>(".xterm-screen")
            ?.getBoundingClientRect().width ?? 0;
        const widthFits =
          rendererWidth > 0 &&
          (scrollRetainedOutput || paintedWidth <= rendererWidth + 1);
        if (canReveal && widthFits) {
          if (lifecycle.replayCompleted && lifecycle.replayPreview !== null) {
            lifecycle.replayPreview.dispose();
            lifecycle.replayPreview = null;
          }
          containerElement.style.opacity = "";
          if (!parkedRef.current) surfaceVisibleRef.current?.();
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
          lifecycle.disposed ||
          lifecycle.replayStarted ||
          lifecycle.replayCompleted ||
          snapshot == null ||
          !snapshot.complete ||
          snapshot.truncated
        )
          return;
        lifecycle.keepScreenLoadingPreview =
          snapshot.cols !== lifecycle.latestPtyGrid.cols ||
          snapshot.gridRows !== lifecycle.latestPtyGrid.rows;
        if (modulesReady && !lifecycle.keepScreenLoadingPreview) return;
        lifecycle.screenLoadingPreview = mountTerminalScreenLoadingPreview({
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
      if (lifecycle.disposed) {
        return;
      }

      const osc8LinkHandler = createTerminalOsc8LinkHandler({
        onActivate: requestOpenTerminalLink,
        onHover: (target) => {
          if (!lifecycle.disposed) {
            updateHoveredTerminalLink(target);
          }
        },
      });

      lifecycle.terminal = new Terminal({
        ...TERMINAL_THEME_OPTIONS,
        allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
        convertEol: true,
        disableStdin: sessionRef.current.status === "exited",
        ...terminalFontOptions,
        linkHandler: osc8LinkHandler,
        scrollback: 10_000,
        theme: buildTerminalTheme(),
      });
      lifecycle.terminalProgressDisposable = lifecycle.terminal.parser.registerOscHandler(
        9,
        (payload) => {
          const progress = parseTerminalProgressOsc(payload);
          if (progress === undefined) return false;
          onProgressChangeRef.current?.(
            progress,
            lifecycle.parsingOutputSequence ?? undefined,
            session.id,
          );
          return true;
        },
      );
      lifecycle.terminalRenderSubscription = lifecycle.terminal.onRender(() => {
        if (containerElement.style.opacity === "0") {
          updateGridVisibility();
        }
        if (
          document.visibilityState === "visible" &&
          lifecycle.containerHasSize &&
          isPanelOpenRef.current
        ) {
          recordTerminalOutputNextRender(session.id, performance.now());
        }
      });
      setPromptTrackerState(EMPTY_TERMINAL_PROMPT_TRACKER);
      lifecycle.shellOscDisposable = attachTerminalPromptTracker({
        onChange: setPromptTrackerState,
        onCwdChange: (cwd) => onCwdChangeRef.current?.(cwd),
        terminal: lifecycle.terminal,
      });
      lifecycle.terminal.attachCustomKeyEventHandler((event) => {
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
      terminalRef.current = lifecycle.terminal;
      lifecycle.osc52Disposable = registerTerminalOsc52Handler(
        { parser: lifecycle.terminal.parser },
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
      lifecycle.outputPipeline = createTerminalOutputPipeline(
        lifecycle.terminal,
        (grid, apply) => {
          lifecycle.markerGridActive = true;
          if (apply && !lifecycle.hasReceivedInitialAttach) {
            lifecycle.latestPtyGrid = grid;
          }
          updateTerminalReplayPreviewPtyGrid(
            lifecycle.replayPreview,
            lifecycle.hasReceivedInitialAttach ? lifecycle.latestPtyGrid : grid,
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
            lifecycle.terminal?.refresh(0, lifecycle.terminal.rows - 1);
            clearLiveViewportBeforeGridResize();
          },
          flushReplay: () => {
            if (lifecycle.terminal) flushTerminalReplay(lifecycle.terminal, "primary");
          },
        },
      );
      lifecycle.terminal.parser.registerOscHandler(7, (data) => {
        lifecycle.reportedCwd = parseTerminalReportedCwd(data) ?? lifecycle.reportedCwd;
        return false;
      });
      lifecycle.terminal.registerLinkProvider(
        createTerminalFileLinkProvider({
          terminal: lifecycle.terminal,
          getCwd: () => lifecycle.reportedCwd ?? sessionRef.current.initialCwd,
          hostId: sessionRef.current.hostId,
          openFile: (intent) => {
            appNavigationRef.current.openFilePreview(intent);
          },
        }),
      );
      lifecycle.fitAddon = new LoadedFitAddon();
      lifecycle.terminal.loadAddon(lifecycle.fitAddon);
      lifecycle.terminal.loadAddon(new Unicode11Addon());
      lifecycle.terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
      markTerminalPerformance("terminal-xterm-open-start");
      lifecycle.terminal.open(containerElement);
      lifecycle.lateImeInputDisposable = forwardLateImeInput(lifecycle.terminal);
      lifecycle.terminal.element?.classList.add("bg-sidebar");
      const rendererStyle = getComputedStyle(
        lifecycle.terminal.element ?? containerElement,
      );
      paddingLeft = rendererStyle.paddingLeft;
      horizontalPadding =
        (parseFloat(paddingLeft) || 0) +
        (parseFloat(rendererStyle.paddingRight) || 0);
      markTerminalPerformance("terminal-xterm-open-end");
      if (lifecycle.initialRendererSettled)
        markTerminalPerformance("terminal-initial-renderer-settled");
      trackTerminalScrollability(lifecycle.terminal);
      const viewport =
        lifecycle.terminal.element?.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport) {
        viewport.style.backgroundColor = "inherit";
      }
      void loadOptionalTerminalSearchAddon(importTerminalSearchAddon)
        .then((searchAddonModule) => {
          if (lifecycle.disposed || searchAddonModule === null || lifecycle.terminal === null) {
            return;
          }
          try {
            const searchAddon = new searchAddonModule.SearchAddon();
            lifecycle.terminal.loadAddon(searchAddon);
            setTerminalSearchAddon(searchAddon);
          } catch {
            setTerminalSearchAddon(null);
          }
        })
        .catch(() => undefined);
      void importTerminalWebLinksAddon()
        .then(({ WebLinksAddon }) => {
          if (lifecycle.disposed || lifecycle.terminal === null) return;
          try {
            lifecycle.terminal.loadAddon(
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
            lifecycle.disposed ||
            webglAddonModule === null ||
            lifecycle.terminal === null ||
            retainNativeOutput ||
            lifecycle.initialRendererSettled
          ) {
            return;
          }
          lifecycle.webglRenderer = loadTerminalWebglRenderer(
            lifecycle.terminal,
            () => new webglAddonModule.WebglAddon(),
            {
              root: containerElement,
              visible: false,
              onRendererChange: (renderer) => {
                if (lifecycle.disposed || lifecycle.terminal === null) return;
                markTerminalPerformance("terminal-renderer-changed", {
                  detail: { terminalId: session.id, renderer },
                });
                fitWork.invalidate();
                scheduleFitRef.current?.();
                if (
                  !lifecycle.initialRendererSettled &&
                  (renderer === "webgl" ||
                    lifecycle.webglRenderer?.initialAttemptComplete)
                )
                  settleInitialRenderer();
              },
            },
          );
          webglVisibilityRef.current = observeTerminalWebglVisibility({
            root: containerElement,
            renderer: lifecycle.webglRenderer,
            isPanelOpen: () => isPanelOpenRef.current,
            onVisible: () => scheduleFitRef.current?.(),
          });
        })
        .catch(() => undefined);
      lifecycle.viewportLineAnchor = createTerminalViewportLineAnchor(lifecycle.terminal);
      outputLineAnchorTracker.reset();
      const outputBoundaryToken = randomUuid();
      const outputBoundaries =
        createTerminalOutputBoundaries(outputBoundaryToken);
      lifecycle.outputBoundaryDisposable = registerTerminalOutputBoundaryHandler(
        lifecycle.terminal.parser,
        outputBoundaryToken,
        recordOutputStart,
      );
      const restoreViewport = (afterGridResize = false) => {
        const activeBuffer = lifecycle.terminal?.buffer.active;
        if (!lifecycle.terminal || !activeBuffer) {
          return;
        }
        if (
          (afterGridResize && liveBottomBeforeGridResize) ||
          lifecycle.savedViewportAnchor?.distanceFromTail === 0
        ) {
          lifecycle.terminal.scrollToBottom();
          lifecycle.viewportLineAnchor?.clear();
          lifecycle.hasRestoredViewport = true;
          viewportReplaySaveGate.finishRestore();
          return;
        }
        if (
          afterGridResize &&
          lifecycle.viewportLineAnchor !== null &&
          restoreTerminalViewportToRetainedLine({
            terminal: lifecycle.terminal,
            lineAnchor: lifecycle.viewportLineAnchor,
          })
        ) {
          console.debug("Terminal viewport restore", {
            terminalId: session.id,
            branch: "retained-line-marker",
            anchor: lifecycle.savedViewportAnchor,
            line: lifecycle.viewportLineAnchor.getLine(),
          });
          lifecycle.hasRestoredViewport = true;
          viewportReplaySaveGate.finishRestore();
          return;
        }
        const restoreOutputLineAnchors =
          lifecycle.savedOutputLineAnchor === null
            ? outputLineAnchors
            : [...outputLineAnchors, lifecycle.savedOutputLineAnchor];
        const line = resolveTerminalViewportRestore(
          {
            anchor: lifecycle.savedViewportAnchor,
            baseY: activeBuffer.baseY,
            outputLineAnchors: restoreOutputLineAnchors,
            replayNextSequence: lifecycle.replayNextSequence,
            replayStartSequence: lifecycle.replayStartSequence,
          },
          (branch) => {
            console.debug("Terminal viewport restore", {
              terminalId: session.id,
              branch,
              anchor: lifecycle.savedViewportAnchor,
              replayStartSequence: lifecycle.replayStartSequence,
              replayNextSequence: lifecycle.replayNextSequence,
            });
          },
        );
        lifecycle.terminal.scrollToLine(line);
        updateViewportLineAnchor(line);
        lifecycle.hasRestoredViewport = true;
        viewportReplaySaveGate.finishRestore();
      };
      lifecycle.terminalResizeSubscription = restoreTerminalViewportOnResize({
        terminal: lifecycle.terminal,
        canRestore: () => lifecycle.hasRestoredViewport && !lifecycle.hasManualScrollIntent,
        restoreViewport: () => restoreViewport(true),
      });
      const flushViewportOnPageHide = () => viewportPersistence.flush();
      window.addEventListener("pagehide", flushViewportOnPageHide);
      const saveViewportAnchor = () => {
        if (
          !lifecycle.hasRestoredViewport ||
          !viewportReplaySaveGate.canSave(lifecycle.hasManualScrollIntent) ||
          lifecycle.terminal === null
        ) {
          return;
        }
        const activeBuffer = lifecycle.terminal.buffer.active;
        if (activeBuffer.type === "alternate") return;
        const distanceFromTail = Math.max(
          0,
          activeBuffer.baseY - activeBuffer.viewportY,
        );
        let lineOffset = lifecycle.savedViewportAnchor?.lineOffset ?? 0;
        if (lifecycle.hasManualScrollIntent) {
          const visibleLine = activeBuffer.viewportY;
          const mappedOutput = findTerminalOutputLineAnchor(
            outputLineAnchors,
            visibleLine,
          );
          updateSavedOutputLineAnchor(mappedOutput ?? null);
          lineOffset = mappedOutput
            ? Math.max(0, visibleLine - mappedOutput.line)
            : 0;
          lifecycle.anchoredOutputSequence =
            mappedOutput?.sequence ?? lifecycle.latestOutputSequence;
          updateViewportLineAnchor(visibleLine);
        }
        viewportPersistence.schedule({
          distanceFromTail,
          lineOffset,
          outputSequence: lifecycle.anchoredOutputSequence,
        });
        lifecycle.savedViewportAnchor = {
          distanceFromTail,
          lineOffset,
          outputSequence: lifecycle.anchoredOutputSequence,
        };
      };
      const touchViewportSaveScheduler =
        createTerminalTouchViewportSaveScheduler({
          getViewportY: () => lifecycle.terminal?.buffer.active.viewportY ?? 0,
          requestFrame: (callback) => window.requestAnimationFrame(callback),
          cancelFrame: (handle) => window.cancelAnimationFrame(handle),
          save: saveViewportAnchor,
        });
      const detachManualScrollIntentListeners =
        attachTerminalManualScrollIntentListeners(containerElement, (event) => {
          noteManualScrollIntent();
          if (event.type === "touchmove") touchViewportSaveScheduler.schedule();
        });
      const updateScrollPosition = () => {
        if (lifecycle.terminal === null) return;
        setScrolledAboveBottom(
          lifecycle.terminal.buffer.active.viewportY < lifecycle.terminal.buffer.active.baseY,
        );
      };
      const clearViewportAnchorAtTail = () => {
        const activeBuffer = lifecycle.terminal?.buffer.active;
        if (
          !activeBuffer ||
          !lifecycle.hasRestoredViewport ||
          activeBuffer.type === "alternate" ||
          !viewportReplaySaveGate.canSave(true) ||
          liveBottomBeforeGridResize ||
          liveBottomResizeClearFrame !== null ||
          activeBuffer.viewportY !== activeBuffer.baseY ||
          lifecycle.savedViewportAnchor === null ||
          lifecycle.savedViewportAnchor.distanceFromTail === 0
        ) {
          return;
        }
        lifecycle.savedViewportAnchor = {
          distanceFromTail: 0,
          lineOffset: 0,
          outputSequence: lifecycle.anchoredOutputSequence,
        };
        viewportPersistence.schedule(lifecycle.savedViewportAnchor);
      };
      const viewportScrollDisposable = lifecycle.terminal.onScroll(() => {
        updateScrollPosition();
        saveViewportAnchor();
        clearViewportAnchorAtTail();
      });
      const parsedWriteDisposable = lifecycle.terminal.onWriteParsed(updateScrollPosition);
      lifecycle.detachViewportListeners = () => {
        viewportScrollDisposable.dispose();
        parsedWriteDisposable.dispose();
        touchViewportSaveScheduler.dispose();
        detachManualScrollIntentListeners();
        window.removeEventListener("pagehide", flushViewportOnPageHide);
        viewportPersistence.dispose();
        if (lifecycle.manualScrollTimeout !== null) {
          clearTimeout(lifecycle.manualScrollTimeout);
          lifecycle.manualScrollTimeout = null;
        }
      };
      document.addEventListener("focusin", updateGridVisibility);
      document.addEventListener("focusout", updateGridVisibility);
      window.addEventListener("focus", updateGridVisibility);
      window.addEventListener("blur", updateGridVisibility);
      window.addEventListener("resize", updateGridVisibility);
      lifecycle.detachGridVisibilityListeners = () => {
        document.removeEventListener("focusin", updateGridVisibility);
        document.removeEventListener("focusout", updateGridVisibility);
        window.removeEventListener("focus", updateGridVisibility);
        window.removeEventListener("blur", updateGridVisibility);
        window.removeEventListener("resize", updateGridVisibility);
      };
      if (lifecycle.terminal.element) {
        lifecycle.detachPointerCoordinates = attachTerminalScalePointerCoordinates(
          lifecycle.terminal.element,
          () =>
            lifecycle.terminal?.element ? readTerminalSurfaceScale(lifecycle.terminal.element) : 1,
        );
      }
      containerElement.dataset.renderGridCols = String(lifecycle.terminal.cols);
      containerElement.dataset.renderGridRows = String(lifecycle.terminal.rows);
      containerElement.dataset.replayHeld = lifecycle.fittedGridHeld ? "true" : "false";
      attachTerminalWheelLines(lifecycle.terminal);
      if (sessionRef.current.status !== "exited") {
        writeTerminalSessionStatusNotice({
          lastNotice: lastStatusNoticeRef,
          session: sessionRef.current,
          terminal: lifecycle.terminal,
        });
      }
      const prepareClaimedGrid = () => {
        const grid = lifecycle.claimedFitGrid;
        if (
          !lifecycle.fittedGridRevealed &&
          lifecycle.replayCompleted &&
          grid !== null &&
          lifecycle.terminal !== null &&
          lifecycle.outputPipeline !== null &&
          (lifecycle.terminal.cols !== grid.cols || lifecycle.terminal.rows !== grid.rows)
        ) {
          applyTerminalGridAndKeepViewport({
            pipeline: lifecycle.outputPipeline,
            cols: grid.cols,
            rows: grid.rows,
            onGridApplied: updateGridVisibility,
            restoreViewport: () => {
              if (lifecycle.hasRestoredViewport && !lifecycle.hasManualScrollIntent) {
                restoreViewport(true);
              }
            },
          });
        }
      };
      const fitTerminal = () => {
        if (!lifecycle.fitAddon || !lifecycle.terminal) {
          return;
        }
        if (
          !lifecycle.initialRendererSettled ||
          !isPanelOpenRef.current ||
          document.visibilityState !== "visible" ||
          !hasVisibleTerminalSize({ containerElement })
        ) {
          return;
        }
        if (webglVisibilityRef.current?.sync() === false) return;
        const activeTerminal = lifecycle.terminal;
        const activeFitAddon = lifecycle.fitAddon;
        fitWork.run({
          container: containerElement,
          terminal: activeTerminal,
          ptyGrid: lifecycle.latestPtyGrid,
          layoutSettled: lifecycle.initialLayoutSettled,
          rendererSettled: lifecycle.initialRendererSettled,
          retainedOutputReplayed: lifecycle.retainedOutputReplayed,
          work: () => {
            if (lifecycle.screenLoadingPreview)
              measureTerminalPerformance("terminal-fit-snapshot-refresh", () =>
                lifecycle.screenLoadingPreview?.refresh(
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
              lifecycle.localFitGrid?.cols !== fitted.cols ||
              lifecycle.localFitGrid.rows !== fitted.rows
            )
              lifecycle.fittedGridFallback = false;
            lifecycle.localFitGrid = { cols: fitted.cols, rows: fitted.rows };
            if (
              holdForFittedGrid &&
              !lifecycle.initialLayoutSettled &&
              document.fonts?.status !== "loading" &&
              !hasRunningLayoutAnimation(containerElement)
            ) {
              const cached = readCachedTerminalGrid(session.id, activeTerminal.options.fontSize);
              if (
                cached?.cols === fitted.cols && cached.rows === fitted.rows &&
                lifecycle.latestPtyGrid.cols === fitted.cols && lifecycle.latestPtyGrid.rows === fitted.rows
              ) {
                lifecycle.initialLayoutSettled = true;
                markTerminalPerformance("terminal-initial-layout-settled");
                markTerminalPerformance("terminal-cached-layout-reused");
                lifecycle.transport?.markLayoutSettled();
              }
            }
            if (lifecycle.initialLayoutSettled) lifecycle.initialFitComplete = true;
            containerElement.dataset.fitGridCols = String(fitted.cols);
            containerElement.dataset.fitGridRows = String(fitted.rows);
            if (lifecycle.replayPreview)
              measureTerminalPerformance("terminal-fit-preview-layout", () =>
                lifecycle.replayPreview?.setFitGrid(fitted.cols, fitted.rows),
              );
            if (retainNativeOutput && sessionStatusRef.current === "exited") {
              if (lifecycle.retainedOutputReplayed) {
                lifecycle.retainedOutputGrid = {
                  cols: fitted.cols,
                  rows: fitted.rows,
                };
                if (
                  activeTerminal.cols !== fitted.cols ||
                  activeTerminal.rows !== fitted.rows
                ) {
                  activeTerminal.resize(fitted.cols, fitted.rows);
                }
              }
              updateGridVisibility();
              return true;
            }
            updateGridVisibility();
            if (lifecycle.initialLayoutSettled && lifecycle.initialRendererSettled) {
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
                  lifecycle.fittedGridRevealed) &&
                lifecycle.transport !== null &&
                (lifecycle.claimedFitGrid?.cols !== fitted.cols ||
                  lifecycle.claimedFitGrid.rows !== fitted.rows);
              if (lifecycle.transport)
                reconcilePrefetchedTerminalGrid(earlySocketUrl, fitted);
              lifecycle.transport?.sendResize(fitted.cols, fitted.rows, claimFit);
              if (claimFit) {
                if (lifecycle.claimedFitGrid === null)
                  markTerminalPerformance("terminal-first-fitted-grid-claimed");
                markTerminalPerformance("terminal-fitted-grid-claimed");
                lifecycle.claimedFitGrid = { ...fitted };
                prepareClaimedGrid();
              }
            }
            return true;
          },
        });
        lifecycle.checkReplayReveal?.();
      };
      const scheduleFit: TerminalFitScheduler = () => {
        if (lifecycle.resizeAnimationFrame !== null) {
          return;
        }
        lifecycle.resizeAnimationFrame = window.requestAnimationFrame(() => {
          lifecycle.resizeAnimationFrame = null;
          fitTerminal();
        });
      };
      function settleInitialRenderer() {
        if (lifecycle.disposed || lifecycle.terminal === null || lifecycle.initialRendererSettled) return;
        clearTimeout(lifecycle.rendererDeadline);
        lifecycle.initialRendererSettled = true;
        if (lifecycle.webglRenderer?.renderer === "dom") {
          webglVisibilityRef.current?.dispose();
          webglVisibilityRef.current = null;
          lifecycle.webglRenderer.dispose();
          lifecycle.webglRenderer = null;
        }
        markTerminalPerformance("terminal-initial-renderer-settled");
        measureTerminalPerformance(
          "terminal-initial-renderer-fit",
          fitTerminal,
        );
        markTerminalPerformance("terminal-initial-renderer-fit-end");
        resolveRendererSettled();
      }
      if (!lifecycle.initialRendererSettled) {
        lifecycle.rendererDeadline = setTimeout(
          settleInitialRenderer,
          TERMINAL_RENDERER_SETTLE_MS,
        );
        void initialRendererReady.then(() => {
          if (lifecycle.disposed) return;
          fitWork.invalidate();
          scheduleFit();
          if (
            lifecycle.initialRendererSettled ||
            lifecycle.webglRenderer === null ||
            lifecycle.webglRenderer.initialAttemptComplete
          ) {
            settleInitialRenderer();
          }
        });
      }
      fitTerminal();
      const fontSet = document.fonts;
      if (fontSet !== undefined) {
        void fontSet.ready.then(() => {
          if (!lifecycle.disposed)
            markTerminalPerformance("terminal-initial-fonts-ready");
        });
        lifecycle.stopObservingFonts = observeTerminalFontLoading(fontSet, () => {
          if (lifecycle.terminal === null) {
            return;
          }
          fitWork.invalidate();
          forceTerminalFontMeasurement(lifecycle.terminal);
          lifecycle.replayPreview?.refreshFonts();
          scheduleFit();
        });
      }
      scheduleFitRef.current = scheduleFit;
      invalidateFitRef.current = () => fitWork.invalidate();
      lifecycle.unobserveContainerResize = observeSharedResize(containerElement, {
        read: (entry) => {
          const entries = entry === undefined ? [] : [entry];
          return hasVisibleTerminalSize({ containerElement, entries });
        },
        write: (hasSize) => {
        updateGridVisibility();
        if (hasSize !== lifecycle.containerHasSize) {
          lifecycle.containerHasSize = hasSize;
          reportDocumentVisibility();
        }
        if (!hasSize) {
          return;
        }
        scheduleFit();
        },
      });
      const currentActiveElement = document.activeElement;
      if (
        !terminalSearchOpenRef.current &&
        shouldFocusTerminalAfterAsyncMount({
          currentFocusIsAvailable:
            currentActiveElement !== null &&
            currentActiveElement !== document.body &&
            currentActiveElement.isConnected,
          hasExplicitFocusRequest: autoFocusRef.current,
          focusMovedDuringMount:
            currentActiveElement !== lifecycle.activeElementAtMount,
          isPanelOpen: isPanelOpenRef.current,
        })
      ) {
        lifecycle.terminal.focus();
        onAutoFocusHandledRef.current?.();
      }
      lifecycle.activeElementAtMount = null;

      const activeTerminal = lifecycle.terminal!;
      const getReplayState = () => ({
        hasReplaySurface: lifecycle.replayPreview !== null,
        replayStarted: lifecycle.replayStarted,
        replayCompleted: lifecycle.replayCompleted,
        needsHistoryRestore: lifecycle.lastParsedOutputNextSeq === 0,
      });
      const routeQueuedExitNotice = (text: string) => {
        const state = getReplayState();
        routeTerminalExitNotice({
          hasReplaySurface: () => state.hasReplaySurface,
          isReplayStarted: () => state.replayStarted,
          isReplayComplete: () => state.replayCompleted,
          needsHistoryRestore: () => state.needsHistoryRestore,
          restoreTerminalHistory,
          pushReplay: (bytes) => lifecycle.replayPreview?.push(bytes, () => undefined),
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
          if (lifecycle.disposed) return;
          await new Promise<void>((resolve) => {
            const bytes = decodeBase64Bytes(chunk.dataBase64);
            if (lifecycle.outputPipeline) lifecycle.outputPipeline.push(bytes, resolve);
            else activeTerminal.write(bytes, resolve);
          });
          lifecycle.lastParsedOutputNextSeq = Math.max(
            lifecycle.lastParsedOutputNextSeq,
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
          hasReplaySurface: lifecycle.replayPreview !== null,
          replayStarted: lifecycle.replayStarted,
          replayCompleted: lifecycle.replayCompleted,
          needsHistoryRestore: lifecycle.lastParsedOutputNextSeq === 0,
        }),
        pushReplay: (bytes) => lifecycle.replayPreview?.push(bytes, () => undefined),
        queueNotice: (notice) => pendingExitNotices.push(notice),
        restoreTerminalHistory,
        writeTerminal: (text) =>
          writeTerminalStatus({ terminal: activeTerminal, text }),
      });
      const clearConnectionNoticeTimeout = () => {
        if (lifecycle.connectionNoticeTimeout !== null) {
          clearTimeout(lifecycle.connectionNoticeTimeout);
          lifecycle.connectionNoticeTimeout = null;
        }
      };
      const resetTerminalOutput = () => {
        lifecycle.lastQueuedOutputNextSeq = 0;
        hiddenOutput.clear();
        outputLineAnchorTracker.reset();
        outputLineAnchors.length = 0;
        lifecycle.savedOutputLineAnchor = null;
        lifecycle.replayCheckpointSequence = null;
        lifecycle.replayPreview?.dispose();
        lifecycle.replayPreview = null;
        activeTerminal.reset();
        outputBoundaries.reset();
        lifecycle.parsingOutputSequence = null;
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
            (lifecycle.terminalVisible !== true || !isPanelOpenRef.current)
          ) {
            hiddenOutput.push(message.chunk, lifecycle.lastQueuedOutputNextSeq);
            scheduleParkedOutput();
            return;
          }
          if (message.chunk.seq < lifecycle.lastQueuedOutputNextSeq) return;
          lifecycle.lastQueuedOutputNextSeq = message.chunk.seq + 1;
        }
        if (message.type === "attached") {
          lifecycle.replayRevealGeneration += 1;
          lifecycle.fittedGridHeld = false;
          lifecycle.fittedGridRevealed = false;
          lifecycle.fittedGridFallback = false;
          lifecycle.completeReplayReveal = null;
          if (lifecycle.hasReceivedInitialAttach) lifecycle.claimedFitGrid = null;
          lifecycle.checkReplayReveal = null;
          if (lifecycle.replayRevealTimeout !== null) clearTimeout(lifecycle.replayRevealTimeout);
          lifecycle.replayRevealTimeout = null;
          scheduleFit();
          lifecycle.replayTimingNextSeq = message.nextSeq;
          lifecycle.replayTimingFirstFrame = false;
        }
        if (
          message.type === "output" &&
          lifecycle.replayTimingNextSeq !== null &&
          message.chunk.seq < lifecycle.replayTimingNextSeq
        ) {
          if (!lifecycle.replayTimingFirstFrame) {
            lifecycle.replayTimingFirstFrame = true;
            markTerminalPerformance("terminal-replay-first-frame-received", {
              startTime: lifecycle.messageEventTimestamp,
              detail: { terminalId: session.id },
            });
          }
          if (message.chunk.seq + 1 === lifecycle.replayTimingNextSeq) {
            markTerminalPerformance("terminal-replay-last-frame-received", {
              startTime: lifecycle.messageEventTimestamp,
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
          lifecycle.processExitedSeen = true;
          sessionStatusRef.current = "exited";
          activeTerminal.options.disableStdin = true;
          if (retainNativeOutput) {
            fitWork.invalidate();
            scheduleFit();
          }
        }
        if (message.type === "error") {
          if (
            lifecycle.processExitedSeen ||
            lifecycle.replayPreview === null ||
            lifecycle.replayCompleted ||
            message.code === "terminal_exited" ||
            message.code === "terminal_not_found" ||
            message.code === "terminal_not_running"
          ) {
            abandonReplayPreview();
          } else {
            lifecycle.retryStalledReplay();
          }
        }
        if (message.type === "exited") handleReplayPreviewExit();
        if (message.type === "output") {
          lifecycle.latestOutputSequence = Math.max(
            lifecycle.latestOutputSequence,
            message.chunk.seq,
          );
        }
        const currentOutputFrameId =
          message.type === "output" ? lifecycle.outputFrameId : null;
        if (message.type === "output") {
          lifecycle.outputFrameId = null;
          if (!lifecycle.replayCompleted) lifecycle.replayPreview?.noteProgress();
        }
        if (message.type === "attached" || message.type === "session-updated") {
          if (message.type === "attached") {
            lifecycle.hasReceivedInitialAttach = true;
          }
          const { cols, rows } = message.session;
          const isOwnNudgeEcho =
            message.type === "session-updated" &&
            activeTransport.consumeRepaintNudgeEcho(
              { cols, rows },
              message.resizeSeq,
            );
          lifecycle.latestPtyGrid = { cols, rows };
          updateGridVisibility();
          const nextSize = nextSharedTerminalSize(
            lifecycle.sharedSize,
            { cols, rows },
            isOwnNudgeEcho,
          );
          if (nextSize !== null) {
            lifecycle.sharedSize = nextSize;
            lifecycle.replayPreview?.resize(nextSize.cols, nextSize.rows);
            scheduleFit();
          } else {
            lifecycle.replayPreview?.resize(cols, rows);
          }
          if (message.session.status === "exited") {
            handleReplayPreviewExit();
          }
          if (
            message.type === "attached" ||
            !lifecycle.replayCompleted ||
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
          } else if (lifecycle.outputPipeline) {
            applyTerminalGridAndKeepViewport({
              pipeline: lifecycle.outputPipeline,
              cols,
              rows,
              onGridApplied: updateGridVisibility,
              restoreViewport: () => {
                if (lifecycle.hasRestoredViewport && !lifecycle.hasManualScrollIntent) {
                  restoreViewport(true);
                }
              },
            });
          }
        }
        handleTerminalServerMessage({
          acknowledgeOutput: (nextSeq) => {
            lifecycle.lastParsedOutputNextSeq = Math.max(
              lifecycle.lastParsedOutputNextSeq,
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
              message.chunk.seq + 1 === lifecycle.replayTimingNextSeq
            ) {
              markTerminalPerformance("terminal-replay-primary-xterm-parsed", {
                detail: { terminalId: session.id },
              });
            }
            if (
              !lifecycle.disposed &&
              lifecycle.hasReceivedInitialAttach &&
              lifecycle.outputPipeline &&
              (activeTerminal.cols !== lifecycle.latestPtyGrid.cols ||
                activeTerminal.rows !== lifecycle.latestPtyGrid.rows)
            ) {
              applyTerminalGridAndKeepViewport({
                pipeline: lifecycle.outputPipeline,
                cols: lifecycle.latestPtyGrid.cols,
                rows: lifecycle.latestPtyGrid.rows,
                onGridApplied: updateGridVisibility,
                restoreViewport: () => {
                  if (lifecycle.hasRestoredViewport && !lifecycle.hasManualScrollIntent) {
                    restoreViewport(true);
                  }
                },
              });
            }
            if (
              document.visibilityState !== "visible" ||
              !lifecycle.containerHasSize ||
              !isPanelOpenRef.current
            ) {
              cancelTerminalOutputNextRenders(session.id);
            }
          },
          onReplayComplete: () => {
            lifecycle.replayCompleted = true;
            scheduleParkedOutput();
            prepareClaimedGrid();
            markTerminalPerformance("terminal-replay-screens-parsed");
            const revealReplay = () => {
              pendingReplayRevealRef.current = session.id;
              markTerminalPerformance("terminal-replay-parsed", {
                detail: { terminalId: session.id },
              });
              setRestoringSession(false);
              lifecycle.keepScreenLoadingPreview = false;
              clearScreenLoadingPreview();
              containerElement.dataset.replayHeld = "false";
              if (needsFittedGrid() && fittedGridReady()) {
                lifecycle.replayPreview?.dispose();
                lifecycle.replayPreview = null;
              }
              activeTransport.resetRetryBackoff();
              for (const text of pendingExitNotices.splice(0)) {
                routeQueuedExitNotice(text);
              }
              completeTerminalReplayPreview({
                hasPendingExit: lifecycle.exitedBeforeReplayCompleted,
                markExitApplied: () => {
                  lifecycle.replayPreviewExitApplied = true;
                },
                clearPendingExit: () => {
                  lifecycle.exitedBeforeReplayCompleted = false;
                },
                releasePreview: releaseReplayPreview,
                processExited: () => lifecycle.replayPreview?.processExited(),
              });
              applyTerminalGridBeforeViewportRestore({
                pipeline: lifecycle.outputPipeline,
                cols: lifecycle.latestPtyGrid.cols,
                rows: lifecycle.latestPtyGrid.rows,
                onGridApplied: updateGridVisibility,
                restoreViewport,
                afterRestore: () => {
                  if (!lifecycle.disposed)
                    activeTerminal.refresh(0, activeTerminal.rows - 1);
                },
              });
            };
            if (needsFittedGrid() && !lifecycle.fittedGridFallback) {
              lifecycle.completeReplayReveal = revealReplay;
              lifecycle.replayPreview?.hold({ countdown: false });
              holdFittedGrid();
              lifecycle.checkReplayReveal?.();
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
            if (sequence + 1 === lifecycle.replayTimingNextSeq) {
              markTerminalPerformance("terminal-replay-last-xterm-callback", {
                detail: { terminalId: session.id },
              });
            }
            const savedSequence = lifecycle.savedViewportAnchor?.outputSequence;
            if (
              savedSequence !== undefined &&
              sequence >= savedSequence &&
              lifecycle.savedOutputLineAnchor === null
            ) {
              updateSavedOutputLineAnchor(
                outputLineAnchors.find(
                  (candidate) => candidate.sequence === savedSequence,
                ) ?? null,
              );
            }
          },
          replayNextSeq: lifecycle.replayNextSeq,
          replayWriteState,
          outputFrameId: currentOutputFrameId ?? undefined,
          onReplayStart: () => {
            lifecycle.replayStarted = true;
            setRestoringSession(true);
            containerElement.dataset.replayHeld = "true";
            viewportReplaySaveGate.beginReplay();
            lifecycle.replayCompleted = false;
            lifecycle.replayPreviewExitApplied = false;
            setReplayNotice(paintedScreenKept ? "reconnecting" : null);
            if (lifecycle.replayPreview === null || lifecycle.replayPreview.fallback) {
              lifecycle.replayPreview?.dispose();
              lifecycle.replayCheckpointSequence = null;
              const replayGrid = lifecycle.latestPtyGrid;
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
              lifecycle.replayPreview = mountTerminalReplayPreview({
                container: containerElement,
                holdUntilReleased: true,
                onHoldExpired: () => lifecycle.retryStalledReplay(),
                initialFitGrid: lifecycle.localFitGrid,
                isOwner: () =>
                  lifecycle.terminalInputClaimed &&
                  document.hasFocus() &&
                  activeTerminal.element?.contains(document.activeElement) ===
                    true,
                liveTerminal: activeTerminal,
                paddingLeft,
                readyToPaint: () =>
                  lifecycle.initialRendererSettled &&
                  document.fonts?.status !== "loading",
                terminal: previewTerminal,
              });
              lifecycle.replayPreview.setPtyGrid(replayGrid.cols, replayGrid.rows);
              markTerminalPerformance("terminal-replay-preview-create-end");
              if (paintedScreenKept) keepPaintedScreen();
            }
          },
          setReplayNextSeq: (nextSeq) => {
            lifecycle.replayNextSeq = nextSeq;
            if (nextSeq !== null) lifecycle.replayNextSequence = nextSeq;
          },
          setReplayStartSequence: (sequence) => {
            lifecycle.replayStartSequence = sequence;
            lifecycle.latestOutputSequence = Math.max(lifecycle.latestOutputSequence, sequence);
            startTerminalOutputReplay({
              outputLineAnchors,
              sequence,
              tracker: outputLineAnchorTracker,
            });
          },
          terminal: activeTerminal,
          pipeline: lifecycle.outputPipeline ?? undefined,
          replayPipeline: lifecycle.replayPreview ?? undefined,
          replayCheckpointSequence: lifecycle.replayCheckpointSequence,
          writeExitNotice: routeExitNotice,
          outputBoundaries,
          allowAttachedGrid: false,
          shouldProcessOutput: () =>
            parseParkedOutput ||
            (lifecycle.terminalVisible === true && isPanelOpenRef.current),
        });
        if (
          message.type === "output" &&
          message.chunk.seq + 1 === lifecycle.replayTimingNextSeq
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
          lifecycle.outputFrameId = recordTerminalOutputReceived(terminalId, timestamp);
        },
        onMessageEvent: (timestamp) => {
          const now = performance.now();
          lifecycle.messageEventTimestamp =
            timestamp >= 0 && timestamp <= now ? timestamp : now;
        },
        onRepaintNudgeSizeReleased: (size) => {
          const nextSize = nextSharedTerminalSize(lifecycle.sharedSize, size, false);
          if (nextSize !== null) {
            lifecycle.sharedSize = nextSize;
            if (!lifecycle.markerGridActive) {
              lifecycle.latestPtyGrid = nextSize;
              if (lifecycle.outputPipeline) {
                applyTerminalGridAndKeepViewport({
                  pipeline: lifecycle.outputPipeline,
                  cols: nextSize.cols,
                  rows: nextSize.rows,
                  onGridApplied: updateGridVisibility,
                  restoreViewport: () => {
                    if (lifecycle.hasRestoredViewport && !lifecycle.hasManualScrollIntent) {
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
          if (lifecycle.disposed) {
            return;
          }
          fitWork.invalidate();
          if (state === "reconnecting" || state === "closed")
            retentionInvalidatedRef.current?.();
          if (state === "closed") abandonReplayPreview();
          if (
            state === "reconnecting" &&
            !lifecycle.replayCompleted &&
            lifecycle.replayPreview?.fallback === true
          ) {
            lifecycle.replayPreview.hold({ countdown: false });
            setReplayNotice(paintedScreenKept ? "reconnecting" : null);
          }
          if (state === "reconnecting") {
            if (lifecycle.terminalVisible === false) hiddenOutput.invalidate();
            if (lifecycle.isReconnecting) {
              return;
            }
            lifecycle.isReconnecting = true;
            clearConnectionNoticeTimeout();
            setConnectionNotice(null);
            lifecycle.connectionNoticeTimeout = setTimeout(() => {
              lifecycle.connectionNoticeTimeout = null;
              fitWork.invalidate();
              lifecycle.reconnectingNoticeVisible = true;
              setConnectionNotice("reconnecting");
            }, TERMINAL_RECONNECTING_NOTICE_DELAY_MS);
            return;
          }
          lifecycle.isReconnecting = false;
          clearConnectionNoticeTimeout();
          if (state === "attached" && lifecycle.reconnectingNoticeVisible) {
            setConnectionNotice("reconnected");
            lifecycle.connectionNoticeTimeout = setTimeout(() => {
              lifecycle.connectionNoticeTimeout = null;
              setConnectionNotice(null);
            }, TERMINAL_RECONNECTED_NOTICE_DURATION_MS);
          } else {
            setConnectionNotice(null);
          }
          lifecycle.reconnectingNoticeVisible = false;
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
          if (lifecycle.terminalVisible !== true || !isPanelOpenRef.current) {
            for (const chunk of chunks)
              hiddenOutput.push(chunk, lifecycle.lastQueuedOutputNextSeq);
            scheduleParkedOutput();
            return;
          }
          markTerminalPerformance("terminal-replay-batch-dispatch-start");
          measureTerminalPerformance("terminal-replay-batch-dispatch", () => {
            for (const write of terminalReplayWrites(
              chunks,
              outputBoundaries,
              lifecycle.replayCheckpointSequence,
            )) {
              handleMessage({ type: "output", chunk: write.chunk }, write);
            }
          });
        },
        onSequenceGap: () => {
          if (lifecycle.terminalVisible !== true || !isPanelOpenRef.current) {
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
          !lifecycle.disposed && sessionStatusRef.current === "running",
        url: buildTerminalWebSocketUrl({
          handoffOwnerToken:
            wsManager.getDeviceHandoffClientToken() ??
            handoffOwnerTokenRef.current,
          terminalId: session.id,
        }),
      });
      lifecycle.transport = activeTransport;
      activeTransportRef.current = activeTransport;
      const drainParkedOutput = async () => {
        lifecycle.parkedOutputTimer = null;
        if (lifecycle.disposed || !parkedRef.current || !lifecycle.replayCompleted) return;
        lifecycle.parkedOutputDraining = true;
        const started = performance.now();
        await withAsyncFinally(async () => {
          do {
            const chunks = hiddenOutput.takeBatch(8 * 1024);
            if (chunks.length === 0) break;
            for (const write of terminalReplayWrites(
              chunks,
              outputBoundaries,
              lifecycle.replayCheckpointSequence,
            )) {
              handleMessage(
                { type: "output", chunk: write.chunk },
                write,
                true,
              );
            }
            if (lifecycle.outputPipeline)
              await new Promise<void>((resolve) =>
                lifecycle.outputPipeline!.whenParsed(resolve),
              );
          } while (
            !lifecycle.disposed &&
            parkedRef.current &&
            performance.now() - started < 4
          );
        }, () => {
          lifecycle.parkedOutputDraining = false;
          scheduleParkedOutput(0);
        });
      };
      const scheduleParkedOutput = (delay = 250) => {
        if (
          lifecycle.parkedOutputTimer !== null ||
          lifecycle.parkedOutputDraining ||
          !lifecycle.replayCompleted ||
          !hiddenOutput.hasPending ||
          lifecycle.disposed ||
          !parkedRef.current
        )
          return;
        lifecycle.parkedOutputTimer = setTimeout(() => {
          void drainParkedOutput();
        }, delay);
      };
      parkTransportRef.current = (nextParked) => {
        markTerminalPerformance(
          nextParked ? "terminal-view-parked" : "terminal-view-adopted",
          { detail: { terminalId: session.id } },
        );
        activeTransport.setParked(nextParked);
        if (!nextParked) {
          lifecycle.restoreParkedRendering?.();
          lifecycle.restoreParkedRendering = null;
        }
        webglVisibilityRef.current?.sync();
        if (nextParked) {
          lifecycle.paintReveal?.dispose();
          lifecycle.paintReveal = null;
          holdTerminalPaint(containerElement);
          if (lifecycle.restoreParkedRendering === null) {
            lifecycle.restoreParkedRendering =
              releaseParkedTerminalRendering(activeTerminal);
          }
          scheduleParkedOutput();
        } else {
          lifecycle.paintReveal?.dispose();
          lifecycle.paintReveal = revealTerminalAfterRender(
            activeTerminal,
            containerElement,
          );
        }
        if (!nextParked && lifecycle.parkedOutputTimer !== null) {
          clearTimeout(lifecycle.parkedOutputTimer);
          lifecycle.parkedOutputTimer = null;
        }
        reportDocumentVisibility();
      };
      if (parkedRef.current) {
        activeTransport.setParked(true);
        holdTerminalPaint(containerElement);
        scheduleParkedOutput();
      }
      lifecycle.flushHiddenOutput = () => {
        const chunks = hiddenOutput.take();
        if (chunks === null) {
          activeTransport.replayOutputFrom(lifecycle.lastQueuedOutputNextSeq);
          return;
        }
        const replayEnd = lifecycle.replayNextSeq;
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
            lifecycle.replayCheckpointSequence,
          )) {
            handleMessage({ type: "output", chunk: write.chunk }, write);
          }
        }
      };
      claimSizeRef.current = () => {
        lifecycle.terminalInputClaimed = true;
        activeTerminal.focus();
        clearTimeout(lifecycle.rendererDeadline);
        lifecycle.initialRendererSettled = true;
        lifecycle.initialLayoutSettled = true;
        resolveRendererSettled();
        activeTransport.markLayoutSettled();
        activeTransport.claimSize(true);
        fitTerminal();
      };
      lifecycle.retryStalledReplay = () => {
        if (lifecycle.processExitedSeen || lifecycle.exitedBeforeReplayCompleted) {
          abandonReplayPreview();
          return;
        }
        keepPaintedScreen();
        activeTransport.retry();
      };
      fitTerminal();
      reportDocumentVisibility();
      lifecycle.sizeClaims = listenForTerminalSizeClaims({
        claim: (reclaim) => {
          if (parkedRef.current || restoringFocusRef.current) return;
          returningRef.current = false;
          activeTransport.claimSize(reclaim);
        },
        element: containerElement,
        textarea: activeTerminal.textarea,
      });
      lifecycle.sizeClaims.claimIfFocused();
      document.addEventListener("visibilitychange", reportDocumentVisibility);
      if (holdForFittedGrid && sessionStatusRef.current === "running") {
        activeTransport.start();
      }
      if (lifecycle.initialLayoutSettled) activeTransport.markLayoutSettled();
      else lifecycle.stopWatchingLayout = watchTerminalLayoutSettled({
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
            !lifecycle.initialRendererSettled ||
            !isPanelOpenRef.current ||
            document.visibilityState !== "visible"
          )
            return null;
          const fitted = lifecycle.fitAddon?.proposeDimensions();
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
          if (lifecycle.disposed) {
            return;
          }
          captureLiveViewportBeforeGridResize();
          lifecycle.initialLayoutSettled = true;
          markTerminalPerformance("terminal-initial-layout-settled");
          measureTerminalPerformance(
            "terminal-initial-layout-fit",
            fitTerminal,
          );
          activeTransport.markLayoutSettled();
          if (lifecycle.hasRestoredViewport && !lifecycle.hasManualScrollIntent) {
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
        const revealRetainedFallback = () => {
          if (lifecycle.disposed || lifecycle.retainedReplayFailed) return;
          lifecycle.retainedReplayFailed = true;
          lifecycle.retainedOutputReplayed = true;
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
        await withAsyncCatchAndFinally(async () => {
          const outputPromise = sdk.terminals.output({
            terminalId: sessionRef.current.id,
            tailBytes: 64 * 1024,
          });
          lifecycle.retainedReplayTimeout = setTimeout(() => {
            lifecycle.retainedReplayTimeout = null;
            revealRetainedFallback();
          }, TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS);
          const output = await outputPromise;
          if (!lifecycle.disposed) {
            setTruncatedSessionId(retainNativeOutput && output.truncated ? sessionRef.current.id : null);
            if (lifecycle.retainedReplayFailed) {
              resetTerminalOutput();
              lastStatusNoticeRef.current = null;
              pendingExitNotices.length = 0;
              lifecycle.retainedReplayFailed = false;
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
              pipeline: lifecycle.outputPipeline ?? undefined,
              onOutputStart: recordOutputStart,
              onOutputParsed: (sequence) => {
                const outputAnchor = outputLineAnchors.find(
                  (candidate) => candidate.sequence === sequence,
                );
                if (sequence === lifecycle.savedViewportAnchor?.outputSequence) {
                  updateSavedOutputLineAnchor(outputAnchor ?? null);
                }
              },
            });
            if (lifecycle.disposed) return;
            if (retainNativeOutput) {
              lifecycle.retainedOutputReplayed = true;
              fitTerminal();
            }
            flushPendingExitNotices();
            lifecycle.replayStartSequence = output.chunks[0]?.seq ?? output.nextSeq;
            lifecycle.latestOutputSequence = output.chunks.at(-1)?.seq ?? output.nextSeq;
            lifecycle.replayNextSequence = output.nextSeq;
            restoreViewport();
          }
        }, revealRetainedFallback, () => {
          if (lifecycle.retainedReplayTimeout !== null) {
            clearTimeout(lifecycle.retainedReplayTimeout);
            lifecycle.retainedReplayTimeout = null;
          }
        });
      } else if (!holdForFittedGrid) {
        void withAsyncCatch(async () => {
            const snapshot = await screenPromise;
            if (
              !lifecycle.disposed &&
              !lifecycle.replayStarted &&
              !lifecycle.replayCompleted &&
              snapshot !== null &&
              snapshot.complete &&
              !snapshot.truncated &&
              snapshot.dataBase64 !== undefined &&
              snapshot.checkpointSeq !== undefined &&
              snapshot.cols === lifecycle.latestPtyGrid.cols &&
              snapshot.gridRows === lifecycle.latestPtyGrid.rows
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
              lifecycle.replayPreview = mountTerminalReplayPreview({
                container: containerElement,
                initialFitGrid: lifecycle.localFitGrid,
                isOwner: () =>
                  lifecycle.terminalInputClaimed &&
                  document.hasFocus() &&
                  activeTerminal.element?.contains(document.activeElement) ===
                    true,
                liveTerminal: activeTerminal,
                paddingLeft,
                readyToPaint: () =>
                  lifecycle.initialRendererSettled &&
                  document.fonts?.status !== "loading",
                terminal: previewTerminal,
              });
              lifecycle.replayCheckpointSequence = snapshot.checkpointSeq;
              const snapshotFrame = decodeBase64Bytes(snapshot.dataBase64);
              await new Promise<void>((resolve) =>
                lifecycle.replayPreview?.push(snapshotFrame, resolve),
              );
            }
          }, () => {
            if (!lifecycle.replayStarted) {
              lifecycle.replayCheckpointSequence = null;
              lifecycle.replayPreview?.dispose();
              lifecycle.replayPreview = null;
            }
          });
        activeTransport.start();
      }
      if (lifecycle.disposed) return;
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
      lifecycle.terminalInteractions = attachTerminalInteractions({
        element: containerElement.parentElement ?? containerElement,
        getSelection: () => activeTerminal.getSelection(),
        onPointerDown: (event) => {
          if (
            event.target instanceof Node &&
            activeTerminal.element?.contains(event.target)
          ) {
            lifecycle.terminalInputClaimed = true;
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
      lifecycle.terminalKeyDisposable = activeTerminal.onKey(() => {
        if (!lifecycle.terminalInputClaimed) {
          lifecycle.terminalInputClaimed = true;
          updateGridVisibility();
        }
        clearAttentionOnInputRef.current();
      });
      lifecycle.terminalInputForwarding = attachTerminalInputForwarding({
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
      lifecycle.selectionChangeDisposable = activeTerminal.onSelectionChange(
        lifecycle.terminalInteractions.onSelectionChange,
      );
    }

    void mountTerminal(container).catch((error) => {
      discardPrefetchedTerminalSocket(earlySocketUrl);
      clearScreenLoadingPreview();
      if (!lifecycle.disposed) {
        setRestoringSession(false);
        container.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });

    return () => {
      lifecycle.disposed = true;
      if (lifecycle.parkedOutputTimer !== null) clearTimeout(lifecycle.parkedOutputTimer);
      lifecycle.restoreParkedRendering = null;
      lifecycle.paintReveal?.dispose();
      lifecycle.paintReveal = null;
      hiddenOutput.clear();
      lifecycle.flushHiddenOutput = () => {};
      clearScreenLoadingPreview();
      outputLineAnchorTracker.dispose();
      lifecycle.viewportLineAnchor?.dispose();
      lifecycle.viewportLineAnchor = null;
      controlActiveRef.current = false;
      setControlActive(false);
      setTerminalReady(false);
      setScrolledAboveBottom(false);
      setTerminalSearchAddon(null);
      setTerminalSearchOpen(false);
      lifecycle.stopObservingFonts?.();
        lifecycle.stopWatchingLayout?.();
      lifecycle.detachViewportListeners?.();
      lifecycle.sizeClaims?.dispose();
      lifecycle.checkReplayReveal = null;
      if (lifecycle.replayRevealTimeout !== null) clearTimeout(lifecycle.replayRevealTimeout);
      lifecycle.sizeClaims = null;
      if (lifecycle.resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(lifecycle.resizeAnimationFrame);
      }
      if (liveBottomResizeClearFrame !== null) {
        window.cancelAnimationFrame(liveBottomResizeClearFrame);
      }
      if (lifecycle.connectionNoticeTimeout !== null) {
        clearTimeout(lifecycle.connectionNoticeTimeout);
      }
      if (lifecycle.retainedReplayTimeout !== null) {
        clearTimeout(lifecycle.retainedReplayTimeout);
      }
      setConnectionNotice(null);
      lifecycle.unobserveContainerResize?.();
      lifecycle.replayPreview?.dispose();
      lifecycle.replayPreview = null;
      lifecycle.detachPointerCoordinates?.();
      lifecycle.detachPointerCoordinates = null;
      lifecycle.detachGridVisibilityListeners?.();
      lifecycle.detachGridVisibilityListeners = null;
      lifecycle.selectionChangeDisposable?.dispose();
      lifecycle.lateImeInputDisposable?.dispose();
      lifecycle.terminalKeyDisposable?.dispose();
      lifecycle.terminalKeyDisposable = null;
      lifecycle.terminalInputForwarding?.dispose();
      lifecycle.terminalInputForwarding = null;
      lifecycle.shellOscDisposable?.dispose();
      lifecycle.terminalProgressDisposable?.dispose();
      lifecycle.osc52Disposable?.dispose();
      lifecycle.outputBoundaryDisposable?.dispose();
      lifecycle.terminalInteractions?.dispose();
      lifecycle.terminalRenderSubscription?.dispose();
      lifecycle.terminalRenderSubscription = null;
      lifecycle.terminalResizeSubscription?.dispose();
      lifecycle.terminalResizeSubscription = null;
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
      activeTransportRef.current = null;
      lifecycle.transport?.dispose();
      discardPrefetchedTerminalSocket(earlySocketUrl);
      webglVisibilityRef.current?.dispose();
      webglVisibilityRef.current = null;
      clearTimeout(lifecycle.rendererDeadline);
      disposeTerminalWithRenderer(lifecycle.terminal, lifecycle.webglRenderer);
      terminalRef.current = null;
      scheduleFitRef.current = null;
      invalidateFitRef.current = null;
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
      focusTerminalAndResetFlag(terminal, restoringFocusRef);
      onAutoFocusHandledRef.current?.();
    }
    scheduleFitRef.current?.();
  }, [autoFocus, isPanelOpen, session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (session.status === "exited" && retainNativeOutput) {
      invalidateFitRef.current?.();
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
  }, [retainNativeOutput, session]);

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
  const themeColorsRef = useRef<{
    key: string;
    colors: NonNullable<ReturnType<typeof terminalThemeDefaultColors>>;
  } | null>(null);
  const themeControllerRef = useRef("");
  const themeSendPendingRef = useRef(false);
  const syncThemeColorsRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !terminalReady || !handoffOwnerToken) return;
    const viewerKey = JSON.stringify([session.id, handoffOwnerToken]);
    const lifecycle = {
      disposed: false,
      attempts: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const sync = () => {
      clearTimeout(lifecycle.timer);
      lifecycle.timer = setTimeout(() => {
        if (
          lifecycle.disposed ||
          parkedRef.current ||
          themeSendPendingRef.current ||
          (themeControllerRef.current !== viewerKey &&
            (!document.hasFocus() ||
              !terminal.element?.contains(document.activeElement)))
        )
          return;
        const theme = terminal.options.theme ?? {};
        const inputKey = JSON.stringify([theme.foreground, theme.background]);
        const colors =
          themeColorsRef.current?.key === inputKey
            ? themeColorsRef.current.colors
            : terminalThemeDefaultColors(theme);
        if (!colors) return;
        themeColorsRef.current = { key: inputKey, colors };
        const key = JSON.stringify([session.id, handoffOwnerToken, colors]);
        if (key === sentThemeColorsRef.current) return;
        themeSendPendingRef.current = true;
        lifecycle.attempts++;
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
            if (!lifecycle.disposed && lifecycle.attempts < 2) sync();
          })
          .finally(() => {
            themeSendPendingRef.current = false;
            if (lifecycle.disposed) syncThemeColorsRef.current?.();
          });
      }, 100);
    };
    const release = () => {
      sentThemeColorsRef.current = "";
      lifecycle.attempts = 0;
    };
    syncThemeColorsRef.current = sync;
    sync();
    terminal.element?.addEventListener("focusin", sync);
    terminal.element?.addEventListener("focusout", release);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", release);
    return () => {
      lifecycle.disposed = true;
      syncThemeColorsRef.current = null;
      clearTimeout(lifecycle.timer);
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
    let gesture = pinchGestureRef.current;
    if (gesture === null) {
      gesture = createTerminalPinchGesture({
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
      pinchGestureRef.current = gesture;
    }
    return gesture;
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
      {session.status === "exited" && truncatedSessionId === session.id ? (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">
          Showing retained output (up to 64 KiB). Earlier output was truncated.
        </div>
      ) : null}
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
        <TerminalSizeClaimControl terminalId={session.id} touch={isTouchDevice} notice={connectionNoticeText !== null} onClaim={() => claimSizeRef.current?.()} />
      ) : null}
            <TerminalSearch
              terminalId={session.id}
              addon={terminalSearchAddon}
              terminalRef={terminalRef}
              hasTerminal={terminalReady}
              touch={isTouchDevice}
              hideTrigger={attentionShownAsBanner}
              open={terminalSearchOpen}
              focusRequest={findFocusRequest}
              onOpenChange={(open) => {
                setTerminalSearchOpen(open);
                if (open) setFindFocusRequest((request) => (request ?? 0) + 1);
              }}
            />
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
            className={`group/terminal-pane relative min-h-0 w-full flex-1 overflow-hidden bg-sidebar pt-2 md:pt-4 ${isTouchDevice ? (showFitControl ? "touch-pan-x touch-pan-y" : "touch-pan-y") : ""}`}
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
            {scrolledAboveBottom ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Jump to latest output"
                className="absolute bottom-12 right-8 z-10 size-8 shadow-md pointer-coarse:size-11"
                onClick={() => {
                  terminalRef.current?.scrollToBottom();
                  terminalRef.current?.focus();
                }}
              >
                <Icon name="ArrowDown" className="size-4" />
              </Button>
            ) : null}

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
          typingKeys={session.status !== "exited"}
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
