import { describe, expect, it } from "vitest";
import { selectPinnedSettingsEnv } from "./pinned-settings.js";

describe("selectPinnedSettingsEnv", () => {
  it("copies the listed variables and blanks the ones the launch env lacks", () => {
    expect(
      selectPinnedSettingsEnv({
        BB_CLAUDE_SETTINGS_ENV_PIN: "A_ONE, B_TWO,C_THREE",
        A_ONE: "1",
        B_TWO: "",
      }),
    ).toEqual({ A_ONE: "1", B_TWO: "", C_THREE: "" });
  });

  it("returns null without the marker and ignores invalid names and the marker itself", () => {
    expect(selectPinnedSettingsEnv({ A_ONE: "1" })).toBeNull();
    expect(
      selectPinnedSettingsEnv({
        BB_CLAUDE_SETTINGS_ENV_PIN: "BB_CLAUDE_SETTINGS_ENV_PIN,1BAD,A-B,,",
      }),
    ).toBeNull();
  });
});
