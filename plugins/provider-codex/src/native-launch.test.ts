import { describe, expect, it } from "vitest";
import { CODEX_NATIVE_UPDATE_PROMPT_ARGS } from "./native-launch.js";

describe("CODEX_NATIVE_UPDATE_PROMPT_ARGS", () => {
  it("turns off the startup update picker, which blocks an unattended resume", () => {
    expect(CODEX_NATIVE_UPDATE_PROMPT_ARGS).toEqual([
      "-c",
      "check_for_update_on_startup=false",
    ]);
  });
});
