import { useLayoutEffect, useRef } from "react";
import { markTerminalPerformance } from "@/lib/terminal-performance";

export function useTerminalMountGate(
  name: string,
  id: string,
  ready: boolean,
): void {
  const ended = useRef(false);
  useLayoutEffect(() => {
    ended.current = false;
    markTerminalPerformance(`${name}-start`, { detail: { id } });
  }, [name, id]);
  useLayoutEffect(() => {
    if (!ready || ended.current) return;
    ended.current = true;
    markTerminalPerformance(`${name}-end`, { detail: { id } });
  }, [name, id, ready]);
}

export function useTerminalSuspenseGate(name: string): void {
  useLayoutEffect(() => {
    markTerminalPerformance(`${name}-start`);
    return () => markTerminalPerformance(`${name}-end`);
  }, [name]);
}
