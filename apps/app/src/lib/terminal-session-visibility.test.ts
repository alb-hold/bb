import { describe, expect, it } from "vitest";
import type { TerminalSession } from "@bb/server-contract";
import { getThreadTerminalLayoutSessions } from "./terminal-session-visibility";

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "term-1",
    threadId: "thread-1",
    environmentId: "env-1",
    hostId: "host-1",
    title: "Terminal 1",
    initialCwd: "/tmp",
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
    ...overrides,
  };
}

describe("getThreadTerminalLayoutSessions", () => {
  it("accepts live terminals in the requested thread", () => {
    const terminal = session();
    expect(getThreadTerminalLayoutSessions([terminal], [terminal.id], "thread-1")).toEqual([terminal]);
  });

  it.each([
    ["another thread", session({ threadId: "thread-2" })],
    ["an exited session", session({ status: "exited", exitCode: 0 })],
  ])("rejects %s", (_case, terminal) => {
    expect(getThreadTerminalLayoutSessions([terminal], [terminal.id], "thread-1")).toBeNull();
  });
});
