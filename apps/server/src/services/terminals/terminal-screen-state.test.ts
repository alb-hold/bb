import { describe, expect, it, vi } from "vitest";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { TerminalScreenState } from "./terminal-screen-state.js";

function create(cols = 40, rows = 5, scrollback = 2_000) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function visibleState(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    rows: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row);
      return Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line?.getCell(col);
        return cell === undefined
          ? null
          : {
              chars: cell.getChars() || (cell.getWidth() === 1 ? " " : ""),
              width: cell.getWidth(),
              fg: cell.getFgColor(),
              bg: cell.getBgColor(),
              bold: cell.isBold(),
              underline: cell.isUnderline(),
            };
      });
    }),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
}

function bufferState(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    rows: Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true).trimEnd(),
    ),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
}

it.each(["snapshot", "promptScreen"] as const)(
  "answers a screen request at its queued checkpoint while output keeps arriving (%s)",
  async (method) => {
    const state = new TerminalScreenState(40, 5);
    const write = Terminal.prototype.write;
    let nextSeq = 1;
    const writes = vi
      .spyOn(Terminal.prototype, "write")
      .mockImplementation(function (this: Terminal, data, callback) {
        write.call(this, data, () => {
          if (nextSeq < 80) {
            state.push(nextSeq, Buffer.from(`line ${nextSeq}\r\n`));
            nextSeq += 1;
          }
          callback?.();
        });
      });
    try {
      state.push(0, Buffer.from("line 0\r\n"));
      const snapshot = await state[method]();
      if (snapshot !== null && "checkpointSeq" in snapshot)
        expect(snapshot.checkpointSeq).toBe(1);
      expect(snapshot?.rows.join("\n")).toContain("line 0");
      expect(nextSeq).toBeLessThan(80);
    } finally {
      state.dispose();
      writes.mockRestore();
    }
  },
);

it.each(["dispose", "sequence gap", "overflow"])(
  "settles queued screen requests when %s discards their output",
  async (reason) => {
    const state = new TerminalScreenState(40, 5);
    state.push(0, Buffer.from("initial"));
    const snapshot = state.snapshot();
    if (reason === "dispose") state.dispose();
    else if (reason === "sequence gap") state.push(2, Buffer.from("gap"));
    else state.push(1, Buffer.alloc(8 * 1024 * 1024 + 1, 120));
    try {
      await expect(snapshot).resolves.toBeNull();
    } finally {
      state.dispose();
    }
  },
);

it("bounds browser replay while retaining the full scrollback and wrapped cells", async () => {
  const state = new TerminalScreenState(40, 5, true);
  const full = create(40, 5, 10_000);
  const restored = create(40, 5, 10_000);
  const history = Array.from(
    { length: 32_000 },
    (_, i) =>
      `\x1b[38;5;${i % 16}mrow ${i} 界 ${"x".repeat(i % 50)}\x1b[0m\r\n`,
  ).join("");
  state.push(0, Buffer.from(history));
  await write(full, history);
  const snapshot = await state.replaySnapshot();
  expect(snapshot).not.toBeNull();
  if (snapshot === null) throw new Error("no replay snapshot");
  const data = Buffer.from(snapshot.dataBase64, "base64").toString();
  expect(Buffer.byteLength(data)).toBeLessThan(Buffer.byteLength(history) / 2);
  await write(restored, data);
  const allCells = (terminal: Terminal) => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, y) => {
      const line = buffer.getLine(y);
      return {
        wrapped: line?.isWrapped,
        cells: Array.from({ length: terminal.cols }, (_, x) => {
          const cell = line?.getCell(x);
          return [
            cell?.getChars() || (cell?.getWidth() === 1 ? " " : ""),
            cell?.getWidth(),
            cell?.getFgColor(),
            cell?.getBgColor(),
          ];
        }),
      };
    });
  };
  expect(allCells(restored)).toEqual(allCells(full));
  expect(bufferState(restored)).toEqual(bufferState(full));
  const suffix = "\x1b[31mcontinued 界\r\nnext";
  await write(full, suffix);
  await write(restored, suffix);
  expect(allCells(restored)).toEqual(allCells(full));
  state.dispose();
  full.dispose();
  restored.dispose();
}, 30_000);

it.each([
  "\x1b[?1049h",
  "\x1b7",
  "\x1b[3g",
  "\x1b(0",
  "\x1b]4;1;red\x07",
  "\x1b[?1006h",
  "\x1b[31",
  "\x1b]133;A\x07",
  "bare\nlinefeed",
])("keeps raw replay for state requiring %j", async (sequence) => {
  const state = new TerminalScreenState(40, 5, true);
  const middle = Math.ceil(sequence.length / 2);
  state.push(0, Buffer.from(`hello${sequence.slice(0, middle)}`));
  state.push(1, Buffer.from(sequence.slice(middle)));
  expect(await state.replaySnapshot()).toBeNull();
  state.dispose();
});

it("restores cwd, title, links, modes and the active pen before further output", async () => {
  const state = new TerminalScreenState(40, 5, true);
  const full = create();
  const restored = create();
  const prefix =
    "\x1b]0;old\x07\x1b]2;other\x07\x1b]0;latest\x07\x1b]7;file:///tmp/project\x07\x1b[?2004h\x1b[?1h\x1b[4:3;32m\x1b]8;;https://example.test\x1b\\linked";
  state.push(0, Buffer.from(prefix));
  await write(full, prefix);
  const snapshot = await state.replaySnapshot();
  if (snapshot === null) throw new Error("no replay snapshot");
  const cwd: string[] = [];
  const titles: string[] = [];
  restored.parser.registerOscHandler(7, (data) => {
    cwd.push(data);
    return false;
  });
  restored.onTitleChange((title) => titles.push(title));
  await write(restored, Buffer.from(snapshot.dataBase64, "base64").toString());
  const suffix = " more\x1b]8;;\x1b\\ plain\r\nnext";
  await write(full, suffix);
  await write(restored, suffix);
  expect(visibleState(restored)).toEqual(visibleState(full));
  expect(restored.modes).toEqual(full.modes);
  expect(cwd).toEqual(["file:///tmp/project"]);
  expect(titles.at(-1)).toBe("latest");
  state.dispose();
  full.dispose();
  restored.dispose();
});

it("continues inside scrolling margins with origin mode and the current cursor style", async () => {
  const state = new TerminalScreenState(40, 5, true);
  const full = create();
  const restored = create();
  const prefix =
    "one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[2;4r\x1b[?6h\x1b[2;3H\x1bM\x1b[3 q\x1b[32m";
  state.push(0, Buffer.from(prefix));
  await write(full, prefix);
  const snapshot = await state.replaySnapshot();
  if (snapshot === null) throw new Error("no replay snapshot");
  await write(restored, Buffer.from(snapshot.dataBase64, "base64").toString());
  expect(visibleState(restored)).toEqual(visibleState(full));
  const suffix = "\r\nnew\r\nmore\r\nbottom\x1bM";
  await write(full, suffix);
  await write(restored, suffix);
  expect(visibleState(restored)).toEqual(visibleState(full));
  expect(restored.options.cursorStyle).toBe(full.options.cursorStyle);
  expect(restored.modes).toEqual(full.modes);
  state.dispose();
  full.dispose();
  restored.dispose();
});

it("keeps a wrapped first row after the preceding row has left scrollback", async () => {
  const state = new TerminalScreenState(40, 5, true);
  const full = create(40, 5, 10_000);
  const restored = create(40, 5, 10_000);
  const data = `${"x".repeat(40 * 20_000)}tail`;
  state.push(0, Buffer.from(data));
  await write(full, data);
  expect(full.buffer.active.getLine(0)?.isWrapped).toBe(true);
  const snapshot = await state.replaySnapshot();
  if (snapshot === null) throw new Error("no replay snapshot");
  await write(restored, Buffer.from(snapshot.dataBase64, "base64").toString());
  expect(restored.buffer.active.getLine(0)?.isWrapped).toBe(true);
  expect(bufferState(restored)).toEqual(bufferState(full));
  state.dispose();
  full.dispose();
  restored.dispose();
});

describe("TerminalScreenState", () => {
  it("reconstructs the full replay's visible cells and cursor from snapshot plus ordered suffix", async () => {
    const before =
      "\u001b[2J\u001b[H\u001b[38;2;20;120;220mready 界🙂\u001b[0m\u001b[5;20H99%";
    const after = "\u001b[5;20H100%\u001b[4;4Hnext";
    const state = new TerminalScreenState(40, 5);
    state.push(0, Buffer.from(before));
    const snapshot = await state.snapshot();
    expect(snapshot).not.toBeNull();
    if (snapshot === null)
      throw new Error("screen state did not produce a snapshot");

    const fromSnapshot = create();
    await write(
      fromSnapshot,
      Buffer.from(snapshot.dataBase64, "base64").toString(),
    );
    state.push(snapshot.checkpointSeq, Buffer.from(after));
    await write(fromSnapshot, after);
    const fullReplay = create();
    await write(fullReplay, before + after);
    expect(visibleState(fromSnapshot)).toEqual(visibleState(fullReplay));

    const dropped = create();
    await write(dropped, Buffer.from(snapshot.dataBase64, "base64").toString());
    await write(dropped, "\u001b[5;20H100%");
    expect(visibleState(dropped)).not.toEqual(visibleState(fullReplay));

    const swapped = create();
    await write(swapped, Buffer.from(snapshot.dataBase64, "base64").toString());
    await write(swapped, "\u001b[4;4Hnext\u001b[5;20H100%");
    expect(visibleState(swapped)).not.toEqual(visibleState(fullReplay));

    state.dispose();
    fromSnapshot.dispose();
    fullReplay.dispose();
    dropped.dispose();
    swapped.dispose();
  });

  it("invalidates on a missing sequence instead of serving a misleading frame", async () => {
    const state = new TerminalScreenState(40, 5);
    state.push(1, Buffer.from("missed sequence zero"));
    await expect(state.snapshot()).resolves.toBeNull();
    state.dispose();
  });

  it("invalidates and drops queued data after the pending byte limit is crossed", async () => {
    const state = new TerminalScreenState(40, 5);
    state.push(0, Buffer.from("initial"));
    state.push(1, Buffer.alloc(8 * 1024 * 1024, 120));
    await expect(state.snapshot()).resolves.toBeNull();
    expect(Reflect.get(state, "pendingWork")).toHaveLength(0);
    expect(Reflect.get(state, "pendingWorkBytes")).toBe(0);
    state.dispose();
  });

  it("preserves the older-history seam when a lazy history page meets the snapshot and suffix", async () => {
    const olderRows = Array.from(
      { length: 2_005 },
      (_, index) => `history-${index + 1}`,
    );
    const olderLines = `${olderRows.join("\r\n")}\r\n`;
    const before = "\u001b[2J\u001b[Hscreen 界🙂\u001b[5;20H99%";
    const after = "\u001b[5;20H100%\u001b[4;4Hnext";
    const state = new TerminalScreenState(40, 5);
    state.push(0, Buffer.from(before));
    const snapshot = await state.snapshot();
    expect(snapshot).not.toBeNull();
    if (snapshot === null)
      throw new Error("screen state did not produce a snapshot");

    const resumed = create(40, 5, 10_000);
    await write(resumed, olderLines);
    await write(resumed, Buffer.from(snapshot.dataBase64, "base64").toString());
    state.push(snapshot.checkpointSeq, Buffer.from(after));
    await write(resumed, after);

    const fullReplay = create(40, 5, 10_000);
    await write(fullReplay, olderLines + before + after);
    expect(bufferState(resumed)).toEqual(bufferState(fullReplay));
    expect(visibleState(resumed)).toEqual(visibleState(fullReplay));

    const droppedAtSeam = create(40, 5, 10_000);
    await write(droppedAtSeam, `${olderRows.slice(0, -1).join("\r\n")}\r\n`);
    await write(
      droppedAtSeam,
      Buffer.from(snapshot.dataBase64, "base64").toString(),
    );
    await write(droppedAtSeam, after);
    expect(bufferState(droppedAtSeam)).not.toEqual(bufferState(fullReplay));

    const duplicatedAtSeam = create(40, 5, 10_000);
    await write(duplicatedAtSeam, `${olderLines}history-2005\r\n`);
    await write(
      duplicatedAtSeam,
      Buffer.from(snapshot.dataBase64, "base64").toString(),
    );
    await write(duplicatedAtSeam, after);
    expect(bufferState(duplicatedAtSeam)).not.toEqual(bufferState(fullReplay));

    state.dispose();
    resumed.dispose();
    fullReplay.dispose();
    droppedAtSeam.dispose();
    duplicatedAtSeam.dispose();
  });
});

it.each(["", "\x1b[48;5;8m\x1b[K\x1b[0m"])(
  "preserves trimmed rows and wrapped reflow after narrowing a compacted replay %j",
  async (background) => {
    const state = new TerminalScreenState(40, 5, true);
    const full = create();
    const restored = create();
    const input = `short${background}\r\n${"wrapped".repeat(9)}\r\nlast`;
    state.push(0, Buffer.from(input));
    await write(full, input);
    const snapshot = await state.replaySnapshot();
    expect(snapshot).not.toBeNull();
    await write(
      restored,
      Buffer.from(snapshot!.dataBase64, "base64").toString(),
    );
    full.resize(20, 5);
    restored.resize(20, 5);
    expect(bufferState(restored)).toEqual(bufferState(full));
    state.dispose();
    full.dispose();
    restored.dispose();
  },
);

it("retains OSC 9 progress without re-firing later notifications", async () => {
  const state = new TerminalScreenState(40, 5, true);
  state.push(0, Buffer.from("\x1b]9;4;1;50\x07\x1b]9;notification\x07done"));
  const snapshot = await state.replaySnapshot();
  const restored = create();
  const events: string[] = [];
  restored.parser.registerOscHandler(9, (payload) => {
    events.push(payload);
    return true;
  });
  await write(restored, Buffer.from(snapshot!.dataBase64, "base64").toString());
  expect(events).toEqual(["4;1;50"]);
  state.dispose();
  restored.dispose();
});

it("stops history serialization once the replay byte budget is reached", async () => {
  const state = new TerminalScreenState(120, 24, true);
  try {
    state.push(
      0,
      Buffer.from(
        Array.from(
          { length: 200 },
          () => "\x1b[31ma\x1b[32mb".repeat(50) + "\r\n",
        ).join(""),
      ),
    );
    expect(await state.replaySnapshot(1024)).toBeNull();
  } finally {
    state.dispose();
  }
});

it("completes dense SGR serialization with bounded base64 encoding batches", async () => {
  const state = new TerminalScreenState(120, 24, true);
  const data = Buffer.from(
    ("\x1b[31ma\x1b[32mb".repeat(60) + "\r\n").repeat(200),
  );
  state.push(0, data);
  const encode = vi.spyOn(Buffer.prototype, "toString");
  try {
    const snapshot = await state.replaySnapshot(data.length * 4);
    expect(snapshot).not.toBeNull();
    const sizes = encode.mock.calls.flatMap((call, index) => {
      const context = encode.mock.contexts[index];
      return call[0] === "base64" && Buffer.isBuffer(context)
        ? [context.length]
        : [];
    });
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
  } finally {
    encode.mockRestore();
    state.dispose();
  }
});
