import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerManagerCommands } from "../../commands/manager.js";

describe("bb manager compatibility output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerManagerCommands(program);

  it("suggests including archived children in the replacement command", async () => {
    await expect(runCommand(["manager", "list"], register)).rejects.toThrow(
      "process.exit:1",
    );

    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "bb thread list --parent-thread <id> --all",
    );
  });
});
