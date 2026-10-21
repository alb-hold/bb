import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  PersistentResponsiveDrawerShell,
  useResponsiveDrawerRealization,
} from "@bb/shared-ui/responsive-overlay";

interface TerminalTextSelectSheetProps {
  onOpenChange: (open: boolean) => void;
  initialLine?: number | null;
  open: boolean;
  text: string;
}

export function TerminalTextSelectSheet({
  onOpenChange,
  initialLine = null,
  open,
  text,
}: TerminalTextSelectSheetProps) {
  const { isContentRealized } = useResponsiveDrawerRealization({ open });
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [hasSelection, setHasSelection] = useState(false);

  const updateSelection = useCallback(() => {
    const element = textRef.current;
    setHasSelection(
      element !== null && element.selectionStart !== element.selectionEnd,
    );
  }, []);

  const copySelection = useCallback(() => {
    const element = textRef.current;
    if (element === null || element.selectionStart === element.selectionEnd) {
      return;
    }
    void copyToClipboardWithToast(
      element.value.slice(element.selectionStart, element.selectionEnd),
      {
        successMessage: "Terminal text copied",
        errorMessage: "Failed to copy",
      },
    );
  }, []);

  const selectPressedLine = useCallback(() => {
    const element = textRef.current;
    if (element === null || initialLine === null) return;
    const lineStart = element.value
      .split("\n")
      .slice(0, Math.max(0, initialLine))
      .reduce((offset, line) => offset + line.length + 1, 0);
    const newline = element.value.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? element.value.length : newline;
    element.focus({ preventScroll: true });
    element.setSelectionRange(lineStart, lineEnd);
    updateSelection();
  }, [initialLine, updateSelection]);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (element === null) return;
    if (initialLine === null) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const lineStart = element.value
        .split("\n")
        .slice(0, Math.max(0, initialLine))
        .reduce((offset, line) => offset + line.length + 1, 0);
      if (document.activeElement !== element) {
        element.focus({ preventScroll: true });
      }
      element.setSelectionRange(lineStart, lineStart);
      const beforeLine = element.value.slice(0, lineStart);
      element.scrollTop =
        (beforeLine.match(/\n/g)?.length ?? 0) *
        (element.scrollHeight / Math.max(1, element.value.split("\n").length));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialLine, isContentRealized, text]);

  return (
    <PersistentResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      srLabel="Select terminal text"
      contentClassName="h-[min(80dvh,42rem)]"
    >
      {isContentRealized ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="w-full truncate text-xs text-muted-foreground">
              Touch and hold to select, then Copy selection
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void copyToClipboardWithToast(text, {
                  successMessage: "Terminal text copied",
                  errorMessage: "Failed to copy",
                });
              }}
            >
              Copy all
            </Button>
            {initialLine !== null ? (
              <Button type="button" variant="ghost" onClick={selectPressedLine}>
                Select line
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={!hasSelection}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={copySelection}
            >
              Copy selection
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
          <textarea
            ref={textRef}
            aria-label="Terminal text snapshot"
            autoCapitalize="off"
            autoCorrect="off"
            data-terminal-text-snapshot=""
            inputMode="none"
            onSelect={updateSelection}
            onPointerUp={updateSelection}
            onTouchEnd={updateSelection}
            readOnly
            spellCheck={false}
            wrap="off"
            className="block min-h-0 flex-1 resize-none overflow-auto rounded-md border-0 bg-sidebar px-2 py-1 font-mono text-xs whitespace-pre text-foreground outline-none select-text"
            value={text}
          />
        </div>
      ) : null}
    </PersistentResponsiveDrawerShell>
  );
}
