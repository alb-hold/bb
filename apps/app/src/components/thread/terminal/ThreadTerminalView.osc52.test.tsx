// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { ThreadTerminalView } from "./ThreadTerminalView";
import {
  OSC_52_AUTO_COPY_MAX_BYTES,
  OSC_52_AUTO_COPY_WINDOW_MS,
} from "./terminal-osc52-policy";

const preferences = vi.hoisted(() => ({ terminalCopyOnSelect: true }));
const ptyInput = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: { generalSettings: preferences } }),
}));

vi.mock("@xterm/addon-webgl", () => {
  throw new Error("WebGL unavailable");
});

vi.mock("@bb/client-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@bb/client-core")>();
  return {
    ...original,
    TerminalWebSocketTransport: class {
      start() {}
      sendResize() {}
      setVisible() {}
      sendInput(dataBase64: string) {
        ptyInput.sent.push(dataBase64);
      }
      dispose() {}
    },
  };
});

beforeEach(() => {
  preferences.terminalCopyOnSelect = true;
  ptyInput.sent = [];
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 9 }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SELECTED_TEXT =
  "and is never edited or deleted. _Are you OK with that?_ Café ✓ — answer there or here. ".repeat(
    26,
  );

function osc52(selection: string, terminator: string, text = SELECTED_TEXT) {
  return Buffer.from(
    `\x1b]52;${selection};${Buffer.from(text, "utf8").toString("base64")}${terminator}`,
    "latin1",
  );
}

function splitIntoPtyReads(bytes: Buffer, size = 1024): Buffer[] {
  const reads: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    reads.push(bytes.subarray(offset, offset + size));
  }
  return reads;
}

const emitters = [
  {
    name: "native Claude Code (c; selection, BEL, 1024-byte PTY reads)",
    reads: () => splitIntoPtyReads(osc52("c", "\x07")),
  },
  {
    name: "native Codex (c; selection, ST terminator, 1024-byte PTY reads)",
    reads: () => splitIntoPtyReads(osc52("c", "\x1b\\")),
  },
  {
    name: "plain shell printf (empty selection parameter)",
    reads: () => [osc52("", "\x07")],
  },
  {
    name: "plain shell printf (primary selection p;)",
    reads: () => [osc52("p", "\x07")],
  },
  {
    name: "plain shell printf (cut buffer s0;)",
    reads: () => [osc52("s0", "\x07")],
  },
];

async function mountTerminal() {
  const terminals: Terminal[] = [];
  const screenRequest = vi.spyOn(sdk.terminals, "experimental_screen");
  const open = Terminal.prototype.open;
  vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
    this: Terminal,
    parent: HTMLElement,
  ) {
    terminals.push(this);
    open.call(this, parent);
  });
  const view = render(
    <ThreadTerminalView
      autoFocus={false}
      isPanelOpen
      session={makeTerminalSession({ status: "running" })}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelector(".xterm-screen")).not.toBeNull(),
  );
  const terminal = terminals[0];
  if (terminal === undefined) throw new Error("Expected a mounted terminal");
  await waitFor(() => expect(screenRequest).toHaveBeenCalledOnce());
  const screenResult = screenRequest.mock.results[0];
  if (screenResult?.type !== "return") {
    throw new Error("Expected terminal screen request to start");
  }
  await act(async () => {
    await screenResult.value.catch(() => undefined);
  });
  const emittedToTerminal: string[] = [];
  terminal.onData((data) => emittedToTerminal.push(data));
  const handoffs: string[] = [];
  window.addEventListener("bb-device-handoff", (event) => {
    if (event instanceof CustomEvent) {
      handoffs.push(event.detail.request.text);
    }
  });
  return { terminal, view, emittedToTerminal, handoffs };
}

function screenText(terminal: Terminal): string {
  return Array.from(
    { length: terminal.buffer.active.length },
    (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
  ).join("\n");
}

function typeInTerminal(terminal: Terminal) {
  act(() => terminal.input("x", true));
}

async function writeReads(terminal: Terminal, reads: Buffer[]) {
  for (const read of reads) {
    await act(
      () =>
        new Promise<void>((resolve) => {
          terminal.write(new Uint8Array(read), resolve);
        }),
    );
  }
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

describe("terminal OSC 52 copy", () => {
  it.each(emitters)(
    "copies the decoded text and writes nothing to the PTY with copy-on-select on: $name",
    async ({ reads }) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const { terminal, emittedToTerminal, handoffs } = await mountTerminal();
      typeInTerminal(terminal);
      ptyInput.sent.length = 0;
      emittedToTerminal.length = 0;

      await writeReads(terminal, reads());

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledExactlyOnceWith(SELECTED_TEXT),
      );
      expect(handoffs).toEqual([]);
      expect(ptyInput.sent).toEqual([]);
      expect(emittedToTerminal).toEqual([]);
      expect(screenText(terminal)).not.toContain("QU5E");
    },
  );

  it.each(emitters)(
    "leaves the clipboard alone and offers the text for explicit copy with copy-on-select off: $name",
    async ({ reads }) => {
      preferences.terminalCopyOnSelect = false;
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const { terminal, emittedToTerminal, handoffs } = await mountTerminal();

      await writeReads(terminal, reads());

      await waitFor(() => expect(handoffs).toEqual([SELECTED_TEXT]));
      expect(writeText).not.toHaveBeenCalled();
      expect(ptyInput.sent).toEqual([]);
      expect(emittedToTerminal).toEqual([]);
    },
  );

  it("offers the text through the handoff sheet when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const error = vi.spyOn(appToast, "error");
    const { terminal, emittedToTerminal, handoffs } = await mountTerminal();
    typeInTerminal(terminal);
    ptyInput.sent.length = 0;
    emittedToTerminal.length = 0;

    await writeReads(terminal, splitIntoPtyReads(osc52("c", "\x07")));

    await waitFor(() => expect(handoffs).toEqual([SELECTED_TEXT]));
    expect(error).not.toHaveBeenCalled();
    expect(ptyInput.sent).toEqual([]);
    expect(emittedToTerminal).toEqual([]);
  });

  it("never copies a clipboard query or an invalid payload", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, emittedToTerminal, handoffs } = await mountTerminal();

    await writeReads(terminal, [
      Buffer.from("\x1b]52;c;?\x07", "latin1"),
      Buffer.from("\x1b]52;c;not base64!\x07", "latin1"),
      Buffer.from("\x1b]52;x;QUJD\x07", "latin1"),
    ]);

    expect(writeText).not.toHaveBeenCalled();
    expect(handoffs).toEqual([]);
    expect(ptyInput.sent).toEqual([]);
    expect(emittedToTerminal).toEqual([]);
  });
});

describe("terminal OSC 52 copy gate", () => {
  const smallCopy = () => splitIntoPtyReads(osc52("c", "\x07"));

  it("offers the handoff and leaves the clipboard alone when no user input preceded the OSC 52", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, emittedToTerminal, handoffs } = await mountTerminal();

    await writeReads(terminal, smallCopy());

    await waitFor(() => expect(handoffs).toEqual([SELECTED_TEXT]));
    expect(writeText).not.toHaveBeenCalled();
    expect(ptyInput.sent).toEqual([]);
    expect(emittedToTerminal).toEqual([]);
  });

  it("writes the clipboard when the OSC 52 arrives within the window after the user's input", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const { terminal, handoffs } = await mountTerminal();
    typeInTerminal(terminal);
    now.mockReturnValue(1_000_000 + OSC_52_AUTO_COPY_WINDOW_MS - 1);

    await writeReads(terminal, smallCopy());

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(SELECTED_TEXT),
    );
    expect(handoffs).toEqual([]);
  });

  it("offers the handoff when the OSC 52 arrives after the window", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const { terminal, handoffs } = await mountTerminal();
    typeInTerminal(terminal);
    now.mockReturnValue(1_000_000 + OSC_52_AUTO_COPY_WINDOW_MS + 1);

    await writeReads(terminal, smallCopy());

    await waitFor(() => expect(handoffs).toEqual([SELECTED_TEXT]));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("counts a pointer gesture on the terminal as the user's input", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, view, handoffs } = await mountTerminal();
    const terminalScreen = view.container.querySelector(".xterm-screen");
    if (terminalScreen === null) throw new Error("Expected terminal screen");

    fireEvent.pointerDown(terminalScreen, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(terminalScreen, { clientX: 40, clientY: 0 });
    await writeReads(terminal, smallCopy());

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(SELECTED_TEXT),
    );
    expect(handoffs).toEqual([]);
  });

  it("offers the handoff instead of writing when the decoded text is over the cap, even right after input", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, handoffs } = await mountTerminal();
    typeInTerminal(terminal);
    const overCap = "x".repeat(OSC_52_AUTO_COPY_MAX_BYTES + 1);

    await writeReads(
      terminal,
      splitIntoPtyReads(osc52("c", "\x07", overCap), 8192),
    );

    await waitFor(() => expect(handoffs).toEqual([overCap]));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("still writes a payload exactly at the cap right after input", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { terminal, handoffs } = await mountTerminal();
    typeInTerminal(terminal);
    const atCap = "x".repeat(OSC_52_AUTO_COPY_MAX_BYTES);

    await writeReads(
      terminal,
      splitIntoPtyReads(osc52("c", "\x07", atCap), 8192),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(atCap),
    );
    expect(handoffs).toEqual([]);
  });
});
