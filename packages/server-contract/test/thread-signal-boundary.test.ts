import { describe, expect, it } from "vitest";
import { threadOpenSignalLenientSchema } from "../src/api/thread-signals.js";
import { threadOpenSignalLenientSchema as publicSchema } from "../src/index.js";

const signal = {
  type: "thread-open",
  projectId: "proj_1",
  threadId: "thr_1",
  split: "right",
  file: { source: "workspace", path: "/a.ts", lineNumber: 2 },
  terminalAction: { action: "openBrowser", terminalId: "term_1", url: "https://example.com" },
  terminalLayoutAction: { action: "move", side: "left", targetTerminalId: "term_2", terminalId: "term_1" },
};

describe("thread-open schema boundary", () => {
  it("keeps terminal actions and strips unknown keys through both entry points", () => {
    expect(publicSchema).toBe(threadOpenSignalLenientSchema);
    expect(threadOpenSignalLenientSchema.parse({ ...signal, future: true })).toEqual(signal);
  });
  it("rejects malformed terminal actions before use", () => {
    expect(threadOpenSignalLenientSchema.safeParse({ ...signal, terminalAction: { action: "invalid", terminalId: "term_1" } }).success).toBe(false);
    expect(threadOpenSignalLenientSchema.safeParse({ ...signal, terminalLayoutAction: { ...signal.terminalLayoutAction, side: "invalid" } }).success).toBe(false);
  });
});
