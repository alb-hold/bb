import { describe, expect, it } from "vitest";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { TerminalCursorPositionQueries } from "@bb/domain";

const RANDOM_SEED = 0x538c0de1;
const RANDOM_SEQUENCE_COUNT = 200;
const EXTENDED_RANDOM_SEED = 0x538c0de2;
const EXTENDED_RANDOM_SEQUENCE_COUNT = 300;

type ParityStep =
  | { kind: "write"; data: string }
  | { kind: "resize"; cols: number; rows: number };

function createHeadlessTerminal(cols: number, rows: number): Terminal {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 200,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function writeHeadless(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function runBoth(
  cols: number,
  rows: number,
  steps: readonly ParityStep[],
): Promise<{ xtermReplies: string[]; trackerReplies: string[] }> {
  const terminal = createHeadlessTerminal(cols, rows);
  const tracker = new TerminalCursorPositionQueries(cols, rows);
  const xtermReplies: string[] = [];
  const trackerReplies: string[] = [];
  terminal.onData((data) => {
    xtermReplies.push(data);
  });
  try {
    let hasQueuedWrites = false;
    for (const step of steps) {
      if (step.kind === "resize") {
        if (hasQueuedWrites) {
          await writeHeadless(terminal, "");
          hasQueuedWrites = false;
        }
        terminal.resize(step.cols, step.rows);
        tracker.resize(step.cols, step.rows);
      } else {
        terminal.write(step.data);
        hasQueuedWrites = true;
        tracker.push(step.data, (reply) => {
          trackerReplies.push(reply);
        });
      }
    }
    const tail = tracker.flush();
    if (tail.length > 0) {
      terminal.write(tail);
      hasQueuedWrites = true;
    }
    if (hasQueuedWrites) {
      await writeHeadless(terminal, "");
    }
  } finally {
    terminal.dispose();
  }
  return { xtermReplies, trackerReplies };
}

async function runPipelineAndReference(
  cols: number,
  rows: number,
  steps: readonly ParityStep[],
): Promise<{
  referenceReplies: string[];
  combinedReplies: string[];
  daemonReplies: string[];
}> {
  const reference = createHeadlessTerminal(cols, rows);
  const downstream = createHeadlessTerminal(cols, rows);
  const tracker = new TerminalCursorPositionQueries(cols, rows);
  const referenceReplies: string[] = [];
  const combinedReplies: string[] = [];
  const daemonReplies: string[] = [];
  reference.onData((data) => {
    referenceReplies.push(data);
  });
  downstream.onData((data) => {
    combinedReplies.push(data);
  });
  try {
    for (const step of steps) {
      if (step.kind === "resize") {
        const pending = tracker.flush();
        if (pending.length > 0) {
          await writeHeadless(downstream, pending);
        }
        reference.resize(step.cols, step.rows);
        downstream.resize(step.cols, step.rows);
        tracker.resize(step.cols, step.rows);
      } else {
        await writeHeadless(reference, step.data);
        const forwarded = tracker.push(step.data, (reply) => {
          daemonReplies.push(reply);
          combinedReplies.push(reply);
        });
        if (forwarded.length > 0) {
          await writeHeadless(downstream, forwarded);
        }
      }
    }
    const tail = tracker.flush();
    if (tail.length > 0) {
      await writeHeadless(downstream, tail);
    }
  } finally {
    reference.dispose();
    downstream.dispose();
  }
  return { referenceReplies, combinedReplies, daemonReplies };
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function generateRandomCase(
  rng: () => number,
): { cols: number; rows: number; steps: ParityStep[] } {
  let cols = randInt(rng, 4, 24);
  let rows = randInt(rng, 3, 10);
  const initialCols = cols;
  const initialRows = rows;
  const tokens = [
    "a",
    "xy",
    "1234",
    "漢",
    "字",
    "あ",
    "\u{1F9E0}",
    "\u{1FA70}",
    "\u{1FA95}",
    "\u{1FAE8}",
    "\u231A",
    "\u26A1",
    "\u2B50",
    "e\u0301",
    "o\u0308",
    "\u{1F468}\u200D\u{1F469}",
    "\u2764\uFE0F",
    "a\u{E0100}b",
    "§",
    "°",
    "α",
    "─",
    "★",
    "\r",
    "\n",
    "\r\n",
    "\b",
    "\t",
  ];
  const steps: ParityStep[] = [];
  const stepCount = randInt(rng, 8, 22);
  let inAlt = false;
  let originMode = false;
  let mainWritten = false;
  for (let i = 0; i < stepCount; i += 1) {
    const roll = rng();
    if (roll < 0.35) {
      const pieceCount = randInt(rng, 1, 4);
      let chunk = "";
      for (let j = 0; j < pieceCount; j += 1) {
        chunk += pick(rng, tokens);
      }
      if (!inAlt) mainWritten = true;
      steps.push({ kind: "write", data: chunk });
    } else if (roll < 0.55) {
      const r = randInt(rng, 1, rows + 2);
      const c = randInt(rng, 1, cols + 2);
      const n = randInt(rng, 1, 4);
      const moves = originMode
        ? [`\x1b[${r};${c}H`, `\x1b[${r}d`]
        : [
            `\x1b[${r};${c}H`,
            `\x1b[${n}A`,
            `\x1b[${n}B`,
            `\x1b[${n}C`,
            `\x1b[${n}D`,
            `\x1b[${n}E`,
            `\x1b[${n}F`,
            `\x1b[${c}G`,
            `\x1b[${r}d`,
          ];
      steps.push({ kind: "write", data: pick(rng, moves) });
    } else if (roll < 0.65) {
      const top = randInt(rng, 1, Math.max(1, rows - 1));
      const bottom = randInt(rng, top + 1, rows);
      steps.push({
        kind: "write",
        data: rng() < 0.7 ? `\x1b[${top};${bottom}r` : "\x1b[r",
      });
    } else if (roll < 0.72) {
      if (!inAlt) {
        inAlt = true;
        steps.push({ kind: "write", data: "\x1b[?1049h" });
      } else {
        inAlt = false;
        steps.push({ kind: "write", data: "\x1b[?1049l" });
      }
    } else if (roll < 0.8) {
      steps.push({
        kind: "write",
        data: pick(rng, ["\x1b7", "\x1b8", "\x1b[s", "\x1b[u"]),
      });
    } else if (roll < 0.87) {
      originMode = !originMode;
      steps.push({
        kind: "write",
        data: originMode ? "\x1b[?6h" : "\x1b[?6l",
      });
    } else if (roll < 0.93 && !mainWritten) {
      cols = randInt(rng, 4, 24);
      rows = randInt(rng, 3, 10);
      steps.push({ kind: "resize", cols, rows });
    } else {
      steps.push({
        kind: "write",
        data: rng() < 0.5 ? "\x1b[6n" : "\x1b[?6n",
      });
    }
  }
  steps.push({ kind: "write", data: "\x1b[6n\x1b[?6n" });
  return { cols: initialCols, rows: initialRows, steps };
}

function splitChunkRandomly(rng: () => number, text: string): string[] {
  if (text.length <= 1 || rng() < 0.55) {
    return [text];
  }
  const cuts = randInt(rng, 1, Math.min(3, text.length - 1));
  const indices = new Set<number>();
  while (indices.size < cuts) {
    indices.add(randInt(rng, 1, text.length - 1));
  }
  const sorted = [...indices].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = 0;
  for (const idx of sorted) {
    out.push(text.slice(prev, idx));
    prev = idx;
  }
  out.push(text.slice(prev));
  return out;
}

function generateExtendedRandomCase(
  rng: () => number,
): { cols: number; rows: number; steps: ParityStep[] } {
  let cols = randInt(rng, 4, 24);
  let rows = randInt(rng, 3, 10);
  const initialCols = cols;
  const initialRows = rows;
  const textTokens = [
    "a",
    "xy",
    "12345",
    "漢",
    "字",
    "あ",
    "\u{1F9E0}",
    "\u{1FA70}",
    "\u{1FA95}",
    "\u{1FAE8}",
    "\u231A",
    "\u26A1",
    "\u2B50",
    "e\u0301",
    "漢\u0301",
    "\u0301",
    "\u{1F468}\u200D\u{1F469}",
    "\u2764\uFE0F",
    "a\u{E0100}b",
    "\u00ad",
    "\ufeff",
    "§",
    "─",
    "★",
    "\r",
    "\n",
    "\r\n",
    "\b",
    "\t",
  ];
  const steps: ParityStep[] = [];
  const pushWrite = (data: string) => {
    for (const piece of splitChunkRandomly(rng, data)) {
      steps.push({ kind: "write", data: piece });
    }
  };
  const stepCount = randInt(rng, 14, 30);
  let inAlt = false;
  let mainWritten = false;
  for (let i = 0; i < stepCount; i += 1) {
    const roll = rng();
    if (roll < 0.24) {
      const pieceCount = randInt(rng, 1, 4);
      let chunk = "";
      for (let j = 0; j < pieceCount; j += 1) {
        chunk += pick(rng, textTokens);
      }
      if (rng() < 0.45) {
        chunk += `\x1b[${randInt(rng, 0, 4)}b`;
      }
      if (!inAlt) mainWritten = true;
      pushWrite(chunk);
    } else if (roll < 0.36) {
      const tabOps = [
        "\t",
        "\x1bH",
        "\x88",
        "\x1b[g",
        "\x1b[0g",
        "\x1b[3g",
        "\x1b[I",
        `\x1b[${randInt(rng, 1, 4)}I`,
        "\x1b[Z",
        `\x1b[${randInt(rng, 1, 4)}Z`,
      ];
      pushWrite(pick(rng, tabOps));
    } else if (roll < 0.5) {
      const r = randInt(rng, 0, rows + 2);
      const c = randInt(rng, 0, cols + 2);
      const n = randInt(rng, 0, 5);
      const moves = [
        `\x1b[${r};${c}H`,
        `\x1b[${r};${c}f`,
        `\x1b[${n}A`,
        `\x1b[${n}B`,
        `\x1b[${n}C`,
        `\x1b[${n}D`,
        `\x1b[${n}E`,
        `\x1b[${n}F`,
        `\x1b[${c}G`,
        `\x1b[${c}\``,
        `\x1b[${n}a`,
        `\x1b[${r}d`,
        `\x1b[${n}e`,
        `\x1b[${n}b`,
      ];
      pushWrite(pick(rng, moves));
    } else if (roll < 0.6) {
      const top = randInt(rng, 1, rows + 1);
      const bottom = randInt(rng, 1, rows + 2);
      pushWrite(
        pick(rng, [
          `\x1b[${top};${bottom}r`,
          "\x1b[r",
          `\x1b[${top}r`,
        ]),
      );
    } else if (roll < 0.69) {
      const altSeq = pick(rng, [
        { seq: "\x1b[?47h", nextAlt: true },
        { seq: "\x1b[?47l", nextAlt: false },
        { seq: "\x1b[?1047h", nextAlt: true },
        { seq: "\x1b[?1047l", nextAlt: false },
        { seq: "\x1b[?1049h", nextAlt: true },
        { seq: "\x1b[?1049l", nextAlt: false },
      ]);
      inAlt = altSeq.nextAlt;
      pushWrite(altSeq.seq);
    } else if (roll < 0.77) {
      pushWrite(
        pick(rng, [
          "\x1b7",
          "\x1b8",
          "\x1b[s",
          "\x1b[u",
          "\x1b[?1048h",
          "\x1b[?1048l",
        ]),
      );
    } else if (roll < 0.85) {
      pushWrite(
        pick(rng, [
          "\x1bD",
          "\x84",
          "\x1bE",
          "\x85",
          "\x1bM",
          "\x1b[?6h",
          "\x1b[?6l",
          "\x1b[?7h",
          "\x1b[?7l",
          "\x1b[20h",
          "\x1b[20l",
        ]),
      );
    } else if (roll < 0.92) {
      const editSeq = pick(rng, [
        "\x1b[L",
        "\x1b[2L",
        "\x1b[M",
        "\x1b[2M",
        "\x1b[@",
        "\x1b[P",
        "\x1b[X",
        "\x1b[J",
        "\x1b[2J",
        "\x1b[3J",
        "\x1b[K",
        "\x1b[?2K",
        "\x1b[!p",
        "\x1b[2 A",
        "\x1b[2 @",
        "\x1b[2 q",
        "\x1b#8",
        "\x1bc",
      ]);
      if (editSeq === "\x1bc") {
        inAlt = false;
        mainWritten = false;
      } else if (editSeq === "\x1b#8" && !inAlt) {
        mainWritten = true;
      }
      pushWrite(editSeq);
    } else if (roll < 0.96 && !mainWritten) {
      cols = randInt(rng, 4, 24);
      rows = randInt(rng, 3, 10);
      steps.push({ kind: "resize", cols, rows });
    } else {
      pushWrite(rng() < 0.5 ? "\x1b[6n" : "\x1b[?6n");
    }
  }
  pushWrite("\x1b[6n\x1b[?6n");
  return { cols: initialCols, rows: initialRows, steps };
}

describe("TerminalCursorPositionQueries xterm.js Unicode 11 parity", () => {
  it.each([
    {
      name: "wide emoji across U+1F900-1FAFF (U+1F9E0, U+1FA70, U+1FA95, U+1FAE8)",
      cols: 20,
      rows: 5,
      input: "\u{1F9E0}\u{1FA70}\u{1FA95}\u{1FAE8}\x1b[6n\x1b[?6n",
    },
    {
      name: "BMP wide emoji symbols (U+231A, U+26A1, U+2B50)",
      cols: 20,
      rows: 5,
      input: "\u231A\u26A1\u2B50\x1b[6n\x1b[?6n",
    },
    {
      name: "CJK, combining mark, ZWJ, and BMP variation selector",
      cols: 20,
      rows: 5,
      input: "漢e\u0301\u{1F468}\u200D\u{1F469}\u2764\uFE0F\x1b[6n\x1b[?6n",
    },
    {
      name: "non-BMP variation selector U+E0100",
      cols: 20,
      rows: 5,
      input: "a\u{E0100}b\x1b[6n\x1b[?6n",
    },
    {
      name: "East Asian ambiguous characters",
      cols: 20,
      rows: 5,
      input: "§°±×÷α─★\x1b[6n\x1b[?6n",
    },
    {
      name: "wide CJK character at right edge wraps before printing",
      cols: 5,
      rows: 4,
      input: "abcd漢\x1b[6n\x1b[?6nx\x1b[6n\x1b[?6n",
    },
    {
      name: "wide emoji at right edge wraps before printing",
      cols: 5,
      rows: 4,
      input: "abcd\u{1FA70}\x1b[6n\x1b[?6n",
    },
    {
      name: "wide character wrapping onto a 2-column line",
      cols: 2,
      rows: 4,
      input: "a漢X\x1b[6n\x1b[?6n",
    },
    {
      name: "wide character at right edge with autowrap disabled",
      cols: 5,
      rows: 4,
      input: "\x1b[?7labcd漢\x1b[6n\x1b[?6n",
    },
    {
      name: "scroll region with newlines at bottom",
      cols: 10,
      rows: 5,
      input: "\x1b[2;4r\x1b[4;5H\n\n\x1b[6n\x1b[?6n",
    },
    {
      name: "scroll region newline below bottom clamps at screen bottom",
      cols: 10,
      rows: 5,
      input: "\x1b[2;3r\x1b[4;3H\n\n\x1b[6n\x1b[?6n",
    },
    {
      name: "alternate screen enter and exit preserves main cursor",
      cols: 10,
      rows: 5,
      input:
        "\x1b[3;6H\x1b[?1049h\x1b[2;4H\x1b[6n\x1b[?6n\x1b[?1049l\x1b[6n\x1b[?6n",
    },
    {
      name: "DECSC/DECRC and SCOSC/SCORC cursor save and restore",
      cols: 10,
      rows: 5,
      input:
        "\x1b[2;5H\x1b7\x1b[4;9H\x1b8\x1b[6n\x1b[?6n\x1b[3;7H\x1b[s\x1b[1;1H\x1b[u\x1b[6n\x1b[?6n",
    },
    {
      name: "origin mode relative CUP, CPR, and DECXCPR",
      cols: 10,
      rows: 6,
      input:
        "\x1b[2;5r\x1b[?6h\x1b[6n\x1b[?6n\x1b[2;4H\x1b[6n\x1b[?6n\x1b[99;1H\x1b[6n\x1b[?6n\x1b[?6l\x1b[6n\x1b[?6n",
    },
    {
      name: "HT, HTS (ESC H and C1), TBC (0 and 3), CHT, and CBT including pending-wrap no-op",
      cols: 20,
      rows: 4,
      input:
        "\t\x1b[6n\x1b[2I\x1b[6n\x1b[1Z\x1b[6n\x1b[3g\r\t\x1b[6n\x1b[1;4H\x1bH\x1b[1;11H\x88\r\x1b[I\x1b[6n\x1b[I\x1b[6n\x1b[0g\x1b[1;15H\x1b[Z\x1b[6n\x1b[1;20Ha\x1b[I\x1b[Z\t\x1b[6n",
    },
    {
      name: "REP (CSI Ps b) with ASCII, wide CJK, combining marks, pending wrap, autowrap off, and post-CSI reset",
      cols: 10,
      rows: 4,
      input:
        "a\x1b[2b\x1b[6n\x1b[2b\x1b[6n\r漢\x1b[2b\x1b[6n\ra\u0301\x1b[b\x1b[6n\x1b[1;9H漢\x1b[2b\x1b[6n\x1b[?7l\x1b[1;9H漢\x1b[2b\x1b[6n",
    },
    {
      name: "DECSC/DECRC, CSI s/u, and DECSET/DECRST 1048 across normal scrollback and pending wrap",
      cols: 10,
      rows: 5,
      input:
        "\x1b[1;10Ha\x1b[?1048h\x1b[?1048l\x1b[6n\x1b[3;4H\x1b7\x1b[5;1H\n\n\x1b8\x1b[6n\x1b[2;6H\x1b[1s\x1b[4;1H\x1b[u\x1b[6n",
    },
    {
      name: "DECSTBM invalid regions ignored and originMode relative cursor moves",
      cols: 10,
      rows: 6,
      input:
        "\x1b[2;5r\x1b[3;4H\x1b[4;2r\x1b[6n\x1b[3;3r\x1b[6n\x1b[?6h\x1b[2;3H\x1b[1A\x1b[6n\x1b[1B\x1b[6n\x1b[1E\x1b[6n\x1b[1F\x1b[6n\x1b[1e\x1b[6n",
    },
    {
      name: "DECAWM autowrap and pending-wrap with ED, EL, ICH, DCH, ECH, IND, NEL, and RI",
      cols: 6,
      rows: 4,
      input:
        "abcdef\x1b[K\x1b[6n\x1b[J\x1b[6n\x1b[@\x1b[6n\rabcdef\x1b[P\x1b[6n\rabcdef\x1b[X\x1b[6n\rabcdef\x1bD\x1b[6n\rabcdef\x1bE\x1b[6n\x1b[2;6Ha\x1bM\x1b[6n",
    },
    {
      name: "IND, NEL, and RI (ESC D/E/M and C1 0x84/0x85) across scroll margins",
      cols: 10,
      rows: 5,
      input:
        "\x1b[2;4r\x1b[2;5H\x1bM\x1b[6n\x1b[1;5H\x1bM\x1b[6n\x1b[4;5H\x84\x1b[6n\x85\x1b[6n\x1b[5;5H\x1bD\x1b[6n",
    },
    {
      name: "alternate screen modes 47, 1047, and 1049 cursor transfer, pending wrap, and alt tab reset",
      cols: 12,
      rows: 5,
      input:
        "\x1b[2;12Ha\x1b[?47h\x1b[6n\x1b[3g\x1b[3;5H\x1b[?47l\x1b[6n\x1b[?1047h\r\t\x1b[6n\x1b[?1047l\x1b[4;2H\x1b[?1049h\x1b[1;8H\x1b[?1049h\x1b[2;2H\x1b[?1049l\x1b[6n",
    },
    {
      name: "IL and DL resetting column inside margins, DECSTR soft reset, DECALN, LNM, and CSI intermediates",
      cols: 10,
      rows: 5,
      input:
        "\x1b[2;4r\x1b[1;6H\x1b[L\x1b[6n\x1b[2;6H\x1b[L\x1b[6n\x1b[3;7H\x1b[M\x1b[6n\x1b[20h\x1b[2;5H\n\x1b[6n\x1b[20l\x1b[?6h\x1b[2;4H\x1b[!p\x1b[6n\x1b[2 A\x1b[2 @\x1b[6n\x1b#8\x1b[6n",
    },
    {
      name: "orphan combining marks, BOM, soft hyphen, DEL/C0 inside CSI/ESC, and ESC-terminated OSC",
      cols: 10,
      rows: 4,
      input:
        "\ufeff\u00ad\x1b[6n\x1b[1;5H\u0301\x1b[6n\x1b[1;10Ha\x1b[0m\u0301\x1b[6na\x1b[6n\x1b]0;title\x1b[2;4H\x1b\x7f[1C\x1b[\r3C\x1b[6n",
    },
  ])(
    "matches live headless xterm.js on: $name",
    async ({ cols, rows, input }) => {
      const { xtermReplies, trackerReplies } = await runBoth(cols, rows, [
        { kind: "write", data: input },
      ]);
      expect(xtermReplies.length).toBeGreaterThan(0);
      expect(trackerReplies).toEqual(xtermReplies);
    },
  );

  it(
    `matches live headless xterm.js across ${RANDOM_SEQUENCE_COUNT} seeded randomized sequences (seed=0x${RANDOM_SEED.toString(16)})`,
    async () => {
      const rng = createRng(RANDOM_SEED);
      for (let index = 0; index < RANDOM_SEQUENCE_COUNT; index += 1) {
        const testCase = generateRandomCase(rng);
        const { xtermReplies, trackerReplies } = await runBoth(
          testCase.cols,
          testCase.rows,
          testCase.steps,
        );
        expect(
          trackerReplies,
          `mismatch on randomized sequence #${index} (${testCase.cols}x${testCase.rows}): ${JSON.stringify(testCase.steps)}`,
        ).toEqual(xtermReplies);
      }
    },
    30_000,
  );

  it(
    `matches live headless xterm.js across ${EXTENDED_RANDOM_SEQUENCE_COUNT} extended seeded sequences mixing tabs, REP, modes, margins, alt screen, and wide chars (seed=0x${EXTENDED_RANDOM_SEED.toString(16)})`,
    async () => {
      const rng = createRng(EXTENDED_RANDOM_SEED);
      for (let index = 0; index < EXTENDED_RANDOM_SEQUENCE_COUNT; index += 1) {
        const testCase = generateExtendedRandomCase(rng);
        const { xtermReplies, trackerReplies } = await runBoth(
          testCase.cols,
          testCase.rows,
          testCase.steps,
        );
        expect(
          trackerReplies,
          `mismatch on extended randomized sequence #${index} (${testCase.cols}x${testCase.rows}): ${JSON.stringify(testCase.steps)}`,
        ).toEqual(xtermReplies);
      }
    },
    30_000,
  );

  it("defers to downstream xterm when cursor position becomes unknown and resumes answering after CUP", async () => {
    const reflowCase = await runPipelineAndReference(10, 5, [
      { kind: "write", data: "1234567890X\r\nab\x1b[6n" },
      { kind: "resize", cols: 4, rows: 5 },
      { kind: "write", data: "\x1b[6n\x1b[?6n" },
      { kind: "write", data: "\x1b[2;3H\x1b[6n\x1b[?6n" },
    ]);
    expect(reflowCase.combinedReplies).toEqual(reflowCase.referenceReplies);
    expect(reflowCase.daemonReplies).toEqual([
      "\x1b[3;3R",
      "\x1b[2;3R",
      "\x1b[?2;3R",
    ]);

    const reverseWrapCase = await runPipelineAndReference(6, 4, [
      { kind: "write", data: "\x1b[?45habcdefX\b\b\x1b[6n" },
      { kind: "write", data: "\x1b[3;2H\x1b[?6n" },
    ]);
    expect(reverseWrapCase.combinedReplies).toEqual(
      reverseWrapCase.referenceReplies,
    );
    expect(reverseWrapCase.daemonReplies).toEqual(["\x1b[?3;2R"]);
  });

  it(
    "never answers with an unvouched position across 100 seeded pipeline sequences with arbitrary resizes and reverse-wraparound (seed=0x538c0de3)",
    async () => {
      const rng = createRng(0x538c0de3);
      const tokens = [
        "a",
        "live-1",
        "1234567890",
        "漢",
        "\u{1F9E0}",
        "e\u0301",
        "\r",
        "\n",
        "\b",
        "\t",
        "\x1b[2I",
        "\x1b[Z",
        "\x1bH",
        "\x1b[0g",
        "\x1b[3g",
        "\x1b[2b",
        "\x1b7",
        "\x1b8",
        "\x1b[?45h",
        "\x1b[?45l",
        "\x1b[4h",
        "\x1b[4l",
        "\x1b[@",
        "\x1b[?1049h",
        "\x1b[?1049l",
        "\x1b[2;4r",
        "\x1b[r",
        "\x1b[?6h",
        "\x1b[?6l",
        "\x1b[2;3H",
        "\x1b[1;1H",
        "\x1bc",
      ];
      for (let index = 0; index < 100; index += 1) {
        let cols = randInt(rng, 4, 20);
        let rows = randInt(rng, 3, 8);
        const initialCols = cols;
        const initialRows = rows;
        const steps: ParityStep[] = [];
        const stepCount = randInt(rng, 10, 22);
        for (let i = 0; i < stepCount; i += 1) {
          const roll = rng();
          if (roll < 0.6) {
            let chunk = "";
            const count = randInt(rng, 1, 3);
            for (let j = 0; j < count; j += 1) {
              chunk += pick(rng, tokens);
            }
            steps.push({ kind: "write", data: chunk });
          } else if (roll < 0.8) {
            cols = randInt(rng, 4, 24);
            rows = randInt(rng, 2, 10);
            steps.push({ kind: "resize", cols, rows });
          } else {
            steps.push({
              kind: "write",
              data: rng() < 0.5 ? "\x1b[6n" : "\x1b[?6n",
            });
          }
        }
        steps.push({ kind: "write", data: "\x1b[6n\x1b[?6n" });
        const result = await runPipelineAndReference(
          initialCols,
          initialRows,
          steps,
        );
        expect(
          result.combinedReplies,
          `pipeline mismatch #${index} (${initialCols}x${initialRows}): ${JSON.stringify(steps)}`,
        ).toEqual(result.referenceReplies);
      }
    },
    30_000,
  );
});
