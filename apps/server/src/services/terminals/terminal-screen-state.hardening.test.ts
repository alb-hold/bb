import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { TerminalScreenState } from "./terminal-screen-state.js";

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

function newTerminal() {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: 40,
    rows: 8,
    scrollback: 100,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function write(terminal: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function screenText(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, y) =>
    (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").trimEnd(),
  );
}

function headless(state: TerminalScreenState): Terminal {
  const terminal: unknown = Reflect.get(state, "terminal");
  if (!(terminal instanceof Terminal)) throw new Error("terminal is missing");
  return terminal;
}

function decode(base64: string | undefined): string {
  return Buffer.from(base64 ?? "", "base64").toString("latin1");
}

describe("screen snapshot partial-sequence bookkeeping", () => {
  it("offers a snapshot after one chunk over 64 KiB that ends in a tiny open sequence, and continues exactly", async () => {
    const plain = `${"filler line of ordinary text\r\n".repeat(2400)}tail`;
    const head = text(`${plain}\x1b[?2`);
    expect(head.length).toBeGreaterThan(64 * 1024);
    const rest = text("026l after");
    const clean = newTerminal();
    await write(clean, head);
    await write(clean, rest);

    const state = new TerminalScreenState(40, 8);
    state.push(0, head);
    const snapshot = await state.snapshot();
    state.dispose();
    expect(snapshot).not.toBeNull();
    const client = newTerminal();
    await write(client, Buffer.from(snapshot?.dataBase64 ?? "", "base64"));
    await write(client, rest);

    expect(screenText(client)).toEqual(screenText(clean));
    expect(screenText(client).join("\n")).not.toContain("026l");
    expect(client.modes.synchronizedOutputMode).toBe(
      clean.modes.synchronizedOutputMode,
    );
    clean.dispose();
    client.dispose();
  });

  it("withholds the snapshot while an OSC over 64 KiB is still open and offers one again once it ends", async () => {
    const state = new TerminalScreenState(40, 8);
    state.push(0, text("before\r\n"));
    state.push(1, text(`\x1b]0;${"t".repeat(70 * 1024)}`));
    await expect(state.snapshot()).resolves.toBeNull();
    state.push(2, text("more title"));
    await expect(state.snapshot()).resolves.toBeNull();
    state.push(3, text("\x07after\r\n"));
    const recovered = await state.snapshot();
    expect(recovered).not.toBeNull();
    const client = newTerminal();
    await write(client, Buffer.from(recovered?.dataBase64 ?? "", "base64"));
    const clean = newTerminal();
    await write(
      clean,
      `before\r\n\x1b]0;${"t".repeat(70 * 1024)}more title\x07after\r\n`,
    );
    expect(screenText(client)).toEqual(screenText(clean));
    expect(screenText(client).slice(0, 2)).toEqual(["before", "after"]);
    state.dispose();
    client.dispose();
    clean.dispose();
  });

  it("keeps a short open sequence that spans several small chunks", async () => {
    const state = new TerminalScreenState(40, 8);
    const pieces = ["plain\r\n", "\x1b", "[", "?20", "26"];
    for (const [seq, piece] of pieces.entries()) state.push(seq, text(piece));
    const snapshot = await state.snapshot();
    expect(snapshot).not.toBeNull();
    const client = newTerminal();
    await write(client, Buffer.from(snapshot?.dataBase64 ?? "", "base64"));
    await write(client, "l\r\nnext");
    const clean = newTerminal();
    await write(clean, "plain\r\n\x1b[?2026l\r\nnext");
    expect(screenText(client)).toEqual(screenText(clean));
    expect(screenText(client).join("\n")).not.toContain("026l");
    expect(client.modes.synchronizedOutputMode).toBe(false);
    state.dispose();
    client.dispose();
  });
});

describe("hostile hyperlink data in a snapshot", () => {
  const SAFE_OSC8 =
    /^(?:id=[^\u0000-\u001f\u007f-\u009f;:]{1,256})?;[^\u0000-\u001f\u007f-\u009f]{0,2048}$/u;

  async function snapshotWithLink(data: { id?: string; uri: string }) {
    const state = new TerminalScreenState(40, 8);
    state.push(
      0,
      text("\x1b]8;;https://a.test/x\x1b\\linked text\x1b]8;;\x1b\\ plain\r\n"),
    );
    const terminal = headless(state);
    await write(terminal, "");
    const core: unknown = Reflect.get(terminal, "_core");
    const service: unknown = Reflect.get(core as object, "_oscLinkService");
    Reflect.set(service as object, "getLinkData", () => data);
    const snapshot = await state.snapshot();
    state.dispose();
    return decode(snapshot?.dataBase64);
  }

  it.each([
    ["ESC in the URI", { uri: "https://a.test/\u001bx" }],
    ["BEL in the URI", { uri: "https://a.test/\u0007x" }],
    ["ST (C1 0x9C) in the URI", { uri: "https://a.test/\u009cx" }],
    ["NEL (C1 0x85) in the URI", { uri: "https://a.test/\u0085x" }],
    ["a URI over 2 KiB", { uri: `https://a.test/${"p".repeat(3000)}` }],
    ["';' in the id", { id: "a;b", uri: "https://a.test/ok" }],
    ["':' in the id", { id: "a:b", uri: "https://a.test/ok" }],
    ["ESC in the id", { id: "a\u001bb", uri: "https://a.test/ok" }],
    [
      "an id over 256 characters",
      { id: "i".repeat(300), uri: "https://a.test/ok" },
    ],
  ])("emits no raw control bytes for %s", async (_name, data) => {
    const serialized = await snapshotWithLink(data);
    const opens = serialized.match(/\u001b\]8;/gu) ?? [];
    const closed = [...serialized.matchAll(/\u001b\]8;([^\u001b]*)\u001b\\/gu)];
    expect(opens.length).toBe(closed.length);
    for (const match of closed) {
      const payload = match[1] ?? "";
      expect(payload === ";" || SAFE_OSC8.test(payload)).toBe(true);
    }
    expect(serialized).not.toContain("\u0007");
    expect(serialized).not.toMatch(/[\u0080-\u009f]/u);
  });

  it("keeps the link, without the id, when only the id is unsafe", async () => {
    const serialized = await snapshotWithLink({
      id: "a;b",
      uri: "https://a.test/ok",
    });
    expect(serialized).toContain("\u001b]8;;https://a.test/ok\u001b\\");
    expect(serialized).not.toContain("id=a;b");
  });

  it("drops the link when the URI is unsafe or too long", async () => {
    for (const uri of [
      "https://a.test/\u001bx",
      `https://a.test/${"p".repeat(3000)}`,
    ]) {
      const serialized = await snapshotWithLink({ uri });
      expect(serialized).not.toContain("https://a.test/");
    }
  });
});

describe("snapshot cost when nothing is open", () => {
  it("does not decode, concatenate or re-encode with Buffer.from when no sequence is partial", async () => {
    const state = new TerminalScreenState(40, 8);
    state.push(0, text("ordinary output\r\n\x1b[1;32mgreen\x1b[0m done\r\n"));
    state.push(1, text("more text with ünïcode ✓\r\n"));
    const from = vi.spyOn(Buffer, "from");
    try {
      const snapshot = await state.snapshot();
      expect(snapshot).not.toBeNull();
      expect(from).not.toHaveBeenCalled();
      const client = newTerminal();
      await write(client, Buffer.from(snapshot?.dataBase64 ?? "", "base64"));
      expect(screenText(client).slice(0, 3)).toEqual([
        "ordinary output",
        "green done",
        "more text with ünïcode ✓",
      ]);
      client.dispose();
    } finally {
      from.mockRestore();
      state.dispose();
    }
  });

  it("still appends an open sequence when one is partial", async () => {
    const state = new TerminalScreenState(40, 8);
    state.push(0, text("text\r\n\x1b[?20"));
    const snapshot = await state.snapshot();
    state.dispose();
    expect(
      Buffer.from(snapshot?.dataBase64 ?? "", "base64")
        .toString("latin1")
        .endsWith("\u001b[?20"),
    ).toBe(true);
  });
});

describe("xterm internals that are not there", () => {
  async function snapshotWith(
    sabotage: (terminal: Terminal) => void,
  ): Promise<{ data: string; rows: string[] }> {
    const state = new TerminalScreenState(40, 8);
    state.push(
      0,
      text(
        "\x1b[1;4;31mstyled\x1b[0m \x1b]8;;https://a.test/x\x1b\\link\x1b]8;;\x1b\\ end\x1b[4m",
      ),
    );
    const terminal = headless(state);
    await write(terminal, "");
    sabotage(terminal);
    const snapshot = await state.snapshot();
    state.dispose();
    expect(snapshot).not.toBeNull();
    return { data: decode(snapshot?.dataBase64), rows: snapshot?.rows ?? [] };
  }

  function core(terminal: Terminal): object {
    const value: unknown = Reflect.get(terminal, "_core");
    if (typeof value !== "object" || value === null) throw new Error("no core");
    return value;
  }

  it.each([
    [
      "getAttrData is missing",
      true,
      (terminal: Terminal) => {
        const handler: unknown = Reflect.get(core(terminal), "_inputHandler");
        Reflect.set(handler as object, "getAttrData", undefined);
      },
    ],
    [
      "_inputHandler is missing",
      true,
      (terminal: Terminal) => {
        Reflect.set(core(terminal), "_inputHandler", undefined);
      },
    ],
    [
      "_oscLinkService is missing",
      false,
      (terminal: Terminal) => {
        Reflect.set(core(terminal), "_oscLinkService", undefined);
      },
    ],
  ])(
    "still serializes without throwing when %s",
    async (_name, keepsLinks, sabotage) => {
      const result = await snapshotWith(sabotage);
      expect(result.rows[0]).toContain("styled");
      expect(result.rows[0]).toContain("link");
      expect(result.data).toContain("styled");
      expect(result.data.includes("\u001b]8;")).toBe(keepsLinks);
    },
  );
});
