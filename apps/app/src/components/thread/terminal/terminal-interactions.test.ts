// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTerminalFileDrop } from "./terminal-file-drop";
import { attachTerminalInteractions } from "./terminal-interactions";

function createFrameQueue() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => {
    callbacks.delete(id);
  });
  return {
    requestFrame,
    cancelFrame,
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0);
    },
  };
}

function pointerEvent(type: string, clientX = 0, clientY = 0): PointerEvent {
  return Object.assign(new Event(type, { bubbles: true }), {
    clientX,
    clientY,
  }) as PointerEvent;
}

function dragEvent(
  type: string,
  dataTransfer: { files?: FileList; types: string[] },
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event as DragEvent;
}

function dropEvent(files: FileList): DragEvent {
  return dragEvent("drop", { files, types: ["Files"] });
}

describe("terminal interactions in the DOM", () => {
  const disposables: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposables.splice(0)) dispose();
    document.body.replaceChildren();
  });

  it("reports and copies a selection when its pointer is released outside the terminal", () => {
    const terminal = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(terminal, outside);
    const frames = createFrameQueue();
    const copySelection = vi.fn();
    const onSelection = vi.fn();
    let selection = "  indented line\n";
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => selection,
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection,
      copySelection,
      onFilesDrop: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    disposables.push(interactions.dispose);

    terminal.dispatchEvent(pointerEvent("pointerdown", 3, 4));
    outside.dispatchEvent(pointerEvent("pointerup", 40, 50));
    frames.flush();

    expect(onSelection).toHaveBeenCalledWith("  indented line\n");
    expect(copySelection).toHaveBeenCalledWith("  indented line\n");
  });

  it("copies the same text again on a new selection gesture but once per gesture", () => {
    const terminal = document.createElement("div");
    document.body.append(terminal);
    const frames = createFrameQueue();
    const copySelection = vi.fn();
    let selection = "same line";
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => selection,
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection: vi.fn(),
      copySelection,
      onFilesDrop: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    disposables.push(interactions.dispose);

    terminal.dispatchEvent(pointerEvent("pointerdown"));
    terminal.dispatchEvent(pointerEvent("pointerup"));
    frames.flush();
    interactions.onSelectionChange();
    frames.flush();
    expect(copySelection).toHaveBeenCalledTimes(1);

    terminal.dispatchEvent(pointerEvent("pointerdown"));
    selection = "";
    interactions.onSelectionChange();
    selection = "same line";
    interactions.onSelectionChange();
    terminal.dispatchEvent(pointerEvent("pointerup"));
    frames.flush();

    expect(copySelection).toHaveBeenCalledTimes(2);
    expect(copySelection).toHaveBeenLastCalledWith("same line");
  });

  it("drops a selection frame queued before a new gesture and copies only the final selection", () => {
    const terminal = document.createElement("div");
    document.body.append(terminal);
    const frames = createFrameQueue();
    const copySelection = vi.fn();
    const onSelection = vi.fn();
    let selection = "transient";
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => selection,
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection,
      copySelection,
      onFilesDrop: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    disposables.push(interactions.dispose);

    interactions.onSelectionChange();
    terminal.dispatchEvent(pointerEvent("pointerdown"));
    frames.flush();
    selection = "final text";
    terminal.dispatchEvent(pointerEvent("pointerup"));
    frames.flush();

    expect(onSelection.mock.calls).toEqual([["final text"]]);
    expect(copySelection.mock.calls).toEqual([["final text"]]);
  });

  it("replaces a pending selection frame when xterm reports a newer selection", () => {
    const terminal = document.createElement("div");
    const frames = createFrameQueue();
    const onSelection = vi.fn();
    const copySelection = vi.fn();
    let selection = "first";
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => selection,
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection,
      copySelection,
      onFilesDrop: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    disposables.push(interactions.dispose);

    interactions.onSelectionChange();
    selection = "second";
    interactions.onSelectionChange();
    frames.flush();

    expect(frames.cancelFrame).toHaveBeenCalledWith(1);
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenCalledWith("second");
    expect(copySelection).toHaveBeenCalledOnce();
    expect(copySelection).toHaveBeenCalledWith("second");
  });

  it("accepts a file drag over the terminal so the browser fires the drop", () => {
    const terminal = document.createElement("div");
    document.body.append(terminal);
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => "",
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection: vi.fn(),
      copySelection: vi.fn(),
      onFilesDrop: vi.fn(),
    });
    disposables.push(interactions.dispose);
    const fileDrag = dragEvent("dragover", { types: ["Files"] });
    const textDrag = dragEvent("dragover", { types: ["text/plain"] });

    terminal.dispatchEvent(fileDrag);
    terminal.dispatchEvent(textDrag);

    expect(fileDrag.defaultPrevented).toBe(true);
    expect(textDrag.defaultPrevented).toBe(false);
  });

  it("sends quoted paths from a running terminal file drop", () => {
    const terminal = document.createElement("div");
    document.body.append(terminal);
    const sendInput = vi.fn();
    const claimSize = vi.fn();
    const files = [new File([""], "first file.txt"), new File([""], "two.txt")];
    const fileList = Object.assign(files, {
      item: (index: number) => files[index],
    }) as unknown as FileList;
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => "",
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection: vi.fn(),
      copySelection: vi.fn(),
      onFilesDrop: (droppedFiles) => {
        handleTerminalFileDrop({
          files: Array.from(droppedFiles),
          getPathForFile: (file) => `/tmp/${file.name}`,
          isRunning: true,
          claimSize,
          sendInput,
        });
      },
    });
    disposables.push(interactions.dispose);
    const event = dropEvent(fileList);

    terminal.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(sendInput).toHaveBeenCalledWith(
      "'/tmp/first file.txt' '/tmp/two.txt'",
    );
    expect(claimSize).toHaveBeenCalledOnce();
  });

  it("sends nothing for a browser drop without a desktop path bridge", () => {
    const terminal = document.createElement("div");
    const sendInput = vi.fn();
    const claimSize = vi.fn();
    const fileList = Object.assign([new File([""], "browser.txt")], {
      item: (index: number) =>
        index === 0 ? new File([""], "browser.txt") : null,
    }) as unknown as FileList;
    const interactions = attachTerminalInteractions({
      element: terminal,
      getSelection: () => "",
      onPointerDown: vi.fn(),
      onPointerRelease: vi.fn(),
      onPointerCancel: vi.fn(),
      onSelection: vi.fn(),
      copySelection: vi.fn(),
      onFilesDrop: (droppedFiles) => {
        handleTerminalFileDrop({
          files: Array.from(droppedFiles),
          getPathForFile: undefined,
          isRunning: true,
          claimSize,
          sendInput,
        });
      },
    });
    disposables.push(interactions.dispose);

    terminal.dispatchEvent(dropEvent(fileList));

    expect(sendInput).not.toHaveBeenCalled();
    expect(claimSize).not.toHaveBeenCalled();
  });
});
