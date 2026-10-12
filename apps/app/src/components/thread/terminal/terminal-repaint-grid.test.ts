import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
} from "@bb/client-core";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { terminalDisplaySize } from "./terminal-shared-size";

const FITTED_COLS = 40;
const FITTED_ROWS = 12;
const FOOTER_STATUS = "11 warnings";
const FOOTER_LABEL = "model x";

function session(cols: number, rows: number): TerminalSession {
  return {
    id: "term_1",
    threadId: "thr_1",
    environmentId: "env_1",
    hostId: "host_1",
    title: "Terminal",
    initialCwd: "/workspace",
    cols,
    rows,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
  };
}

class InlineTuiPty {
  private drawnRows = 0;
  private nextSeq = 0;
  private width = FITTED_COLS;

  constructor(
    private readonly deliver: (message: TerminalServerMessage) => void,
  ) {}

  resize(cols: number, rows: number): void {
    this.width = cols;
    this.deliver({ type: "session-updated", session: session(cols, rows) });
    this.draw();
  }

  draw(): void {
    this.deliver({
      type: "output",
      chunk: {
        seq: this.nextSeq,
        dataBase64: Buffer.from(this.frame(), "utf8").toString("base64"),
      },
    });
    this.nextSeq += 1;
  }

  private frame(): string {
    const padding = " ".repeat(
      this.width - FOOTER_LABEL.length - FOOTER_STATUS.length,
    );
    const lines = [
      "> Ask me anything",
      "",
      `${FOOTER_LABEL}${padding}${FOOTER_STATUS}`,
    ];
    const up = this.drawnRows > 1 ? `\u001b[${this.drawnRows - 1}A` : "";
    this.drawnRows = lines.length;
    return `${up}\r\u001b[J${lines.join("\r\n")}`;
  }
}

class FakeSocket implements TerminalBrowserSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 1;
  readonly resizes: Array<{ cols: number; rows: number }> = [];

  close(): void {
    this.readyState = 3;
  }

  send(data: string): void {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "resize" &&
      "cols" in parsed &&
      typeof parsed.cols === "number" &&
      "rows" in parsed &&
      typeof parsed.rows === "number"
    ) {
      this.resizes.push({ cols: parsed.cols, rows: parsed.rows });
    }
  }
}

function newTerminal(): Terminal {
  return new Terminal({
    allowProposedApi: true,
    cols: FITTED_COLS,
    rows: FITTED_ROWS,
  });
}

function screenText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("|").replace(/\|+$/u, "");
}

function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

function decodeChunk(message: TerminalServerMessage): string | null {
  return message.type === "output"
    ? Buffer.from(message.chunk.dataBase64, "base64").toString("utf8")
    : null;
}

async function cleanReferenceScreen(): Promise<string> {
  const terminal = newTerminal();
  const reference = new InlineTuiPty((message) => {
    const data = decodeChunk(message);
    if (data !== null) {
      terminal.write(data);
    }
  });
  reference.draw();
  await writeAndWait(terminal, "");
  return screenText(terminal);
}

describe("replay repaint nudge", () => {
  it("leaves a full-width inline TUI exactly as a clean draw after the return nudge", async () => {
    const terminal = newTerminal();
    const pty = new InlineTuiPty((message) => {
      if (message.type === "session-updated") {
        const display = terminalDisplaySize(
          { cols: FITTED_COLS, rows: FITTED_ROWS },
          { cols: message.session.cols, rows: message.session.rows },
        );
        terminal.resize(display.cols, display.rows);
      }
      const data = decodeChunk(message);
      if (data !== null) {
        terminal.write(data);
      }
    });
    const socket = new FakeSocket();
    const transport = new TerminalWebSocketTransport({
      createSocket: () => socket,
      onMessage: () => undefined,
      shouldReconnect: () => false,
      url: "ws://example.test/ws/terminals/term_1",
    });
    transport.sendResize(FITTED_COLS, FITTED_ROWS);
    transport.start();
    socket.onopen?.(new Event("open"));

    pty.draw();
    transport.requestRepaint();
    let applied = 0;
    for (let step = 0; step < 10; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 70));
      for (const resize of socket.resizes.slice(applied)) {
        pty.resize(resize.cols, resize.rows);
      }
      applied = socket.resizes.length;
    }
    await writeAndWait(terminal, "");

    expect(socket.resizes.at(-1)).toEqual({
      cols: FITTED_COLS,
      rows: FITTED_ROWS,
    });
    expect(screenText(terminal)).toBe(await cleanReferenceScreen());
    transport.dispose();
  });
});
