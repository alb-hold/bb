import { describe, expect, it } from "vitest";
import { CODEX_NATIVE_LAUNCH_ARGS } from "./native-launch.js";

describe("CODEX_NATIVE_LAUNCH_ARGS", () => {
  it("turns off the startup update picker, which blocks an unattended resume", () => {
    const index = CODEX_NATIVE_LAUNCH_ARGS.indexOf(
      "check_for_update_on_startup=false",
    );
    expect(index).toBeGreaterThan(0);
    expect(CODEX_NATIVE_LAUNCH_ARGS[index - 1]).toBe("-c");
  });

  it("keeps the session in the terminal and the transcript in scrollback", () => {
    expect(CODEX_NATIVE_LAUNCH_ARGS).toEqual(
      expect.arrayContaining([
        "--no-daemon",
        "--no-alt-screen",
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
    );
  });
});
