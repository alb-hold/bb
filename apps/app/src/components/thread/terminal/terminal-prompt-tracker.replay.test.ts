// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { attachTerminalPromptTracker } from "./terminal-prompt-tracker";
import { flushTerminalReplay } from "./terminal-replay-flush";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";

it("publishes the final replay viewport once instead of publishing every scrolled line", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 });
  const onChange = vi.fn();
  const tracker = attachTerminalPromptTracker({ terminal, onChange });
  const pipeline = createTerminalOutputPipeline(terminal, undefined, undefined, {
    flushReplay: () => flushTerminalReplay(terminal, "test"),
  });
  pipeline.push(
    new TextEncoder().encode("line\r\n".repeat(6000)),
    () => {},
    false,
    true,
  );
  await Promise.resolve();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.lastCall?.[0].viewportLine).toBe(
    terminal.buffer.active.viewportY,
  );
  expect(terminal.buffer.active.getLine(5999)?.translateToString(true)).toBe(
    "line",
  );
  terminal.scrollToLine(100);
  await Promise.resolve();
  expect(onChange.mock.lastCall?.[0].viewportLine).toBe(100);
  terminal.scrollToLine(50);
  const calls = onChange.mock.calls.length;
  tracker.dispose();
  await Promise.resolve();
  expect(onChange).toHaveBeenCalledTimes(calls);
  terminal.dispose();
});
