import { createTerminalGridByteMarkerScanner } from "@bb/domain";

const TERMINAL_TOKEN =
  /\u001b\[([0-9;?<>=]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b([78DEMc=>])|([\s\S])/gu;
const TERMINAL_CONTROL_SEQUENCE =
  /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78DEHMc]/gu;
const TERMINAL_SCREEN_RESET =
  /\u001b\[[0-3]?J|\u001bc|\u001b\[\?(?:47|1047|1049)[hl]/u;
const ECHO_IGNORED_CHARACTER = /^[\s─-╿]$/u;
const ECHO_IGNORED_CHARACTERS = /[\s─-╿]/gu;
const ECHO_BORDER_ROW = /^[\s─-╿]*[─-╿][\s─-╿]*$/u;
const ECHO_TAIL_LENGTH = 32;
const ECHO_DRAWN_SHARE = 0.75;
const PLACEHOLDER_DETAIL_LENGTH = 32;
const INPUT_PROMPT_MARKERS: ReadonlySet<EchoToken> = new Set(["❯", "›"]);
const REDRAWN_INPUT_PROMPT_MARKERS: ReadonlySet<EchoToken> = new Set(["❯"]);

type EchoToken = string | null;

export function normalizeTerminalEcho(value: string): string {
  return value
    .replace(TERMINAL_CONTROL_SEQUENCE, "")
    .replace(ECHO_IGNORED_CHARACTERS, "");
}

export function decodeTerminalOutputChunks(
  chunks: readonly { dataBase64: string }[],
): string {
  const scanner = createTerminalGridByteMarkerScanner();
  const filtered = chunks.map((chunk) =>
    Buffer.from(scanner.push(Buffer.from(chunk.dataBase64, "base64")).bytes),
  );
  filtered.push(Buffer.from(scanner.flush()));
  return Buffer.concat(filtered).toString("utf8");
}

function csiNumbers(params: string): number[] {
  return params.length === 0
    ? []
    : params.split(";").map((part) => Number.parseInt(part, 10) || 0);
}

interface ReplayedRow {
  index: number;
  tokens: EchoToken[];
  solidTokens: EchoToken[];
}

interface ReplayedCell {
  character: string;
  faint: boolean;
}

function applyGraphicRendition(numbers: readonly number[], faint: boolean) {
  if (numbers.length === 0) return false;
  let next = faint;
  for (let index = 0; index < numbers.length; index += 1) {
    const code = numbers[index]!;
    if (code === 38 || code === 48 || code === 58) {
      index += numbers[index + 1] === 2 ? 4 : 2;
    } else if (code === 0 || code === 22) {
      next = false;
    } else if (code === 2) {
      next = true;
    }
  }
  return next;
}

function replayTerminalRows(output: string): ReplayedRow[] {
  const rows = new Map<number, Map<number, ReplayedCell>>();
  let faint = false;
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
        case "m":
          faint = applyGraphicRendition(numbers, faint);
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
      rowCells(row).set(column, { character, faint });
      column += 1;
    }
  }
  const replayed: ReplayedRow[] = [];
  for (const index of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(index)!;
    if (cells.size === 0) continue;
    const tokens: EchoToken[] = [];
    const solidTokens: EchoToken[] = [];
    const last = Math.max(...cells.keys());
    for (let cell = 0; cell <= last; cell += 1) {
      const value = cells.get(cell);
      if (value === undefined) {
        tokens.push(null);
        solidTokens.push(null);
      } else if (!ECHO_IGNORED_CHARACTER.test(value.character)) {
        tokens.push(value.character);
        if (!value.faint) solidTokens.push(value.character);
      }
    }
    replayed.push({ index, tokens, solidTokens });
  }
  return replayed;
}

function replayTerminalOutput(output: string): EchoToken[] {
  return replayTerminalRows(output).flatMap((row) => row.tokens);
}

function replayTerminalSolidOutput(output: string): EchoToken[] {
  return replayTerminalRows(output).flatMap((row) => row.solidTokens);
}

function inputLineTokens(
  rows: readonly ReplayedRow[],
  markers: ReadonlySet<EchoToken>,
): EchoToken[] | null {
  let promptAt = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (markers.has(rows[index]!.tokens[0] ?? null)) {
      promptAt = index;
      break;
    }
  }
  if (promptAt < 0) return null;
  return [
    ...rows[promptAt]!.solidTokens.slice(1),
    ...rows.slice(promptAt + 1).flatMap((row) => row.solidTokens),
  ];
}

function replayTerminalInputLine(
  output: string,
  screenRows: number,
): EchoToken[] {
  const rows = replayTerminalRows(output);
  const bottom = rows.at(-1)?.index;
  if (bottom === undefined) return [];
  const screen = rows.filter((row) => row.index > bottom - screenRows);
  return (
    inputLineTokens(screen, INPUT_PROMPT_MARKERS) ??
    screen.flatMap((row) => row.tokens)
  );
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
    looseMatchEnds(
      replayTerminalInputLine(args.output, args.screenRows),
      needle,
    ).length > 0
  );
}

export function terminalScreenInputBoxIsEmpty(args: {
  cursor: { col: number; row: number };
  rows: readonly string[];
}): boolean {
  let promptAt = -1;
  for (let index = args.rows.length - 1; index >= 0; index -= 1) {
    const first = Array.from(args.rows[index]!.trimStart())[0] ?? null;
    if (INPUT_PROMPT_MARKERS.has(first)) {
      promptAt = index;
      break;
    }
  }
  if (promptAt < 0) return false;
  const row = args.rows[promptAt]!;
  const prompt = row.trimStart();
  const marker = Array.from(prompt)[0]!;
  const remainder = prompt.slice(marker.length);
  const next = args.rows[promptAt + 1];
  if (next !== undefined && next.trim() !== "" && !ECHO_BORDER_ROW.test(next)) {
    return false;
  }
  if (remainder.trim() === "") return true;
  const promptEnd = row.length - prompt.length + marker.length;
  return (
    args.cursor.row === promptAt &&
    args.cursor.col <= promptEnd + 1 &&
    /^[\s ]/u.test(remainder)
  );
}

export function terminalScreenInputBoxHoldsText(args: {
  cols: number;
  cursor: { col: number; row: number };
  requestText?: string;
  rows: readonly string[];
  text: string;
}): boolean {
  let promptAt = -1;
  for (let index = args.rows.length - 1; index >= 0; index -= 1) {
    const first = Array.from(args.rows[index]!.trimStart())[0] ?? null;
    if (INPUT_PROMPT_MARKERS.has(first)) {
      promptAt = index;
      break;
    }
  }
  if (promptAt < 0) return false;
  const prompt = args.rows[promptAt]!.trimStart();
  const marker = Array.from(prompt)[0];
  if (marker === undefined) return false;
  const promptStart = args.rows[promptAt]!.length - prompt.length;
  const promptRemainder = prompt.slice(marker.length);
  if (args.requestText?.startsWith(" ") && promptRemainder.startsWith(" ")) {
    return false;
  }
  let promptPadding = 0;
  if (promptRemainder.startsWith("\u00a0")) promptPadding = 1;
  else if (promptRemainder.startsWith(" ")) {
    if (promptRemainder.startsWith("  ")) return false;
    promptPadding = 1;
  }
  const firstStart = promptStart + 1 + promptPadding;
  const firstCapacity = args.cols - firstStart;
  if (firstCapacity < 1) return false;
  const firstPayload = promptRemainder.slice(promptPadding);
  if (firstPayload.endsWith(" ")) return false;

  const payloads = [firstPayload];
  const rows = [promptAt];
  let borderAt = -1;
  for (let index = promptAt + 1; index < args.rows.length; index += 1) {
    const row = args.rows[index]!;
    if (ECHO_BORDER_ROW.test(row)) {
      borderAt = index;
      break;
    }
    if (!row.startsWith("  ") || row.endsWith(" ")) return false;
    payloads.push(row.slice(2));
    rows.push(index);
  }
  if (borderAt < 0) return false;

  const payload = payloads[0]!;
  let joined = payload;
  let startColumn = firstStart;
  for (let index = 1; index < payloads.length; index += 1) {
    const previousCapacity = index === 1 ? firstCapacity : args.cols - 2;
    if (Array.from(payloads[index - 1]!).length !== previousCapacity) {
      return false;
    }
    joined += payloads[index]!;
    startColumn = 2;
  }

  const lastPayload = payloads.at(-1)!;
  const lastRow = rows.at(-1)!;
  const lastCapacity =
    startColumn === firstStart ? firstCapacity : args.cols - 2;
  const visibleEnd = startColumn + Array.from(lastPayload).length;
  if (
    visibleEnd === args.cols - 1 &&
    args.cursor.col === args.cols - 1 &&
    Array.from(lastPayload).length < lastCapacity
  ) {
    return false;
  }
  const cursorAtWrappedEnd =
    Array.from(lastPayload).length === lastCapacity &&
    args.cursor.col === args.cols - 1;
  if (
    args.cursor.row !== lastRow ||
    (!cursorAtWrappedEnd && args.cursor.col !== visibleEnd)
  ) {
    return false;
  }

  if (/^[ \u00a0\t]|[ \u00a0\t]$/u.test(joined)) return false;
  return joined === args.text;
}

export function terminalOutputShowsPasteAgain(args: {
  before: string;
  output: string;
  pastePlaceholders: readonly string[];
  text: string;
}): boolean {
  if (TERMINAL_SCREEN_RESET.test(args.output)) {
    const resets = [
      ...args.output.matchAll(
        /\u001b\[[0-3]?J|\u001bc|\u001b\[\?(?:47|1047|1049)[hl]/gu,
      ),
    ];
    const reset = resets.at(-1);
    if (reset === undefined || reset.index === undefined) return false;
    const redrawn = replayTerminalRows(
      args.output.slice(reset.index + reset[0].length),
    );
    const redraw = args.output.slice(reset.index + reset[0].length);
    const fullNeedle = echoNeedle(args.text);
    const needle = fullNeedle.slice(-ECHO_TAIL_LENGTH);
    const beforeCopies = occurrenceCount(
      replayTerminalSolidOutput(args.before),
      needle,
    );
    if (
      occurrenceCount(replayTerminalSolidOutput(redraw), needle) <= beforeCopies
    ) {
      return false;
    }
    const input = inputLineTokens(redrawn, REDRAWN_INPUT_PROMPT_MARKERS);
    if (input === null) return false;
    const head = fullNeedle.slice(0, ECHO_TAIL_LENGTH);
    const drawnHead = input.slice(0, head.length);
    const tail = fullNeedle.slice(-ECHO_TAIL_LENGTH);
    const requiredHead = Math.ceil(head.length * ECHO_DRAWN_SHARE);
    return (
      drawnHead.filter((token, index) => token === head[index]).length >=
        requiredHead && looseMatchEnds(input, tail).length > 0
    );
  }
  if (!terminalOutputShowsPaste(args)) return false;
  const needle = echoNeedle(args.text).slice(-ECHO_TAIL_LENGTH);
  if (looseMatchEnds(replayTerminalOutput(args.output), needle).length === 0) {
    return true;
  }
  return (
    occurrenceCount(
      replayTerminalSolidOutput(args.before + args.output),
      needle,
    ) > occurrenceCount(replayTerminalSolidOutput(args.before), needle)
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
  if (
    placeholderDetails(drawn, args.pastePlaceholders).some(
      (detail) => !stale.some((seen) => sameDetail(detail, seen)),
    )
  ) {
    return true;
  }
  if (TERMINAL_SCREEN_RESET.test(args.output)) return false;
  const earlier = replayTerminalOutput(args.before);
  const current = replayTerminalOutput(args.before + args.output);
  return args.pastePlaceholders.some((placeholder) => {
    const chip = echoNeedle(placeholder);
    return occurrenceCount(current, chip) > occurrenceCount(earlier, chip);
  });
}
