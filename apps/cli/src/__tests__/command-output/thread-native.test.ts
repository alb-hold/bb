import type { NativeTerminalThread } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

const VIEW: NativeTerminalThread = {
  threadId: "thr_chat",
  providerId: "claude-code",
  displayName: "Claude Code",
  nativeSessionId: "2e624c50-68af-4689-9410-06caa371eb8a",
  terminal: {
    id: "term_native",
    threadId: "thr_chat",
    environmentId: "env_1",
    hostId: "host_1",
    title: "claude",
    initialCwd: "/workspace",
    cols: 120,
    rows: 40,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 0,
    updatedAt: 0,
    lastUserInputAt: null,
  },
};

describe("bb thread native --convert / --chat", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("moves a chat thread to its terminal on the same session", async () => {
    const switchMode = vi.fn(async () => VIEW);
    const open = vi.fn(async () => VIEW);
    stubServerApi({
      "v1.threads.:id.native-terminal.mode.$post": switchMode,
      "v1.threads.:id.native-terminal.open.$post": open,
    });

    await runCommand(["thread", "native", "thr_chat", "--convert"], register);

    expect(switchMode).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_chat" },
        json: { mode: "terminal" },
      }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "term_native",
    );
  });

  it("moves a converted thread back to chat", async () => {
    const switchMode = vi.fn(async () => null);
    stubServerApi({ "v1.threads.:id.native-terminal.mode.$post": switchMode });

    await runCommand(["thread", "native", "thr_chat", "--chat"], register);

    expect(switchMode).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thr_chat" },
        json: { mode: "chat" },
      }),
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thr_chat is back in chat",
    );
  });

  it("refuses --chat with --convert or --attach before calling the server", async () => {
    const switchMode = vi.fn(async () => null);
    stubServerApi({ "v1.threads.:id.native-terminal.mode.$post": switchMode });
    for (const flag of ["--convert", "--attach"]) {
      await expect(
        runCommand(["thread", "native", "thr_chat", "--chat", flag], register),
      ).rejects.toThrow("process.exit:1");
    }
    expect(switchMode).not.toHaveBeenCalled();
  });
});
