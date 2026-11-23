import { describe, expect, it } from "vitest";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { TerminalCursorPositionQueries } from "@bb/domain";

const RANDOM_SEED = 0x538c0de1;
const RANDOM_SEQUENCE_COUNT = 200;

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
  const tracker = new TerminalCursorPositionQueries(cols, rows, 64);
  const xtermReplies: string[] = [];
  const trackerReplies: string[] = [];
  terminal.onData((data) => {
    xtermReplies.push(data);
  });
  try {
    for (const step of steps) {
      if (step.kind === "resize") {
        terminal.resize(step.cols, step.rows);
        tracker.resize(step.cols, step.rows);
      } else {
        await writeHeadless(terminal, step.data);
        tracker.push(step.data, (reply) => {
          trackerReplies.push(reply);
        });
      }
    }
  } finally {
    terminal.dispose();
  }
  return { xtermReplies, trackerReplies };
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

  it(`matches live headless xterm.js across ${RANDOM_SEQUENCE_COUNT} seeded randomized sequences (seed=0x${RANDOM_SEED.toString(16)})`, async () => {
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
  });
});
