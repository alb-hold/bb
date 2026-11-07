// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { flushTerminalReplay } from "./terminal-replay-flush";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";

it("parses a retained batch and its control strings before a timer can be delayed by mounting UI", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const parsed = vi.fn();
  const osc = vi.fn(() => true);
  terminal.parser.registerOscHandler(7799, osc);
  const bytes = new TextEncoder().encode(
    "retained\r\n".repeat(680) + "\x1b]7799;boundary\x07",
  );
  const pipeline = createTerminalOutputPipeline(
    terminal,
    undefined,
    undefined,
    {
      flushReplay: () => flushTerminalReplay(terminal, "test"),
    },
  );
  const start = performance.now();
  pipeline.push(bytes, parsed, false, true);
  expect(osc).toHaveBeenCalledWith("boundary");
  expect(parsed).not.toHaveBeenCalled();
  await Promise.resolve();
  console.info("P101 bounded replay flush", {
    bytes: bytes.length,
    elapsedMs: performance.now() - start,
  });
  expect(parsed).toHaveBeenCalledOnce();
  expect(osc).toHaveBeenCalledWith("boundary");
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
    "retained",
  );
  expect(terminal.cols).toBe(80);
  expect(terminal.rows).toBe(24);
  terminal.dispose();
});

it("leaves oversized queued output on xterm's asynchronous path", () => {
  const terminal = new Terminal();
  const parsed = vi.fn();
  terminal.write(new Uint8Array(16 * 1024 + 1), parsed);
  flushTerminalReplay(terminal, "test");
  expect(parsed).not.toHaveBeenCalled();
  terminal.dispose();
});
