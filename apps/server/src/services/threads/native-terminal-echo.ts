const TERMINAL_TOKEN =
  /\u001b\[([0-9;?<>=]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b([78DEMc=>])|([\s\S])/gu;
const TERMINAL_CONTROL_SEQUENCE =
  /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78DEHMc]/gu;
const TERMINAL_SCREEN_RESET =
  /\u001b\[[0-3]?J|\u001bc|\u001b\[\?(?:47|1047|1049)[hl]/u;
const ECHO_IGNORED_CHARACTER = /^[\s─-╿]$/u;
const ECHO_IGNORED_CHARACTERS = /[\s─-╿]/gu;
const ECHO_TAIL_LENGTH = 32;
const ECHO_DRAWN_SHARE = 0.75;
const PLACEHOLDER_DETAIL_LENGTH = 32;

type EchoToken = string | null;

export function normalizeTerminalEcho(value: string): string {
  return value
    .replace(TERMINAL_CONTROL_SEQUENCE, "")
    .replace(ECHO_IGNORED_CHARACTERS, "");
}

export function decodeTerminalOutputChunks(
  chunks: readonly { dataBase64: string }[],
): string {
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  ).toString("utf8");
}

function csiNumbers(params: string): number[] {
  return params.length === 0
    ? []
    : params.split(";").map((part) => Number.parseInt(part, 10) || 0);
}

interface ReplayedRow {
  index: number;
  tokens: EchoToken[];
}

function replayTerminalRows(output: string): ReplayedRow[] {
  const rows = new Map<number, Map<number, string>>();
  let row = 0;
  let column = 0;
  let saved = { row: 0, column: 0 };
  const rowCells = (index: number) => {
    let cells = rows.get(index);
    if (cells === undefined) {
      cells = new Map();
      rows.set(index, cells);
    }
    return cells;
  };
  const eraseRow = (index: number, keep: (cell: number) => boolean) => {
    const cells = rows.get(index);
    if (cells === undefined) return;
    for (const cell of [...cells.keys()]) {
      if (!keep(cell)) cells.delete(cell);
    }
  };
  for (const match of output.matchAll(TERMINAL_TOKEN)) {
    const [, params, intermediates, final, escape, character] = match;
    if (final !== undefined) {
      if (/^[?<>=]/u.test(params ?? "") || (intermediates ?? "") !== "") {
        continue;
      }
      const numbers = csiNumbers(params ?? "");
      const count = Math.max(1, numbers[0] ?? 1);
      switch (final) {
        case "H":
        case "f":
          row = Math.max(1, numbers[0] ?? 1) - 1;
          column = Math.max(1, numbers[1] ?? 1) - 1;
          break;
        case "A":
          row -= count;
          break;
        case "B":
          row += count;
          break;
        case "C":
          column += count;
          break;
        case "D":
          column = Math.max(0, column - count);
          break;
        case "E":
          row += count;
          column = 0;
          break;
        case "F":
          row -= count;
          column = 0;
          break;
        case "G":
          column = count - 1;
          break;
        case "d":
          row = count - 1;
          break;
        case "K": {
          const mode = numbers[0] ?? 0;
          const from = column;
          eraseRow(row, (cell) =>
            mode === 0 ? cell < from : mode === 1 ? cell > from : false,
          );
          break;
        }
        case "J": {
          const mode = numbers[0] ?? 0;
          if (mode >= 2) {
            rows.clear();
            break;
          }
          const from = { row, column };
          for (const index of [...rows.keys()]) {
            if (mode === 0 ? index > from.row : index < from.row) {
              rows.delete(index);
            }
          }
          eraseRow(row, (cell) =>
            mode === 0 ? cell < from.column : cell > from.column,
          );
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (escape !== undefined) {
      if (escape === "7") saved = { row, column };
      if (escape === "8") ({ row, column } = saved);
      if (escape === "D") row += 1;
      if (escape === "E") {
        row += 1;
        column = 0;
      }
      if (escape === "M") row -= 1;
      if (escape === "c") rows.clear();
      continue;
    }
    if (character === undefined) continue;
    if (character === "\r") column = 0;
    else if (character === "\n") row += 1;
    else if (character === "\b") column = Math.max(0, column - 1);
    else if (character === "\t") column = (Math.floor(column / 8) + 1) * 8;
    else if (character.codePointAt(0)! >= 0x20 && character !== "\u007f") {
      rowCells(row).set(column, character);
      column += 1;
    }
  }
  const replayed: ReplayedRow[] = [];
  for (const index of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(index)!;
    if (cells.size === 0) continue;
    const tokens: EchoToken[] = [];
    const last = Math.max(...cells.keys());
    for (let cell = 0; cell <= last; cell += 1) {
      const value = cells.get(cell);
      if (value === undefined) tokens.push(null);
      else if (!ECHO_IGNORED_CHARACTER.test(value)) tokens.push(value);
    }
    replayed.push({ index, tokens });
  }
  return replayed;
}

function replayTerminalOutput(output: string): EchoToken[] {
  return replayTerminalRows(output).flatMap((row) => row.tokens);
}

function replayTerminalScreen(output: string, screenRows: number): EchoToken[] {
  const rows = replayTerminalRows(output);
  const bottom = rows.at(-1)?.index;
  if (bottom === undefined) return [];
  return rows
    .filter((row) => row.index > bottom - screenRows)
    .flatMap((row) => row.tokens);
}

function occurrenceCount(tokens: EchoToken[], needle: string[]): number {
  let count = 0;
  let counted = Number.NEGATIVE_INFINITY;
  for (const end of looseMatchEnds(tokens, needle)) {
    if (end - counted < needle.length) continue;
    count += 1;
    counted = end;
  }
  return count;
}

function echoNeedle(value: string): string[] {
  return Array.from(normalizeTerminalEcho(value));
}

function looseMatchEnds(tokens: EchoToken[], needle: string[]): number[] {
  const length = needle.length;
  if (length === 0) return [];
  const required = Math.ceil(length * ECHO_DRAWN_SHARE);
  const ends: number[] = [];
  let best = new Array<number>(length + 1).fill(-1);
  for (const [position, token] of tokens.entries()) {
    best[0] = Math.max(best[0]!, 0);
    const next = new Array<number>(length + 1).fill(-1);
    for (let matched = 0; matched < length; matched += 1) {
      const drawn = best[matched]!;
      if (drawn < 0) continue;
      if (token === null) {
        next[matched] = Math.max(next[matched]!, drawn);
        next[matched + 1] = Math.max(next[matched + 1]!, drawn);
      } else if (token === needle[matched]) {
        next[matched + 1] = Math.max(next[matched + 1]!, drawn + 1);
      }
    }
    if (next[length]! >= required) ends.push(position);
    best = next;
  }
  return ends;
}

function placeholderDetails(
  tokens: EchoToken[],
  pastePlaceholders: readonly string[],
): EchoToken[][] {
  const details: EchoToken[][] = [];
  for (const placeholder of pastePlaceholders) {
    for (const end of looseMatchEnds(tokens, echoNeedle(placeholder))) {
      const detail: EchoToken[] = [];
      for (const token of tokens.slice(
        end + 1,
        end + 1 + PLACEHOLDER_DETAIL_LENGTH,
      )) {
        detail.push(token);
        if (token === "]") break;
      }
      details.push(detail);
    }
  }
  return details;
}

function sameDetail(left: EchoToken[], right: EchoToken[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (token, index) =>
        token === null || right[index] === null || token === right[index],
    )
  );
}

export function terminalOutputAlreadyShowsText(args: {
  output: string;
  text: string;
}): boolean {
  const needle = echoNeedle(args.text).slice(-ECHO_TAIL_LENGTH);
  return looseMatchEnds(replayTerminalOutput(args.output), needle).length > 0;
}

export function terminalScreenAlreadyShowsText(args: {
  output: string;
  screenRows: number;
  text: string;
}): boolean {
  const needle = echoNeedle(args.text).slice(-ECHO_TAIL_LENGTH);
  return (
    looseMatchEnds(replayTerminalScreen(args.output, args.screenRows), needle)
      .length > 0
  );
}

export function terminalOutputShowsPasteAgain(args: {
  before: string;
  output: string;
  pastePlaceholders: readonly string[];
  text: string;
}): boolean {
  if (TERMINAL_SCREEN_RESET.test(args.output)) return false;
  if (!terminalOutputShowsPaste(args)) return false;
  const needle = echoNeedle(args.text).slice(-ECHO_TAIL_LENGTH);
  if (looseMatchEnds(replayTerminalOutput(args.output), needle).length === 0) {
    return true;
  }
  return (
    occurrenceCount(replayTerminalOutput(args.before + args.output), needle) >
    occurrenceCount(replayTerminalOutput(args.before), needle)
  );
}

export function terminalOutputShowsPaste(args: {
  before: string;
  output: string;
  pastePlaceholders: readonly string[];
  text: string;
}): boolean {
  const drawn = replayTerminalOutput(args.output);
  const needle = echoNeedle(args.text).slice(-ECHO_TAIL_LENGTH);
  if (looseMatchEnds(drawn, needle).length > 0) return true;
  const stale = placeholderDetails(
    replayTerminalOutput(args.before),
    args.pastePlaceholders,
  );
  return placeholderDetails(drawn, args.pastePlaceholders).some(
    (detail) => !stale.some((seen) => sameDetail(detail, seen)),
  );
}
