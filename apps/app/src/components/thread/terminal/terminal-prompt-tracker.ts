import type { Terminal } from "@xterm/xterm";
import {
  registerTerminalShellOscHandlers,
  type TerminalShellEvent,
} from "./terminal-shell-state";

export interface TerminalCommandMark {
  exitCode: number | null;
  line: number;
}

export interface TerminalPromptTrackerState {
  commandMarks: TerminalCommandMark[];
  lineHeight: number;
  promptLines: number[];
  viewportLine: number;
}

const MAX_RETAINED_MARKS = 10_000;

export function attachTerminalPromptTracker(args: {
  onCwdChange?: (cwd: string) => void;
  onChange: (state: TerminalPromptTrackerState) => void;
  terminal: Terminal;
}): { dispose(): void } {
  const state: TerminalPromptTrackerState = {
    commandMarks: [],
    lineHeight: 16,
    promptLines: [],
    viewportLine: args.terminal.buffer.active.viewportY,
  };
  const publish = () =>
    args.onChange({
      ...state,
      commandMarks: [...state.commandMarks],
      promptLines: [...state.promptLines],
    });
  const measureLineHeight = () => {
    const row =
      args.terminal.element?.querySelector<HTMLElement>(".xterm-rows > div");
    const height = row?.getBoundingClientRect().height ?? 0;
    if (height > 0 && height !== state.lineHeight) {
      state.lineHeight = height;
      publish();
    }
  };
  const onShellEvent = (event: TerminalShellEvent) => {
    const line =
      args.terminal.buffer.active.baseY + args.terminal.buffer.active.cursorY;
    if (event.type === "prompt-start") {
      if (state.promptLines.at(-1) !== line) state.promptLines.push(line);
      if (state.promptLines.length > MAX_RETAINED_MARKS)
        state.promptLines.shift();
      publish();
      return;
    }
    if (event.type === "cwd") {
      args.onCwdChange?.(event.cwd);
      return;
    }
    if (event.type === "command-start") {
      const last = state.commandMarks.at(-1);
      if (last === undefined || last.exitCode !== null) {
        state.commandMarks.push({ line, exitCode: null });
      }
      return;
    }
    if (event.type === "command-finish") {
      const last = state.commandMarks.at(-1);
      if (last && last.exitCode === null) {
        state.commandMarks[state.commandMarks.length - 1] = {
          line: last.line,
          exitCode: event.exitCode,
        };
        if (state.commandMarks.length > MAX_RETAINED_MARKS)
          state.commandMarks.shift();
        publish();
      }
    }
  };
  const oscDisposable = registerTerminalShellOscHandlers(
    args.terminal.parser,
    onShellEvent,
  );
  const scrollDisposable = args.terminal.onScroll((viewportLine) => {
    state.viewportLine = viewportLine;
    publish();
  });
  const renderDisposable = args.terminal.onRender(measureLineHeight);
  measureLineHeight();
  return {
    dispose: () => {
      oscDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
    },
  };
}
