import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import {
  buildTerminalThemeFromCssColors,
  applyTerminalFontFamily,
  captureTerminalContextMenuState,
  encodeTerminalInputChunks,
  handleTerminalServerMessage,
  handleTerminalSurfaceVisibility,
  forceTerminalFontMeasurement,
  focusTerminalFromTouchRelease,
  forwardTerminalData,
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
  observeTerminalFontLoading,
  shouldFocusTerminalAfterAsyncMount,
  startTerminalTouchFocusGesture,
  TERMINAL_ALLOW_PROPOSED_API,
  TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  writeTerminalOutput,
  updateTerminalTouchFocusGesture,
} from "./ThreadTerminalView";
import {
  createTerminalOsc8LinkHandler,
  requestTerminalLinkOpen,
} from "./terminal-links";

describe("terminal surface visibility", () => {
  it("schedules a fit on visibility return after updating render demand", () => {
    const calls: string[] = [];
    const setSurfaceVisibility = vi.fn((visible: boolean) =>
      calls.push(`surface:${visible}`),
    );
    const setRenderDemand = vi.fn((visible: boolean) =>
      calls.push(`render:${visible}`),
    );
    const reportVisibility = vi.fn(() => calls.push("report"));
    const scheduleFit = vi.fn(() => calls.push("fit"));

    handleTerminalSurfaceVisibility(
      true,
      setSurfaceVisibility,
      setRenderDemand,
      reportVisibility,
      scheduleFit,
    );

    expect(calls).toEqual(["surface:true", "render:true", "report", "fit"]);
    expect(scheduleFit).toHaveBeenCalledOnce();
  });
});

describe("terminal hyperlinks", () => {
  it("preserves OSC-8 provenance through hover and primary activation", () => {
    const onActivate = vi.fn();
    const onHover = vi.fn();
    const handler = createTerminalOsc8LinkHandler({
      onActivate,
      onHover,
    });
    const event = { button: 0 } as MouseEvent;
    const range = {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    };

    handler.hover?.(event, "https://example.com/authorize", range);
    handler.activate(event, "https://example.com/authorize", range);
    handler.leave?.(event, "https://example.com/authorize", range);

    expect(onActivate).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(1, {
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });

  it("does not activate OSC-8 links from a secondary click", () => {
    const onActivate = vi.fn();
    const handler = createTerminalOsc8LinkHandler({
      onActivate,
      onHover: vi.fn(),
    });
    const range = {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    };

    handler.activate(
      { button: 2 } as MouseEvent,
      "https://example.com/right-click",
      range,
    );

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("confirms concealed targets and directly opens detected URLs", () => {
    const openLink = vi.fn();
    const requestConfirmation = vi.fn();

    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: { source: "osc8", uri: "https://example.com/concealed" },
    });
    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: {
        source: "detected-url",
        uri: "https://example.com/visible",
      },
    });

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(requestConfirmation).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/concealed",
    });
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith("https://example.com/visible");
  });

  it("preserves link actions while copying the exact xterm selection", () => {
    const getSelection = vi.fn(() => "  wrapped terminal selection\n");
    const link = {
      source: "detected-url" as const,
      uri: "https://example.com/visible",
    };

    expect(
      captureTerminalContextMenuState({
        link,
        terminal: { getSelection },
      }),
    ).toEqual({
      link,
      selectionText: "  wrapped terminal selection\n",
    });
    expect(getSelection).toHaveBeenCalledOnce();
  });
});

function startTouchFocusGesture() {
  const gesture = startTerminalTouchFocusGesture(
    [{ identifier: 1, x: 40, y: 80 }],
    100,
  );
  if (gesture === null) {
    throw new Error("Expected one touch to start a focus gesture");
  }
  return gesture;
}

describe("terminal async mount focus", () => {
  it("preserves focus that moved to the composer while xterm loaded", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("does not let an explicit request override a newer focus target", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses an opened terminal when focus stayed on its trigger", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("preserves a composer that was focused before xterm started mounting", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses the terminal when its initiating trigger unmounted", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("does not focus a terminal after its panel closes", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("terminal touch focus", () => {
  it("focuses the terminal after a tap", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 43, y: 84 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not focus after a drag returns near its start", () => {
    const focus = vi.fn();
    const gesture = updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
      { identifier: 1, x: 40, y: 120 },
    ]);

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 81 }],
        focus,
        gesture,
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not focus after a long press", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 80 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 800,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("invalidates the gesture when another touch starts", () => {
    expect(
      updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
        { identifier: 1, x: 40, y: 80 },
        { identifier: 2, x: 80, y: 80 },
      ]),
    ).toBeNull();
  });
});

describe("terminal output encoding", () => {
  it("splits large paste input at the wire limit without losing UTF-8 bytes", () => {
    const input = `${"a".repeat(TERMINAL_DATA_MAX_BYTES - 1)}🙂tail`;
    const chunks = encodeTerminalInputChunks(input);
    const decoded = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    );

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.from(chunk, "base64").byteLength <= TERMINAL_DATA_MAX_BYTES,
      ),
    ).toBe(true);
    expect(decoded.toString("utf8")).toBe(input);
  });

  it("keeps UTF-8 bytes intact when a glyph spans output chunks", () => {
    const encoded = new TextEncoder().encode("🙂");
    const first = decodeBase64Bytes(
      Buffer.from(encoded.subarray(0, 2)).toString("base64"),
    );
    const second = decodeBase64Bytes(
      Buffer.from(encoded.subarray(2)).toString("base64"),
    );
    const decoder = new TextDecoder();

    expect(
      decoder.decode(first, { stream: true }) + decoder.decode(second),
    ).toBe("🙂");
  });

  it("sends nothing for a touch fling's positionless wheel reports", () => {
    const onInput = vi.fn<(dataBase64: string) => void>();
    const onUserInput = vi.fn();
    const forward = (data: string) =>
      forwardTerminalData({
        data,
        onInput,
        onUserInput,
        replayWriteState: { suppressedWriteCount: 0 },
        sessionStatus: "running",
      });

    forward("\x1b[<65;NaN;NaNM\x1b[<65;NaN;NaNM");
    expect(onInput).not.toHaveBeenCalled();
    expect(onUserInput).not.toHaveBeenCalled();

    forward("\x1b[<65;NaN;NaNM\x1b[<65;10;4M");
    expect(onInput).toHaveBeenCalledOnce();
    expect(
      Buffer.from(onInput.mock.calls[0]?.[0] ?? "", "base64").toString("utf8"),
    ).toBe("\x1b[<65;10;4M");
  });

  it("does not send terminal protocol replies generated by replayed output", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const onInput = vi.fn<(dataBase64: string) => void>();
    const replayWriteState = { suppressedWriteCount: 0 };
    terminal.onData((data) => {
      forwardTerminalData({
        data,
        onInput,
        replayWriteState,
        sessionStatus: "running",
      });
    });

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: true,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onInput).not.toHaveBeenCalled();

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: false,
      onParsed: () => undefined,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onInput).toHaveBeenCalledOnce();
    const encodedReply = onInput.mock.calls[0]?.[0];
    if (encodedReply === undefined) {
      throw new Error("Expected xterm to emit a cursor-position reply");
    }
    expect(Buffer.from(encodedReply, "base64").toString("utf8")).toBe(
      "\u001b[1;1R",
    );
    expect(replayWriteState.suppressedWriteCount).toBe(0);
    terminal.dispose();
  });

  it("requests a repaint only after the final replay chunk has parsed", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const replayWriteState = { suppressedWriteCount: 0 };
    const replayState = { nextSeq: null as number | null };
    const acknowledgeOutput = vi.fn();
    const session = {
      id: "term_1",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;
    const attachedMessage = {
      type: "attached",
      session,
      replayStartSeq: 7,
      nextSeq: 9,
    } satisfies TerminalServerMessage;
    const replayMessage = {
      type: "output",
      chunk: {
        seq: 8,
        dataBase64: Buffer.from("prompt", "utf8").toString("base64"),
      },
    } satisfies TerminalServerMessage;
    const onReplayComplete = vi.fn(() => {
      expect(
        terminal.buffer.active.getLine(0)?.translateToString().trimEnd(),
      ).toBe("prompt");
    });
    const handleMessage = (message: TerminalServerMessage) =>
      handleTerminalServerMessage({
        acknowledgeOutput,
        message,
        onReplayComplete,
        replayNextSeq: replayState.nextSeq,
        replayWriteState,
        setReplayNextSeq: (nextSeq) => {
          replayState.nextSeq = nextSeq;
        },
        terminal,
      });

    handleMessage(attachedMessage);
    expect(onReplayComplete).not.toHaveBeenCalled();
    handleMessage(replayMessage);
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onReplayComplete).toHaveBeenCalledOnce();
    expect(acknowledgeOutput).toHaveBeenCalledWith(9);
    expect(replayState.nextSeq).toBeNull();
    terminal.dispose();
  });

  it("restores a synthetic TUI after a mid-stream alternate-screen replay", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const replayWriteState = { suppressedWriteCount: 0 };
    const replayState = { nextSeq: null as number | null };
    const session = {
      id: "term_1",
      threadId: "thr_1",
      environmentId: "env_1",
      hostId: "host_1",
      title: "Terminal",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    } satisfies TerminalSession;
    let resolveRepaint = (): void => {};
    const repaint = new Promise<void>((resolve) => {
      resolveRepaint = resolve;
    });
    const fullScreen =
      "\u001b[2J\u001b[HClaude Code v2.1.296\u001b[12;1H[ Prompt ]\u001b[13;1H❯ run terminal reattach tests\u001b[23;1HOpus 5.5 · branch · ctx 4M\u001b[24;1HStatus · connected · footer\u001b[13;3H";
    const requestRepaint = vi.fn(() => {
      terminal.write(fullScreen, resolveRepaint);
    });
    const acknowledgeOutput = vi.fn();
    const handleMessage = (message: TerminalServerMessage) =>
      handleTerminalServerMessage({
        acknowledgeOutput,
        message,
        onReplayComplete: requestRepaint,
        replayNextSeq: replayState.nextSeq,
        replayWriteState,
        setReplayNextSeq: (nextSeq) => {
          replayState.nextSeq = nextSeq;
        },
        terminal,
      });

    handleMessage({
      type: "attached",
      session,
      replayStartSeq: 41,
      nextSeq: 42,
    });
    handleMessage({
      type: "output",
      chunk: {
        seq: 41,
        dataBase64: Buffer.from(
          "\u001b[?1049hmid-stream-tail",
          "utf8",
        ).toString("base64"),
      },
    });
    await repaint;

    const lines = Array.from({ length: 24 }, (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString().trimEnd(),
    );
    expect(requestRepaint).toHaveBeenCalledOnce();
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(lines[0]).toContain("Claude Code v2.1.296");
    expect(lines[11]).toContain("[ Prompt ]");
    expect(lines[12]).toContain("❯ run terminal reattach tests");
    expect(lines[22]).toContain("Opus 5.5 · branch · ctx 4M");
    expect(lines[23]).toContain("Status · connected · footer");
    expect(terminal.buffer.active.cursorX).toBe(2);
    expect(terminal.buffer.active.cursorY).toBe(12);
    expect(acknowledgeOutput).toHaveBeenCalledWith(42);
    terminal.dispose();
  });

  it("allows the proposed xterm API that the Unicode 11 addon requires", () => {
    const terminal = new Terminal({
      allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    expect(terminal.unicode.activeVersion).toBe("11");
    terminal.dispose();
  });
});

describe("buildTerminalThemeFromCssColors", () => {
  it("paints the terminal canvas and cursor cutout with the sidebar surface", () => {
    const get = vi.fn((name: string) => name);

    const theme = buildTerminalThemeFromCssColors(get);

    expect(theme.background).toBe("--sidebar");
    expect(theme.cursorAccent).toBe("--sidebar");
  });
});

describe("terminal font family", () => {
  it("uses the theme terminal font family when it is set", () => {
    expect(
      resolveTerminalFontFamily((name) =>
        name === "--font-terminal" ? '"Berkeley Mono", monospace' : undefined,
      ),
    ).toBe('"Berkeley Mono", monospace');
  });

  it("keeps the default stack when the theme does not set a font family", () => {
    expect(resolveTerminalFontFamily(() => undefined)).toBe(
      TERMINAL_FONT_FAMILY,
    );
  });

  it("keeps the default stack when the theme font family is blank", () => {
    expect(resolveTerminalFontFamily(() => "  ")).toBe(TERMINAL_FONT_FAMILY);
  });

  it("updates the xterm font family and schedules a refit only when it changes", () => {
    const terminal = { options: { fontFamily: "Old Font" } } as Parameters<
      typeof applyTerminalFontFamily
    >[0];
    const scheduleFit = vi.fn();

    expect(
      applyTerminalFontFamily(terminal, '"New Font", monospace', scheduleFit),
    ).toBe(true);
    expect(terminal.options.fontFamily).toBe('"New Font", monospace');
    expect(scheduleFit).toHaveBeenCalledOnce();

    scheduleFit.mockClear();
    expect(
      applyTerminalFontFamily(terminal, '"New Font", monospace', scheduleFit),
    ).toBe(false);
    expect(scheduleFit).not.toHaveBeenCalled();
  });

  it("remeasures and clears cached glyphs before refreshing after a font loads", () => {
    const fontFamily = '"New Font", monospace';
    let currentFontFamily = fontFamily;
    const fontFamilyChanges: string[] = [];
    const refresh = vi.fn();
    const clearTextureAtlas = vi.fn();
    const terminal = {
      options: {
        get fontFamily() {
          return currentFontFamily;
        },
        set fontFamily(value: string) {
          fontFamilyChanges.push(value);
          currentFontFamily = value;
        },
      },
      refresh,
      clearTextureAtlas,
      rows: 24,
    } as Parameters<typeof forceTerminalFontMeasurement>[0];

    forceTerminalFontMeasurement(terminal);

    expect(fontFamilyChanges).toEqual([`${fontFamily} `, fontFamily]);
    expect(clearTextureAtlas).toHaveBeenCalledOnce();
    expect(clearTextureAtlas).toHaveBeenCalledBefore(refresh);
    expect(refresh).toHaveBeenCalledWith(0, 23);
    expect(terminal.options.fontFamily).toBe(fontFamily);
  });
});

function createTerminalFontSet() {
  const events = new EventTarget();
  let finishLoading = () => {};
  const ready = new Promise<FontFaceSet>((resolve) => {
    finishLoading = () => resolve(fontSet as FontFaceSet);
  });
  const fontSet = Object.assign(events, { ready });
  return { fontSet, finishLoading };
}

describe("terminal font loading", () => {
  it("refreshes fonts imported after the initial ready promise resolves", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    finishLoading();
    await fontSet.ready;
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);
    await fontSet.ready;
    expect(refresh).toHaveBeenCalledOnce();

    fontSet.dispatchEvent(new Event("loadingdone"));
    expect(refresh).toHaveBeenCalledTimes(2);

    fontSet.dispatchEvent(new Event("loadingdone"));
    expect(refresh).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("ignores a pending ready callback after the terminal is disposed", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);

    dispose();
    finishLoading();
    await fontSet.ready;
    fontSet.dispatchEvent(new Event("loadingdone"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes the font listener when the terminal is disposed", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    const removeEventListener = vi.spyOn(fontSet, "removeEventListener");
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);
    finishLoading();
    await fontSet.ready;
    refresh.mockClear();

    dispose();
    fontSet.dispatchEvent(new Event("loadingdone"));

    expect(refresh).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "loadingdone",
      expect.any(Function),
    );
    removeEventListener.mockRestore();
  });
});

describe("loadTerminalWebglRenderer", () => {
  it("continues without WebGL when the optional module fails to load", async () => {
    const importAddon = vi.fn().mockRejectedValue(new Error("chunk failed"));

    await expect(
      loadOptionalTerminalWebglAddon(importAddon),
    ).resolves.toBeNull();
  });

  it("loads the accelerated renderer and falls back when its context is lost", () => {
    let onContextLoss = () => {};
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn((listener: () => void) => {
        onContextLoss = listener;
        return { dispose: vi.fn() };
      }),
    };
    const terminal = { loadAddon: vi.fn() };

    expect(loadTerminalWebglRenderer(terminal, () => addon).renderer).toBe(
      "webgl",
    );
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);

    onContextLoss();

    expect(addon.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the DOM renderer when WebGL addon registration fails", () => {
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const terminal = {
      loadAddon: vi.fn(() => {
        throw new Error("WebGL unavailable");
      }),
    };

    expect(loadTerminalWebglRenderer(terminal, () => addon).renderer).toBe(
      "dom",
    );
    expect(addon.dispose).toHaveBeenCalledOnce();
  });
});
