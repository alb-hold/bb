import { describe, expect, it } from "vitest";
import {
  parseTerminalShellOsc,
  clearTerminalCurrentCwd,
  getTerminalCurrentCwd,
  terminalPromptLine,
  terminalCwdTitle,
  shouldUseTerminalCwdTitle,
  terminalSpawnCwd,
  setTerminalCurrentCwd,
} from "./terminal-shell-state";

describe("terminal shell OSC state", () => {
  it("parses OSC 7 local file URLs and normalizes their paths", () => {
    expect(parseTerminalShellOsc(7, "file://localhost/tmp/a/../b")).toEqual({
      type: "cwd",
      cwd: "/tmp/b",
    });
    expect(parseTerminalShellOsc(7, "file:///tmp/a%20b")).toEqual({
      type: "cwd",
      cwd: "/tmp/a b",
    });
    expect(
      parseTerminalShellOsc(7, "file://localhost/tmp%2F..%2F..%2Fsecret"),
    ).toEqual({ type: "cwd", cwd: "/secret" });
  });

  it.each([
    "https://example.com/tmp",
    "file://attacker.example/tmp",
    "file://localhost/tmp%00evil",
    "file://user@localhost/tmp",
    "file://localhost:42/tmp",
    "file://localhost/tmp?cmd=touch",
    "file://localhost/%ZZ",
    `file://localhost/${"a".repeat(5000)}`,
  ])("rejects hostile OSC 7 payload %s", (payload) => {
    expect(parseTerminalShellOsc(7, payload)).toBeNull();
  });

  it("parses OSC 133 and VS Code OSC 633 command boundaries", () => {
    expect(parseTerminalShellOsc(133, "A")).toEqual({ type: "prompt-start" });
    expect(parseTerminalShellOsc(633, "B")).toEqual({ type: "command-start" });
    expect(parseTerminalShellOsc(633, "C")).toEqual({ type: "command-start" });
    expect(parseTerminalShellOsc(633, "P;Cwd=/tmp/work/../project")).toEqual({
      type: "cwd",
      cwd: "/tmp/project",
    });
    expect(parseTerminalShellOsc(133, "D;1")).toEqual({
      type: "command-finish",
      exitCode: 1,
    });
    expect(parseTerminalShellOsc(133, "D;0")).toEqual({
      type: "command-finish",
      exitCode: 0,
    });
    expect(parseTerminalShellOsc(133, "D;$(touch /tmp/pwned)")).toBeNull();
    expect(parseTerminalShellOsc(633, "D;not-a-number")).toBeNull();
  });

  it("uses a cwd leaf as the default title", () => {
    expect(terminalCwdTitle("/tmp/work/../project")).toBe("project");
  });

  it("preserves a user-set title when cwd changes", () => {
    expect(
      shouldUseTerminalCwdTitle({
        currentTitle: "src",
        defaultTitle: "zsh",
        previousCwdTitle: "src",
      }),
    ).toBe(true);
    expect(
      shouldUseTerminalCwdTitle({
        currentTitle: "project name",
        defaultTitle: "zsh",
        previousCwdTitle: "src",
      }),
    ).toBe(false);
  });

  it("inherits the reported cwd for a split and otherwise uses the initial cwd", () => {
    expect(
      terminalSpawnCwd({ currentCwd: "/tmp/current", initialCwd: "/root" }),
    ).toBe("/tmp/current");
    expect(
      terminalSpawnCwd({ currentCwd: undefined, initialCwd: "/root" }),
    ).toBe("/root");
    expect(terminalSpawnCwd({ currentCwd: undefined, initialCwd: "~" })).toBe(
      undefined,
    );
  });

  it("shares reported cwd with other terminal creation surfaces", () => {
    setTerminalCurrentCwd("term-focused", "/tmp/current");
    expect(getTerminalCurrentCwd("term-focused")).toBe("/tmp/current");
    clearTerminalCurrentCwd("term-focused");
    expect(getTerminalCurrentCwd("term-focused")).toBeUndefined();
  });

  it("finds the previous and next prompt boundary around the viewport", () => {
    expect(terminalPromptLine([2, 8, 13], 9, "previous")).toBe(8);
    expect(terminalPromptLine([2, 8, 13], 9, "next")).toBe(13);
    expect(terminalPromptLine([2, 8, 13], 2, "previous")).toBeNull();
  });
});
