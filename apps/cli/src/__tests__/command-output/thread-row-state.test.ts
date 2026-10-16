import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread status and progress", () => {
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
      ["thread", "status", "set", "review", "Ready", "--icon", "✓", "--priority", "3"],
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

    await runCommand(["thread", "progress", "0.5", "--label", "Review"], register);
    expect(update.mock.calls[1]?.[0]).toEqual({
      param: { id: "thread-current" },
      json: { action: "progress-set", progress: { value: 0.5, label: "Review" } },
    });
  });

  it("lists current thread statuses", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const read = vi.fn(async () => ({
      statuses: { review: { value: "Ready" } },
      progress: null,
    }));
    stubServerApi({ "v1.threads.:id.row-state.$get": read });

    await runCommand(["thread", "status", "list"], register);

    expect(read).toHaveBeenCalledWith({ param: { id: "thread-current" } });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      expect.stringContaining('"review": {'),
    );
  });
});
