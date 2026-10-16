import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread row-status and progress", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("sets a status and progress on the current BB thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const update = vi.fn(async ({ json }: { json: unknown }) => ({
      statuses: { review: { value: "Ready", icon: "✓", priority: 3 } },
      progress: { value: 0.5, label: "Review" },
    }));
    stubServerApi({ "v1.threads.:id.row-state.$patch": update });

    await runCommand(
      [
        "thread",
        "row-status",
        "set",
        "review",
        "Ready",
        "--icon",
        "✓",
        "--priority",
        "3",
      ],
      register,
    );
    expect(update.mock.calls[0]?.[0]).toEqual({
      param: { id: "thread-current" },
      json: {
        action: "status-set",
        key: "review",
        status: { value: "Ready", icon: "✓", priority: 3 },
      },
    });

    await runCommand(
      ["thread", "progress", "0.5", "--label", "Review"],
      register,
    );
    expect(update.mock.calls[1]?.[0]).toEqual({
      param: { id: "thread-current" },
      json: {
        action: "progress-set",
        progress: { value: 0.5, label: "Review" },
      },
    });
  });

  it("lists current thread statuses", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const read = vi.fn(async () => ({
      statuses: { review: { value: "Ready" } },
      progress: null,
    }));
    stubServerApi({ "v1.threads.:id.row-state.$get": read });

    await runCommand(["thread", "row-status", "list"], register);

    expect(read).toHaveBeenCalledWith({ param: { id: "thread-current" } });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      expect.stringContaining('"review": {'),
    );
  });

  it("clears one status, all statuses, and progress", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const update = vi.fn(async (_request: { json: unknown }) => ({
      statuses: {},
      progress: null,
    }));
    stubServerApi({ "v1.threads.:id.row-state.$patch": update });

    await runCommand(["thread", "row-status", "clear", "review"], register);
    await runCommand(["thread", "row-status", "clear"], register);
    await runCommand(["thread", "progress", "clear"], register);

    expect(update.mock.calls.map(([request]) => request.json)).toEqual([
      { action: "status-clear", key: "review" },
      { action: "status-clear" },
      { action: "progress-clear" },
    ]);
  });

  it("registers row-status commands separately from the show aliases", () => {
    const program = new Command();
    register(program);
    const threadCommand = program.commands.find(
      (command) => command.name() === "thread",
    );
    const showCommand = threadCommand?.commands.find(
      (command) => command.name() === "show",
    );
    expect(showCommand?.aliases()).toContain("status");
    expect(
      showCommand?.commands.some((command) => command.name() === "set"),
    ).toBe(false);
    expect(
      showCommand?.commands.some((command) => command.name() === "list"),
    ).toBe(false);
    expect(
      showCommand?.commands.some((command) => command.name() === "clear"),
    ).toBe(false);
    expect(
      threadCommand?.commands.some(
        (command) => command.name() === "row-status",
      ),
    ).toBe(true);
  });
});
