// @vitest-environment jsdom

import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suppressDuplicateTerminalCompositionInput } from "./terminal-mobile-input";

interface TerminalHarness {
  guard: { dispose: () => void; flushPendingInput: () => void };
  input: HTMLTextAreaElement;
  output: string[];
  terminal: Terminal;
}

const terminals: Terminal[] = [];
const guards: { dispose: () => void }[] = [];

afterEach(() => {
  while (guards.length > 0) guards.pop()?.dispose();
  while (terminals.length > 0) terminals.pop()?.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function openTerminal(): TerminalHarness {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 9 }),
  } as unknown as CanvasRenderingContext2D);
  const host = document.createElement("div");
  document.body.append(host);
  const terminal = new Terminal({ cols: 80, rows: 24 });
  terminals.push(terminal);
  terminal.open(host);
  const input = host.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  if (input === null) throw new Error("xterm input is not mounted");
  const output: string[] = [];
  terminal.onData((data) => output.push(data));
  const element = terminal.element;
  if (element == null) throw new Error("xterm element is not mounted");
  const guard = suppressDuplicateTerminalCompositionInput(
    element.parentElement ?? element,
    (data) => terminal.input(data),
  );
  guards.push(guard);
  return { guard, input, output, terminal };
}

function dispatchInsertText(input: HTMLTextAreaElement, data: string): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value =
    input.value.slice(0, start) + data + input.value.slice(end);
  input.setSelectionRange(start + data.length, start + data.length);
  input.dispatchEvent(
    new InputEvent("input", {
      data,
      inputType: "insertText",
      bubbles: true,
      composed: true,
    }),
  );
}

function dispatchCompositionCommit(
  input: HTMLTextAreaElement,
  data: string,
): void {
  input.dispatchEvent(
    new InputEvent("input", {
      data,
      inputType: "insertText",
      bubbles: true,
      composed: true,
    }),
  );
}

function dispatchComposition(input: HTMLTextAreaElement, data: string): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.dispatchEvent(
    new CompositionEvent("compositionstart", {
      bubbles: true,
      composed: true,
    }),
  );
  input.value = input.value.slice(0, start) + data + input.value.slice(end);
  input.setSelectionRange(start + data.length, start + data.length);
  input.dispatchEvent(
    new CompositionEvent("compositionupdate", {
      data,
      bubbles: true,
      composed: true,
    }),
  );
  input.dispatchEvent(
    new CompositionEvent("compositionend", {
      data,
      bubbles: true,
      composed: true,
    }),
  );
}

async function flushComposition(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mobile terminal IME input through xterm", () => {
  it("sends a committed composition exactly once", async () => {
    const { input, output } = openTerminal();

    dispatchComposition(input, "かな");
    dispatchCompositionCommit(input, "かな");
    await flushComposition();
    dispatchInsertText(input, "!");
    await flushComposition();

    expect(output.join("")).toBe("かな!");
  });

  it("sends nothing when composition is cancelled", async () => {
    const { input, output } = openTerminal();
    input.dispatchEvent(
      new CompositionEvent("compositionstart", {
        bubbles: true,
        composed: true,
      }),
    );
    input.value = "日本";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(
      new CompositionEvent("compositionupdate", {
        data: "日本",
        bubbles: true,
        composed: true,
      }),
    );
    input.value = "";
    input.setSelectionRange(0, 0);
    input.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "",
        bubbles: true,
        composed: true,
      }),
    );
    await flushComposition();

    expect(output.join("")).toBe("");
  });

  it("keeps immediate punctuation after a committed composition in order once", async () => {
    const { input, output } = openTerminal();

    dispatchComposition(input, "日本");
    dispatchCompositionCommit(input, "日本");
    dispatchInsertText(input, "!");
    await flushComposition();

    expect(output.join("")).toBe("日本!");
  });

  it("keeps multiple immediate insertions in FIFO order", async () => {
    const { input, output } = openTerminal();

    dispatchComposition(input, "日本");
    dispatchCompositionCommit(input, "日本");
    dispatchInsertText(input, "!");
    dispatchInsertText(input, "?");
    await flushComposition();

    expect(output.join("")).toBe("日本!?");
  });

  it("flushes a deferred insertion before an immediate Enter keydown", () => {
    const { input, output } = openTerminal();

    dispatchComposition(input, "日本");
    dispatchCompositionCommit(input, "日本");
    dispatchInsertText(input, "!");
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(output.join("")).toBe("日本!\r");
  });

  it("flushes a deferred insertion before a dock arrow write", () => {
    const { guard, input, output, terminal } = openTerminal();

    dispatchComposition(input, "日本");
    dispatchCompositionCommit(input, "日本");
    dispatchInsertText(input, "!");
    guard.flushPendingInput();
    terminal.input("\x1b[D");

    expect(output.join("")).toBe("日本!\x1b[D");
  });

  it("does not write a deferred insertion after disposal", async () => {
    const { guard, input, output } = openTerminal();

    dispatchComposition(input, "日本");
    dispatchCompositionCommit(input, "日本");
    dispatchInsertText(input, "!");

    expect(() => guard.dispose()).not.toThrow();
    await flushComposition();

    expect(output.join("")).toBe("");
  });

  it("sends an echoed command with composed text and trailing punctuation once", async () => {
    const { input, output } = openTerminal();

    dispatchInsertText(input, "echo ");
    dispatchComposition(input, "日本");
    dispatchCompositionCommit(input, "日本");
    dispatchInsertText(input, "!");
    await flushComposition();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushComposition();

    expect(output.join("")).toBe("echo 日本!\r");
  });
});
