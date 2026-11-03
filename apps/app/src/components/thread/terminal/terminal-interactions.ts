import { getNewTerminalSelection } from "./terminal-file-drop";

export interface TerminalInteractions {
  onSelectionChange: () => void;
  dispose: () => void;
}

interface AttachTerminalInteractionsArgs {
  element: HTMLElement;
  getSelection: () => string;
  onPointerDown: (event: PointerEvent) => void;
  onPointerRelease: (event: PointerEvent) => void;
  onPointerCancel: () => void;
  onSelection: (text: string) => void;
  copySelection: (text: string) => void;
  onFilesDrop: (files: FileList) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export function attachTerminalInteractions({
  element,
  getSelection,
  onPointerDown,
  onPointerRelease,
  onPointerCancel,
  onSelection,
  copySelection,
  onFilesDrop,
  requestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame = window.cancelAnimationFrame.bind(window),
}: AttachTerminalInteractionsArgs): TerminalInteractions {
  let pointerIsDown = false;
  let pendingFrame: number | null = null;
  let lastCopiedSelection = "";
  const reportSelection = () => {
    pendingFrame = null;
    const text = getSelection();
    onSelection(text);
    const nextCopy = getNewTerminalSelection(text, lastCopiedSelection);
    if (nextCopy !== null) {
      lastCopiedSelection = nextCopy;
      copySelection(nextCopy);
    } else if (text.trim().length === 0) {
      lastCopiedSelection = "";
    }
  };
  const scheduleSelection = () => {
    if (pointerIsDown) return;
    if (pendingFrame !== null) cancelFrame(pendingFrame);
    pendingFrame = requestFrame(reportSelection);
  };
  const handlePointerDown = (event: PointerEvent) => {
    pointerIsDown = true;
    lastCopiedSelection = "";
    if (pendingFrame !== null) {
      cancelFrame(pendingFrame);
      pendingFrame = null;
    }
    onPointerDown(event);
  };
  const handlePointerUp = (event: PointerEvent) => {
    if (!pointerIsDown) return;
    pointerIsDown = false;
    onPointerRelease(event);
    scheduleSelection();
  };
  const handlePointerCancel = () => {
    if (!pointerIsDown) return;
    pointerIsDown = false;
    onPointerCancel();
    scheduleSelection();
  };
  const handleDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  };
  const handleDrop = (event: DragEvent) => {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    onFilesDrop(files);
  };

  element.addEventListener("pointerdown", handlePointerDown);
  element.addEventListener("dragover", handleDragOver);
  element.addEventListener("drop", handleDrop);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);

  return {
    onSelectionChange: scheduleSelection,
    dispose: () => {
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("dragover", handleDragOver);
      element.removeEventListener("drop", handleDrop);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      if (pendingFrame !== null) cancelFrame(pendingFrame);
    },
  };
}
