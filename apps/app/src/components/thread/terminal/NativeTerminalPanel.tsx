import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { ThreadTerminalPanel } from "./ThreadTerminalPanel";
import { loadChunkWithRetries } from "@/lib/retryable-chunk-import";
import { prefetchTerminalScreen } from "./terminal-screen-prefetch";
import { mountTerminalScreenLoadingPreview } from "./terminal-screen-loading-preview";
import { SplitLoadFailure } from "@/lib/define-split";

type Panel = typeof ThreadTerminalPanel;

export function NativeTerminalPanel(props: ComponentProps<Panel>) {
  const container = useRef<HTMLDivElement>(null);
  const [View, setView] = useState<Panel | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    void loadChunkWithRetries(() => import("./ThreadTerminalPanel"))
      .then((module) => {
        if (!disposed) setView(() => module.ThreadTerminalPanel);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [attempt]);
  const threadId =
    props.target.kind === "thread" ? props.target.threadId : undefined;
  useEffect(() => {
    if (View || failed || !props.isPanelOpen) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    void prefetchTerminalScreen(props.terminalId, threadId).then((snapshot) => {
      if (
        disposed ||
        !container.current ||
        !snapshot?.complete ||
        snapshot.truncated
      )
        return;
      remove = mountTerminalScreenLoadingPreview({
        container: container.current,
        snapshot,
        fontFamily:
          getComputedStyle(document.documentElement)
            .getPropertyValue("--font-terminal")
            .trim() || "monospace",
        fontSize: 12,
        lineHeight: 1,
      });
    });
    return () => {
      disposed = true;
      remove?.();
    };
  }, [View, failed, props.isPanelOpen, props.terminalId, threadId]);
  if (failed)
    return (
      <SplitLoadFailure
        retry={() => {
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
      />
    );
  return View ? (
    <View {...props} />
  ) : (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-sidebar">
      <div
        ref={container}
        aria-label="Loading terminal"
        role="status"
        className="h-full"
      />
    </div>
  );
}
