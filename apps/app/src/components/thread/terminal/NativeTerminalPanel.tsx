import { useEffect, useState, type ComponentProps } from "react";
import type { ThreadTerminalPanel } from "./ThreadTerminalPanel";
import { loadChunkWithRetries } from "@/lib/retryable-chunk-import";
import { SplitLoadFailure } from "@/lib/define-split";

type Panel = typeof ThreadTerminalPanel;

export function NativeTerminalPanel(props: ComponentProps<Panel>) {
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
    <div
      aria-label="Loading terminal"
      role="status"
      className="min-h-0 flex-1"
    />
  );
}
