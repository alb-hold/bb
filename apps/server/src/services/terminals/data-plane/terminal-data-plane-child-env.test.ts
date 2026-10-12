import { describe, expect, it } from "vitest";
import { terminalDataPlaneChildEnv } from "./terminal-data-plane.js";

describe("terminalDataPlaneChildEnv", () => {
  it("passes only the allowlisted variables to the data plane child", () => {
    expect(
      terminalDataPlaneChildEnv({
        ANTHROPIC_API_KEY: "secret",
        BB_HOST_KEY: "secret",
        NODE_OPTIONS: "--max-old-space-size=512",
        OPENAI_API_KEY: "secret",
        PATH: "/usr/bin",
        TZ: "UTC",
      }),
    ).toEqual({
      NODE_OPTIONS: "--max-old-space-size=512",
      PATH: "/usr/bin",
      TZ: "UTC",
    });
  });

  it("omits allowlisted variables the server does not have", () => {
    expect(terminalDataPlaneChildEnv({ SECRET_TOKEN: "secret" })).toEqual({});
  });
});
