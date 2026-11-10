import { useEffect, useState, type ComponentProps } from "react";
import type { ThreadTerminalPanel } from "./ThreadTerminalPanel";
import { useTerminalMountGate } from "@/hooks/useTerminalMountGate";
import { SplitLoadFailure } from "@/lib/define-split";
import {
  loadNativeTerminalPanel,
  readNativeTerminalPanel,
} from "./native-terminal-panel-loader";

type Panel = typeof ThreadTerminalPanel;

export function NativeTerminalPanel(props: ComponentProps<Panel>) {
  const [View, setView] = useState<Panel | null>(readNativeTerminalPanel);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useTerminalMountGate(
    "terminal-native-panel-mount",
    props.terminalId,
    View !== null,
  );
  useEffect(() => {
    let disposed = false;
    void loadNativeTerminalPanel()
      .then((panel) => {
        if (!disposed) setView(() => panel);
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
