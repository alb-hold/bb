import {
  advanceTerminalReplayParserBytes,
  createTerminalReplayParserState,
  isTerminalReplaySafeBoundary,
} from "@bb/domain";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TerminalScreenState } from "./terminal-screen-state.js";

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

function claudeLikeStream(): Uint8Array {
  const frames: string[] = [];
  frames.push("\x1b[?1049h\x1b[2J\x1b[?25l");
  for (let frame = 0; frame < 3; frame += 1) {
    frames.push(
      [
        "\x1b[?2026h",
        "\x1b[H\x1b[2K\x1b[38;2;177;185;249m╭──────────────╮\x1b[39m\r\n",
        `\x1b[2K│ \x1b[1mTable ${frame}\x1b[22m │\r\n`,
        "\x1b[2K\x1b[4:5mdashed head\x1b[0m  \x1b[4munder\x1b[24m  plain\r\n",
        "\x1b[2K\x1b]8;;https://example.test/“x”\x1b\\link “é”\x1b]8;;\x1b\\ tail\r\n",
        "\x1b[2K\x1b[38;5;244m● bullet row\x1b[39m\r\n",
        `\x1b[8;5H\x1b[1;32mfooter ${frame}\x1b[0m`,
        "\x1b[?2026l",
      ].join(""),
    );
  }
  return text(frames.join(""));
}

function newTerminal() {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: 40,
    rows: 12,
    scrollback: 100,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function write(terminal: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function linkUri(
  terminal: Terminal,
  cell: NonNullable<
    ReturnType<Terminal["buffer"]["active"]["getLine"]>
  > extends {
    getCell(x: number): infer C;
  }
    ? NonNullable<C>
    : never,
): string {
  const core = Reflect.get(terminal, "_core");
  const urlId = Reflect.get(Reflect.get(cell, "extended") ?? {}, "urlId");
  if (typeof urlId !== "number" || urlId === 0) return "";
  const service = Reflect.get(core, "_oscLinkService");
  const data = Reflect.get(service, "getLinkData").call(service, urlId);
  return `@${data?.uri ?? "?"}`;
}

function ownUnderline(cell: object): string {
  const fg = Reflect.get(cell, "fg");
  if (typeof fg !== "number" || (fg & 0x10000000) === 0) return "";
  const extended = Reflect.get(cell, "extended");
  const ext = Reflect.get(extended ?? {}, "_ext");
  const style = typeof ext === "number" ? (ext & 0x1c000000) >>> 26 : 1;
  const colorMode = Reflect.get(cell, "getUnderlineColorMode");
  const colorValue = Reflect.get(cell, "getUnderlineColor");
  const color =
    typeof colorMode === "function" && typeof colorValue === "function"
      ? `${colorMode.call(cell)}:${colorValue.call(cell)}`
      : "";
  return `_${style || 1}/${color}`;
}

function cells(terminal: Terminal): string[] {
  const out: string[] = [];
  const buffer = terminal.buffer.active;
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.baseY + y);
    let row = "";
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line?.getCell(x);
      if (cell === undefined) continue;
      row += `${cell.getChars() || " "}${ownUnderline(cell)}${cell.isBold() ? "b" : ""}${cell.getFgColor()},${cell.getBgColor()}${linkUri(terminal, cell)}|`;
    }
    out.push(row);
  }
  return out;
}

describe("screen snapshot taken at an arbitrary byte cut", () => {
  it("continues into the same screen as an uncut feed, at every cut offset", async () => {
    const stream = claudeLikeStream();
    const clean = newTerminal();
    await write(clean, stream);
    const expected = cells(clean);
    const expectedSync = clean.modes.synchronizedOutputMode;
    const failures: Array<{ cut: number; prefixTail: string; stray: string }> =
      [];
    let snapshots = 0;
    let unsafeCuts = 0;
    for (let cut = 1; cut < stream.length; cut += 1) {
      const parser = createTerminalReplayParserState();
      advanceTerminalReplayParserBytes(parser, stream.subarray(0, cut));
      if (!isTerminalReplaySafeBoundary(parser)) unsafeCuts += 1;
      const state = new TerminalScreenState(40, 12);
      state.push(0, stream.subarray(0, cut));
      const snapshot = await state.snapshot();
      state.dispose();
      expect({ cut, snapshot: snapshot !== null }).toEqual({
        cut,
        snapshot: true,
      });
      if (snapshot === null) continue;
      snapshots += 1;
      const client = newTerminal();
      await write(client, Buffer.from(snapshot.dataBase64, "base64"));
      await write(client, stream.subarray(cut));
      const actual = cells(client);
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        client.modes.synchronizedOutputMode !== expectedSync
      ) {
        failures.push({
          cut,
          prefixTail: JSON.stringify(
            new TextDecoder().decode(
              stream.subarray(Math.max(0, cut - 6), cut),
            ),
          ),
          stray: actual.join("\n").includes("026l")
            ? "026l printed"
            : "differs",
        });
      }
      client.dispose();
    }
    clean.dispose();
    expect(unsafeCuts).toBeGreaterThan(100);
    expect(snapshots).toBe(stream.length - 1);
    expect(failures).toEqual([]);
  }, 120_000);
  it("restores an open hyperlink as a link, so the dashed underline ends where the link ends", async () => {
    const before = text(
      "\x1b[2J\x1b[Hplain \x1b]8;;https://example.test/a\x1b\\open link",
    );
    const after = text(" more link\x1b]8;;\x1b\\ next text");
    const clean = newTerminal();
    await write(clean, before);
    await write(clean, after);
    const state = new TerminalScreenState(40, 12);
    state.push(0, before);
    const snapshot = await state.snapshot();
    state.dispose();
    expect(snapshot).not.toBeNull();
    const client = newTerminal();
    await write(client, Buffer.from(snapshot?.dataBase64 ?? "", "base64"));
    await write(client, after);

    expect(cells(client)).toEqual(cells(clean));
    const row = cells(client)[0] ?? "";
    expect(row).toContain("@https://example.test/a");
    const nextTextCells = row.split("|").filter((cell) => cell.startsWith("x"));
    expect(nextTextCells.some((cell) => cell.includes("_"))).toBe(false);
    clean.dispose();
    client.dispose();
  });
  async function expectEveryCutToContinue(stream: Uint8Array) {
    const clean = newTerminal();
    await write(clean, stream);
    const expected = cells(clean);
    const failures: Array<{ cut: number }> = [];
    for (let cut = 1; cut < stream.length; cut += 1) {
      const state = new TerminalScreenState(40, 12);
      state.push(0, stream.subarray(0, cut));
      const snapshot = await state.snapshot();
      state.dispose();
      expect(snapshot).not.toBeNull();
      const client = newTerminal();
      await write(client, Buffer.from(snapshot?.dataBase64 ?? "", "base64"));
      await write(client, stream.subarray(cut));
      if (JSON.stringify(cells(client)) !== JSON.stringify(expected)) {
        failures.push({ cut });
      }
      client.dispose();
    }
    clean.dispose();
    expect(failures).toEqual([]);
    return expected;
  }

  it("keeps an explicit double or dashed underline on linked cells, at every cut", async () => {
    const stream = text(
      [
        "\x1b[2J\x1b[H",
        "\x1b]8;;https://a.test/1\x1b\\\x1b[21mdouble link\x1b[0m\x1b]8;;\x1b\\ ",
        "\x1b]8;;https://a.test/2\x1b\\\x1b[4:5;58;2;1;2;3mdashed link\x1b[0m\x1b]8;;\x1b\\ ",
        "\x1b]8;;https://a.test/3\x1b\\\x1b[4:3mcurly link\x1b[0m\x1b]8;;\x1b\\",
      ].join(""),
    );
    const expected = await expectEveryCutToContinue(stream);
    const row = expected[0] ?? "";
    expect(row).toContain("d_2/");
    expect(row).toContain("d_5/");
    expect(row).toContain("c_3/");
  }, 120_000);

  it("keeps an underlined active pen, with and without an open link, across every cut", async () => {
    const stream = text(
      [
        "\x1b[2J\x1b[H",
        "\x1b[4:3;58;2;9;8;7mcurly red pen text\x1b[0m\r\n",
        "\x1b]8;;https://a.test/4\x1b\\\x1b[21mlinked double pen\x1b[24m more linked\x1b]8;;\x1b\\ after",
      ].join(""),
    );
    const expected = await expectEveryCutToContinue(stream);
    expect(expected[0]).toContain("c_3/");
    expect(expected[1]).toContain("l_2/");
    expect(expected[1]).not.toMatch(/m_/u);
  }, 120_000);

  it("serializes plain linked text with no SGR underline without any underline code", async () => {
    const stream = text(
      "\x1b[2J\x1b[Hplain \x1b]8;;https://a.test/5\x1b\\just a link\x1b]8;;\x1b\\ then text\x1b]8;;https://a.test/6\x1b\\open",
    );
    const state = new TerminalScreenState(40, 12);
    state.push(0, stream);
    const snapshot = await state.snapshot();
    state.dispose();
    const serialized = Buffer.from(
      snapshot?.dataBase64 ?? "",
      "base64",
    ).toString("latin1");
    const sgrSequences = [...serialized.matchAll(/\u001b\[([0-9;:]*)m/gu)];
    expect(sgrSequences.length).toBeGreaterThan(0);
    for (const match of sgrSequences) {
      const codes = (match[1] ?? "").split(";");
      expect(codes.some((code) => code === "4" || code.startsWith("4:"))).toBe(
        false,
      );
    }
    expect(serialized).toContain("\u001b]8;;https://a.test/5\u001b\\");
    const client = newTerminal();
    await write(client, Buffer.from(snapshot?.dataBase64 ?? "", "base64"));
    expect((cells(client)[0] ?? "").includes("_")).toBe(false);
    client.dispose();
  });
});
