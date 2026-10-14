import { useLayoutEffect, useRef } from "react";
import { Button } from "@bb/shared-ui/button";

interface TerminalTextSelectSheetProps {
  onClose: () => void;
  onCopyAll: () => void;
  text: string;
}

export function TerminalTextSelectSheet({
  onClose,
  onCopyAll,
  text,
}: TerminalTextSelectSheetProps) {
  const textRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text]);

  return (
    <div
      role="dialog"
      aria-label="Select terminal text"
      className="absolute inset-0 z-10 flex flex-col bg-sidebar"
      data-no-sidebar-swipe=""
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Touch and hold to select
        </span>
        <Button type="button" variant="ghost" onClick={onCopyAll}>
          Copy all
        </Button>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
      <pre
        ref={textRef}
        data-terminal-text-snapshot=""
        className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs whitespace-pre text-foreground select-text"
      >
        {text}
      </pre>
    </div>
  );
}
