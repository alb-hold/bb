import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  flushHolderMarkerChunks,
  stripHolderMarkerChunks,
  type HolderMarkerStripState,
} from "../../../../../server/src/services/terminals/holder-marker.js";
import {
  clearTerminalCurrentCwd,
  parseTerminalShellOsc,
  getTerminalCurrentCwd,
  terminalPromptLine,
  terminalCwdTitle,
  shouldUseTerminalCwdTitle,
  terminalSpawnCwd,
  setTerminalCurrentCwd,
  parseTerminalOsc52Copy,
  registerTerminalShellOscHandlers,
  registerTerminalOsc52Handler,
} from "./terminal-shell-state";

function holderRestartOutput(splitAt: number): Buffer {
  const marker = Buffer.from("\u001b]7717;bb-holder;term_a\u0007");
  const state: HolderMarkerStripState = {
    chunks: [],
    data: [],
    releasedPrefix: null,
  };
  const chunks = [
    ...stripHolderMarkerChunks(
      {
        seq: 0,
        dataBase64: Buffer.from("BEFORE\r\n").toString("base64"),
      },
      state,
    ),
    ...stripHolderMarkerChunks(
      {
        seq: 1,
        dataBase64: Buffer.concat([
          Buffer.from("\u001b]7791;bb-grid;80;24\u0007"),
          marker.subarray(0, splitAt),
        ]).toString("base64"),
      },
      state,
    ),
    ...flushHolderMarkerChunks(state),
    ...stripHolderMarkerChunks(
      {
        seq: 2,
        dataBase64: Buffer.concat([
          marker.subarray(splitAt),
          Buffer.from("AFTER\r\n"),
        ]).toString("base64"),
      },
      state,
    ),
  ];
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
}

function writeTerminal(terminal: Terminal, data: Buffer): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function terminalSnapshot(terminal: Terminal) {
  return {
    lines: Array.from({ length: terminal.buffer.active.length }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true),
    ),
    cursorX: terminal.buffer.active.cursorX,
    cursorY: terminal.buffer.active.cursorY,
  };
}

describe("terminal shell OSC state", () => {
  it.each([1, 2, 3])(
    "keeps late holder-marker continuations from corrupting xterm at prefix offset %i",
    async (splitAt) => {
      const control = new Terminal({ cols: 80, rows: 8 });
      const terminals = [
        {
          id: `holder-prefix-client-${splitAt}`,
          bytes: holderRestartOutput(splitAt),
        },
        {
          id: `holder-prefix-retained-${splitAt}`,
          bytes: holderRestartOutput(splitAt),
        },
      ];
      const disposables: Array<{
        terminal: Terminal;
        shellOsc: { dispose(): void };
        id: string;
      }> = [];
      try {
        await writeTerminal(control, Buffer.from("BEFORE\r\nAFTER\r\n"));
        const controlSnapshot = terminalSnapshot(control);
        for (const { id, bytes } of terminals) {
          const terminal = new Terminal({ cols: 80, rows: 8 });
          setTerminalCurrentCwd(id, "/before");
          const shellEvents: unknown[] = [];
          const shellOsc = registerTerminalShellOscHandlers(
            terminal.parser,
            (event) => {
              shellEvents.push(event);
              if (event.type === "cwd") {
                setTerminalCurrentCwd(id, event.cwd);
              }
            },
          );
          disposables.push({ terminal, shellOsc, id });
          await writeTerminal(terminal, bytes);
          const snapshot = terminalSnapshot(terminal);
          const rendered = snapshot.lines.join("\n");
          expect(rendered.match(/BEFORE/gu) ?? []).toHaveLength(1);
          expect(rendered.match(/AFTER/gu) ?? []).toHaveLength(1);
          expect(rendered.indexOf("BEFORE")).toBeLessThan(
            rendered.indexOf("AFTER"),
          );
          expect(rendered).not.toContain("7717");
          expect({
            cursorX: snapshot.cursorX,
            cursorY: snapshot.cursorY,
          }).toEqual({
            cursorX: controlSnapshot.cursorX,
            cursorY: controlSnapshot.cursorY,
          });
          expect(getTerminalCurrentCwd(id)).toBe("/before");
          expect(shellEvents).toEqual([]);
        }
      } finally {
        for (const { terminal, shellOsc, id } of disposables) {
          shellOsc.dispose();
          terminal.dispose();
          clearTerminalCurrentCwd(id);
        }
        control.dispose();
      }
    },
  );

  it("offers OSC 52 copy payloads and ignores queries and retained replays", () => {
    expect(parseTerminalOsc52Copy("c;b2s=")).toBe("ok");
    expect(parseTerminalOsc52Copy("c;?")).toBeNull();
    expect(parseTerminalOsc52Copy(";b2s=")).toBe("ok");
    expect(parseTerminalOsc52Copy("p;b2s=")).toBe("ok");
    expect(parseTerminalOsc52Copy("s0;b2s=")).toBe("ok");
    expect(parseTerminalOsc52Copy("cp;b2s=")).toBe("ok");
    expect(parseTerminalOsc52Copy("x;b2s=")).toBeNull();
    expect(parseTerminalOsc52Copy("b2s=")).toBeNull();
    expect(parseTerminalOsc52Copy("c;")).toBeNull();

    let handler: ((data: string) => boolean) | undefined;
    let isReplay = true;
    const onCopy = vi.fn();
    const dispose = registerTerminalOsc52Handler(
      {
        parser: {
          registerOscHandler(_identifier, callback) {
            handler = callback;
            return { dispose: () => {} };
          },
        },
      },
      onCopy,
      () => isReplay,
    );
    expect(handler?.("c;b2s=")).toBe(true);
    expect(onCopy).not.toHaveBeenCalled();
    isReplay = false;
    expect(handler?.("c;b2s=")).toBe(true);
    expect(onCopy).toHaveBeenCalledWith("ok");
    dispose.dispose();
  });
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
    ["/tmp/q%3Fx", "/tmp/q?x"],
    ["/tmp/h%23x", "/tmp/h#x"],
    ["/tmp/p%2520x", "/tmp/p%20x"],
    ["/tmp/s%20p", "/tmp/s p"],
    ["/tmp/caf%C3%A9", "/tmp/café"],
  ])("decodes an encoded OSC 7 path once: %s", (encodedPath, cwd) => {
    expect(parseTerminalShellOsc(7, `file://localhost${encodedPath}`)).toEqual({
      type: "cwd",
      cwd,
    });
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
