import { useLayoutEffect, useRef } from "react";
import { Button } from "@bb/shared-ui/button";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  PersistentResponsiveDrawerShell,
  useResponsiveDrawerRealization,
} from "@bb/shared-ui/responsive-overlay";

interface TerminalTextSelectSheetProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  text: string;
}

export function TerminalTextSelectSheet({
  onOpenChange,
  open,
  text,
}: TerminalTextSelectSheetProps) {
  const { isContentRealized } = useResponsiveDrawerRealization({ open });
  const textRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [isContentRealized, text]);

  return (
    <PersistentResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      srLabel="Select terminal text"
      contentClassName="h-[min(80dvh,42rem)]"
    >
      {isContentRealized ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
          <div className="flex shrink-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              Touch and hold to select
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
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
          <pre
            ref={textRef}
            data-terminal-text-snapshot=""
            className="min-h-0 flex-1 overflow-auto rounded-md bg-sidebar px-2 py-1 font-mono text-xs whitespace-pre text-foreground select-text"
          >
            {text}
          </pre>
        </div>
      ) : null}
    </PersistentResponsiveDrawerShell>
  );
}
