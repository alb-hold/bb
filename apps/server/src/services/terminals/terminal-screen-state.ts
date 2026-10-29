import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import {
  advanceTerminalReplayParserByte,
  advanceTerminalReplayParserBytes,
  createTerminalReplayParserState,
  isTerminalReplaySafeBoundary,
} from "@bb/domain";
import type { TerminalScreenResponse } from "@bb/server-contract";

const TERMINAL_SCREEN_STATE_SCROLLBACK = 2_000;
export const TERMINAL_SCREEN_STATE_PENDING_BYTES_LIMIT = 8 * 1024 * 1024;
const ESC = "\u001b";
const TERMINAL_SCREEN_STATE_PARTIAL_SEQUENCE_LIMIT = 64 * 1024;
const HYPERLINK_URI_LIMIT = 2048;
const HYPERLINK_ID_LIMIT = 256;
const require = createRequire(import.meta.url);
const Terminal = require("@xterm/headless")
  .Terminal as typeof import("@xterm/headless").Terminal;
const { Unicode11Addon } =
  require("@xterm/addon-unicode11") as typeof import("@xterm/addon-unicode11");

type HeadlessTerminal = InstanceType<typeof Terminal>;
type HeadlessCell = NonNullable<
  ReturnType<
    NonNullable<
      ReturnType<HeadlessTerminal["buffer"]["active"]["getLine"]>
    >["getCell"]
  >
>;

interface SgrAttributes {
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
  isBgRGB(): boolean;
  isBgPalette(): boolean;
  getBgColor(): number;
}

interface PenAttributes extends SgrAttributes {
  extended: { urlId: number };
  getUnderlineColor(): number;
  getUnderlineColorMode(): number;
}

const FG_UNDERLINE_FLAG = 0x10000000;
const EXT_UNDERLINE_STYLE_MASK = 0x1c000000;
const EXT_UNDERLINE_STYLE_SHIFT = 26;

const UNDERLINE_COLOR_MODE_PALETTE = 0x2000000;
const UNDERLINE_COLOR_MODE_RGB = 0x3000000;

function underlineCodes(attributes: object): string[] {
  const fg = Reflect.get(attributes, "fg");
  if (typeof fg !== "number" || (fg & FG_UNDERLINE_FLAG) === 0) return [];
  const extended = readObject(attributes, "extended");
  const ext = readObject(extended, "_ext");
  const style =
    typeof ext === "number"
      ? (ext & EXT_UNDERLINE_STYLE_MASK) >>> EXT_UNDERLINE_STYLE_SHIFT
      : 1;
  const codes = [style > 1 && style <= 5 ? `4:${style}` : "4"];
  const mode: unknown = Reflect.get(attributes, "getUnderlineColorMode");
  const color: unknown = Reflect.get(attributes, "getUnderlineColor");
  if (typeof mode === "function" && typeof color === "function") {
    const colorMode: unknown = mode.call(attributes);
    const colorValue: unknown = color.call(attributes);
    if (typeof colorValue === "number") {
      if (colorMode === UNDERLINE_COLOR_MODE_RGB) {
        codes.push(
          `58:2::${colorValue >> 16}:${(colorValue >> 8) & 255}:${colorValue & 255}`,
        );
      } else if (colorMode === UNDERLINE_COLOR_MODE_PALETTE) {
        codes.push(`58:5:${colorValue}`);
      }
    }
  }
  return codes;
}

function sgrCodes(cell: SgrAttributes): string[] {
  const codes: string[] = ["0"];
  if (cell.isBold()) codes.push("1");
  if (cell.isDim()) codes.push("2");
  if (cell.isItalic()) codes.push("3");
  codes.push(...underlineCodes(cell));
  if (cell.isBlink()) codes.push("5");
  if (cell.isInverse()) codes.push("7");
  if (cell.isInvisible()) codes.push("8");
  if (cell.isStrikethrough()) codes.push("9");
  if (cell.isOverline()) codes.push("53");
  if (cell.isFgRGB()) {
    const color = cell.getFgColor();
    codes.push(`38;2;${color >> 16};${(color >> 8) & 255};${color & 255}`);
  } else if (cell.isFgPalette()) {
    codes.push(`38;5;${cell.getFgColor()}`);
  } else {
    codes.push("39");
  }
  if (cell.isBgRGB()) {
    const color = cell.getBgColor();
    codes.push(`48;2;${color >> 16};${(color >> 8) & 255};${color & 255}`);
  } else if (cell.isBgPalette()) {
    codes.push(`48;5;${cell.getBgColor()}`);
  } else {
    codes.push("49");
  }
  return codes;
}

function cellSgr(cell: HeadlessCell): string {
  return `${ESC}[${sgrCodes(cell).join(";")}m`;
}

interface HyperlinkData {
  id?: string;
  uri: string;
}

function readObject(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function cellUrlId(cell: HeadlessCell): number {
  const urlId = readObject(readObject(cell, "extended"), "urlId");
  return typeof urlId === "number" ? urlId : 0;
}

function hyperlinkFor(
  terminal: HeadlessTerminal,
  urlId: number,
): HyperlinkData | null {
  if (urlId === 0) return null;
  const linkService = readObject(
    readObject(terminal, "_core"),
    "_oscLinkService",
  );
  const getLinkData = readObject(linkService, "getLinkData");
  if (typeof getLinkData !== "function") return null;
  const data: unknown = getLinkData.call(linkService, urlId);
  const uri = readObject(data, "uri");
  const id = readObject(data, "id");
  if (
    typeof uri !== "string" ||
    uri.length > HYPERLINK_URI_LIMIT ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(uri)
  ) {
    return null;
  }
  return typeof id === "string" &&
    id.length <= HYPERLINK_ID_LIMIT &&
    !/[\u0000-\u001f\u007f-\u009f;:]/u.test(id)
    ? { id, uri }
    : { uri };
}

function hyperlinkOpen(link: HyperlinkData): string {
  return `${ESC}]8;${link.id === undefined ? "" : `id=${link.id}`};${link.uri}${ESC}\\`;
}

const HYPERLINK_CLOSE = `${ESC}]8;;${ESC}\\`;

function isPenAttributes(value: unknown): value is PenAttributes {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "isBold") === "function" &&
    typeof Reflect.get(value, "getUnderlineColorMode") === "function" &&
    typeof Reflect.get(value, "extended") === "object"
  );
}

function currentPen(terminal: HeadlessTerminal): PenAttributes | null {
  const core: unknown = Reflect.get(terminal, "_core");
  if (typeof core !== "object" || core === null) return null;
  const inputHandler: unknown = Reflect.get(core, "_inputHandler");
  if (typeof inputHandler !== "object" || inputHandler === null) return null;
  const getAttrData: unknown = Reflect.get(inputHandler, "getAttrData");
  if (typeof getAttrData !== "function") return null;
  const pen: unknown = getAttrData.call(inputHandler);
  return isPenAttributes(pen) ? pen : null;
}

function penSgr(pen: PenAttributes): string {
  return `${ESC}[${sgrCodes(pen).join(";")}m`;
}

function restoreModes(terminal: HeadlessTerminal): string {
  const modes = terminal.modes;
  const privateModes: Array<[number, boolean]> = [
    [1, modes.applicationCursorKeysMode],
    [6, modes.originMode],
    [7, modes.wraparoundMode],
    [25, modes.showCursor],
    [45, modes.reverseWraparoundMode],
    [1004, modes.sendFocusMode],
    [2004, modes.bracketedPasteMode],
    [2026, modes.synchronizedOutputMode],
    [9001, modes.win32InputMode],
  ];
  const sequences = privateModes.map(
    ([mode, enabled]) => `${ESC}[?${mode}${enabled ? "h" : "l"}`,
  );
  sequences.push(`${ESC}[${modes.insertMode ? "4h" : "4l"}`);
  sequences.push(`${ESC}${modes.applicationKeypadMode ? "=" : ">"}`);
  if (modes.mouseTrackingMode !== "none") {
    const mouseMode =
      modes.mouseTrackingMode === "x10"
        ? 9
        : modes.mouseTrackingMode === "vt200"
          ? 1000
          : modes.mouseTrackingMode === "drag"
            ? 1002
            : 1003;
    sequences.push(`${ESC}[?${mouseMode}h`);
  }
  return sequences.join("");
}

function concatenateBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

function encodeUtf8(value: string): Buffer {
  const buffer = Buffer.allocUnsafe(Buffer.byteLength(value, "utf8"));
  buffer.write(value, 0, "utf8");
  return buffer;
}

function visibleSolidRows(terminal: HeadlessTerminal): string[] {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    let text = "";
    for (let col = 0; col < terminal.cols; col += 1) {
      const cell = line?.getCell(col);
      if (cell === undefined || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      text += cell.isDim() ? " ".repeat(Array.from(chars).length) : chars;
    }
    rows.push(text.trimEnd());
  }
  return rows;
}

function serializeVisibleScreen(terminal: HeadlessTerminal): {
  data: Buffer;
  response: TerminalScreenResponse;
} {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  const parts = [`${ESC}[?6l${ESC}[?7l${ESC}[?25l${ESC}[2J`];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    let text = "";
    let previousSgr = "";
    let activeUrlId = 0;
    parts.push(`${ESC}[${row + 1};1H`);
    for (let col = 0; col < terminal.cols; col += 1) {
      const cell = line?.getCell(col);
      if (cell === undefined || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      const urlId = cellUrlId(cell);
      const link = hyperlinkFor(terminal, urlId);
      const linkedUrlId = link === null ? 0 : urlId;
      if (linkedUrlId !== activeUrlId) {
        if (activeUrlId !== 0) parts.push(HYPERLINK_CLOSE);
        if (link !== null) parts.push(hyperlinkOpen(link));
        activeUrlId = linkedUrlId;
      }
      const sgr = cellSgr(cell);
      if (sgr !== previousSgr) {
        parts.push(sgr);
        previousSgr = sgr;
      }
      parts.push(chars);
    }
    if (activeUrlId !== 0) parts.push(HYPERLINK_CLOSE);
    rows.push(text.trimEnd());
  }
  const cursorCell = buffer
    .getLine(buffer.baseY + buffer.cursorY)
    ?.getCell(Math.min(buffer.cursorX, terminal.cols - 1));
  parts.push(
    `${ESC}[0m${ESC}[?6l${ESC}[${buffer.cursorY + 1};${buffer.cursorX + 1}H`,
  );
  const pen = currentPen(terminal);
  if (pen !== null) {
    parts.push(penSgr(pen));
    const penLink = hyperlinkFor(terminal, pen.extended.urlId);
    if (penLink !== null) parts.push(hyperlinkOpen(penLink));
  } else if (cursorCell !== undefined) {
    parts.push(cellSgr(cursorCell));
  }
  parts.push(restoreModes(terminal));
  parts.push(`${ESC}[${buffer.cursorY + 1};${buffer.cursorX + 1}H`);
  return {
    data: encodeUtf8(parts.join("")),
    response: {
      rows,
      cursor: { col: buffer.cursorX, row: buffer.cursorY },
      cols: terminal.cols,
      gridRows: terminal.rows,
      truncated: false,
      complete: true,
    },
  };
}

export class TerminalScreenState {
  private readonly terminal: HeadlessTerminal;
  private readonly pendingWork: Array<
    | { kind: "base64"; data: string }
    | { kind: "bytes"; data: Uint8Array }
    | { kind: "resize"; cols: number; rows: number }
  > = [];
  private pendingWorkBytes = 0;
  private cols: number;
  private rows: number;
  private pending = Promise.resolve();
  private draining = false;
  private nextSeq = 0;
  private valid = true;
  private disposed = false;
  private readonly parserState = createTerminalReplayParserState();
  private partialSequence: Uint8Array = new Uint8Array(0);
  private partialSequenceOverflow = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: TERMINAL_SCREEN_STATE_SCROLLBACK,
    });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = "11";
  }

  push(seq: number, data: Uint8Array): void {
    if (this.disposed || !this.valid || seq < this.nextSeq) return;
    if (seq !== this.nextSeq) {
      this.invalidate();
      return;
    }
    this.nextSeq += 1;
    this.enqueue({ kind: "bytes", data });
  }

  pushBase64(seq: number, data: string): void {
    if (this.disposed || !this.valid || seq < this.nextSeq) return;
    if (seq !== this.nextSeq) {
      this.invalidate();
      return;
    }
    this.nextSeq += 1;
    this.enqueue({ kind: "base64", data });
  }

  private trackPartialSequence(data: Uint8Array): void {
    const scan = { ...this.parserState };
    advanceTerminalReplayParserBytes(this.parserState, data);
    if (isTerminalReplaySafeBoundary(this.parserState)) {
      this.partialSequence = new Uint8Array(0);
      this.partialSequenceOverflow = false;
      return;
    }
    let lastSafe = -1;
    for (let index = 0; index < data.length; index += 1) {
      advanceTerminalReplayParserByte(scan, data[index] ?? 0);
      if (isTerminalReplaySafeBoundary(scan)) lastSafe = index + 1;
    }
    if (lastSafe < 0 && this.partialSequenceOverflow) return;
    const open =
      lastSafe >= 0
        ? data.subarray(lastSafe)
        : concatenateBytes(this.partialSequence, data);
    if (open.length > TERMINAL_SCREEN_STATE_PARTIAL_SEQUENCE_LIMIT) {
      this.partialSequence = new Uint8Array(0);
      this.partialSequenceOverflow = true;
      return;
    }
    this.partialSequence = open.slice();
    this.partialSequenceOverflow = false;
  }

  private invalidate(): void {
    this.valid = false;
    this.pendingWork.length = 0;
    this.pendingWorkBytes = 0;
  }

  resize(cols: number, rows: number): void {
    if (
      this.disposed ||
      !this.valid ||
      (this.cols === cols && this.rows === rows)
    ) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.enqueue({ kind: "resize", cols, rows });
  }

  private enqueue(
    work:
      | { kind: "base64"; data: string }
      | { kind: "bytes"; data: Uint8Array }
      | { kind: "resize"; cols: number; rows: number },
  ): void {
    const bytes =
      work.kind === "resize"
        ? 0
        : work.kind === "bytes"
          ? work.data.byteLength
          : Buffer.byteLength(work.data, "utf8");
    if (
      this.pendingWorkBytes + bytes >
      TERMINAL_SCREEN_STATE_PENDING_BYTES_LIMIT
    ) {
      this.invalidate();
      return;
    }
    this.pendingWorkBytes += bytes;
    this.pendingWork.push(work);
    if (this.draining) return;
    this.draining = true;
    this.pending = this.pending
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const drain = () => {
              const next = this.pendingWork.shift();
              if (this.disposed || !this.valid || next === undefined) {
                this.pendingWork.length = 0;
                this.pendingWorkBytes = 0;
                this.draining = false;
                resolve();
                return;
              }
              if (next.kind !== "resize") {
                this.pendingWorkBytes -=
                  next.kind === "bytes"
                    ? next.data.byteLength
                    : Buffer.byteLength(next.data, "utf8");
              }
              try {
                if (next.kind === "resize") {
                  this.terminal.resize(next.cols, next.rows);
                  setImmediate(drain);
                  return;
                }
                const data =
                  next.kind === "base64"
                    ? Buffer.from(next.data, "base64")
                    : next.data;
                this.trackPartialSequence(data);
                this.terminal.write(data, () => {
                  setImmediate(drain);
                });
              } catch (error) {
                this.draining = false;
                reject(error);
              }
            };
            setImmediate(drain);
          }),
      )
      .catch(() => {
        this.draining = false;
        this.invalidate();
      });
  }

  async snapshot(): Promise<
    | (TerminalScreenResponse & { checkpointSeq: number; dataBase64: string })
    | null
  > {
    await this.pending;
    if (this.disposed || !this.valid) return null;
    if (this.partialSequenceOverflow) return null;
    const snapshot = serializeVisibleScreen(this.terminal);
    return {
      ...snapshot.response,
      checkpointSeq: this.nextSeq,
      dataBase64: (this.partialSequence.length === 0
        ? snapshot.data
        : Buffer.concat([snapshot.data, this.partialSequence])
      ).toString("base64"),
    };
  }

  async promptScreen(): Promise<{
    cursor: { col: number; row: number };
    rows: string[];
    solidRows: string[];
  } | null> {
    await this.pending;
    if (this.disposed || !this.valid) return null;
    if (this.partialSequenceOverflow) return null;
    const { response } = serializeVisibleScreen(this.terminal);
    return {
      cursor: response.cursor,
      rows: response.rows,
      solidRows: visibleSolidRows(this.terminal),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingWork.length = 0;
    this.pendingWorkBytes = 0;
    this.terminal.dispose();
  }
}

export class TerminalScreenStateCache {
  private readonly states = new Map<string, TerminalScreenState>();

  has(terminalId: string): boolean {
    return this.states.has(terminalId);
  }

  create(terminalId: string, cols: number, rows: number): void {
    if (this.states.has(terminalId)) return;
    this.states.set(terminalId, new TerminalScreenState(cols, rows));
  }

  install(terminalId: string, state: TerminalScreenState): void {
    this.remove(terminalId);
    this.states.set(terminalId, state);
  }

  push(
    terminalId: string,
    cols: number,
    rows: number,
    seq: number,
    data: Uint8Array,
  ): void {
    let state = this.states.get(terminalId);
    if (state === undefined) {
      if (seq !== 0) return;
      state = new TerminalScreenState(cols, rows);
      this.states.set(terminalId, state);
    }
    state.resize(cols, rows);
    state.push(seq, data);
  }

  pushBase64(
    terminalId: string,
    cols: number,
    rows: number,
    seq: number,
    data: string,
  ): void {
    let state = this.states.get(terminalId);
    if (state === undefined) {
      if (seq !== 0) return;
      state = new TerminalScreenState(cols, rows);
      this.states.set(terminalId, state);
    }
    state.resize(cols, rows);
    state.pushBase64(seq, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.states.get(terminalId)?.resize(cols, rows);
  }

  promptScreen(terminalId: string) {
    return this.states.get(terminalId)?.promptScreen() ?? Promise.resolve(null);
  }

  snapshot(terminalId: string) {
    return this.states.get(terminalId)?.snapshot() ?? Promise.resolve(null);
  }

  remove(terminalId: string): void {
    const state = this.states.get(terminalId);
    if (state === undefined) return;
    this.states.delete(terminalId);
    state.dispose();
  }

  dispose(): void {
    for (const state of this.states.values()) state.dispose();
    this.states.clear();
  }
}
