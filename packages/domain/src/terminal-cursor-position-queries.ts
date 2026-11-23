const MAX_CSI_PARAMS_LENGTH = 64;
const DEFAULT_MAX_REPLIES_PER_CHUNK = 8;

type ParserState =
  | "ground"
  | "esc"
  | "esc-intermediate"
  | "csi"
  | "osc"
  | "osc-esc"
  | "string"
  | "string-esc";

interface SavedCursor {
  row: number;
  col: number;
  originMode: boolean;
  autowrap: boolean;
}

function isQueryPrefix(value: string): boolean {
  return (
    value === "\u001b" ||
    value === "\u001b[" ||
    value === "\u001b[6" ||
    value === "\u001b[?" ||
    value === "\u001b[?6"
  );
}

function codePointWidth(cp: number): number {
  if (
    cp === 0 ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff
  ) {
    return 0;
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
      (cp >= 0x3250 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4c6) ||
      (cp >= 0xa960 && cp <= 0xa97c) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6b) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function parseCsiParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class TerminalCursorPositionQueries {
  private cols: number;
  private rows: number;
  private row = 0;
  private col = 0;
  private pendingWrap = false;
  private scrollTop = 0;
  private scrollBottom: number;
  private originMode = false;
  private autowrap = true;
  private altScreen = false;
  private savedMain: SavedCursor = {
    row: 0,
    col: 0,
    originMode: false,
    autowrap: true,
  };
  private savedAlt: SavedCursor = {
    row: 0,
    col: 0,
    originMode: false,
    autowrap: true,
  };
  private state: ParserState = "ground";
  private csiParams = "";
  private held = "";
  private readonly maxRepliesPerChunk: number;

  constructor(
    cols: number,
    rows: number,
    maxRepliesPerChunk = DEFAULT_MAX_REPLIES_PER_CHUNK,
  ) {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.scrollBottom = this.rows - 1;
    this.maxRepliesPerChunk = maxRepliesPerChunk;
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.row = Math.min(this.row, this.rows - 1);
    this.col = Math.min(this.col, this.cols - 1);
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.pendingWrap = false;
  }

  push(chunk: string, reply: (data: string) => void): string {
    if (chunk.length === 0) return "";
    const parts: string[] = [];
    let sliceStart = 0;
    let repliesThisChunk = 0;
    let mutated = false;

    const flushSlice = (end: number): void => {
      if (end > sliceStart) {
        parts.push(chunk.slice(sliceStart, end));
      }
      sliceStart = end;
    };

    const emitRaw = (text: string): void => {
      parts.push(text);
    };

    let index = 0;
    while (index < chunk.length) {
      const code = chunk.charCodeAt(index);

      if (this.state === "osc") {
        if (code === 0x07 || code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "osc-esc";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        }
        index += 1;
        continue;
      }

      if (this.state === "osc-esc") {
        if (code === 0x5c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "osc-esc";
        } else if (code === 0x07 || code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else {
          this.state = "osc";
        }
        index += 1;
        continue;
      }

      if (this.state === "string") {
        if (code === 0x9c || code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-esc";
        }
        index += 1;
        continue;
      }

      if (this.state === "string-esc") {
        if (code === 0x5c || code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-esc";
        } else {
          this.state = "string";
        }
        index += 1;
        continue;
      }

      if (this.state === "esc-intermediate") {
        if (code === 0x1b) {
          flushSlice(index);
          mutated = true;
          this.state = "esc";
          this.held = "\u001b";
          sliceStart = index + 1;
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else if (code >= 0x30 && code <= 0x7e) {
          this.state = "ground";
        } else if (code < 0x20 || code > 0x2f) {
          this.state = "ground";
        }
        index += 1;
        continue;
      }

      if (this.state === "esc") {
        if (code === 0x5b) {
          this.state = "csi";
          this.csiParams = "";
          if (this.held.length > 0) {
            this.held = "\u001b[";
            mutated = true;
            sliceStart = index + 1;
          }
          index += 1;
          continue;
        }
        if (code === 0x1b) {
          flushSlice(index);
          if (this.held.length > 0) {
            emitRaw(this.held);
          }
          this.held = "\u001b";
          mutated = true;
          sliceStart = index + 1;
          index += 1;
          continue;
        }
        if (this.held.length > 0) {
          emitRaw(this.held);
          this.held = "";
          mutated = true;
        }
        if (code === 0x5d) {
          this.state = "osc";
        } else if (
          code === 0x50 ||
          code === 0x58 ||
          code === 0x5e ||
          code === 0x5f
        ) {
          this.state = "string";
        } else if (code >= 0x20 && code <= 0x2f) {
          this.state = "esc-intermediate";
        } else {
          this.applyEsc(code);
          this.state = "ground";
        }
        index += 1;
        continue;
      }

      if (this.state === "csi") {
        if (this.held.length > 0) {
          const ch = chunk.charAt(index);
          const candidate = this.held + ch;
          if (candidate === "\u001b[6n" || candidate === "\u001b[?6n") {
            const isPrivate = candidate === "\u001b[?6n";
            this.held = "";
            this.csiParams = "";
            this.state = "ground";
            mutated = true;
            sliceStart = index + 1;
            if (repliesThisChunk < this.maxRepliesPerChunk) {
              repliesThisChunk += 1;
              reply(this.formatReport(isPrivate));
            }
            index += 1;
            continue;
          }
          if (isQueryPrefix(candidate)) {
            this.held = candidate;
            this.csiParams += ch;
            mutated = true;
            sliceStart = index + 1;
            index += 1;
            continue;
          }
          emitRaw(this.held);
          this.held = "";
          mutated = true;
        }

        if (code === 0x1b) {
          flushSlice(index);
          mutated = true;
          this.state = "esc";
          this.csiParams = "";
          this.held = "\u001b";
          sliceStart = index + 1;
        } else if (code === 0x18 || code === 0x1a) {
          this.csiParams = "";
          this.state = "ground";
        } else if (code >= 0x40 && code <= 0x7e) {
          this.applyCsi(this.csiParams, code);
          this.csiParams = "";
          this.state = "ground";
        } else if (code >= 0x20 && code <= 0x3f) {
          if (this.csiParams.length < MAX_CSI_PARAMS_LENGTH) {
            this.csiParams += chunk.charAt(index);
          }
        } else if (code < 0x20) {
          this.applyC0(code);
        }
        index += 1;
        continue;
      }

      if (code === 0x1b) {
        flushSlice(index);
        mutated = true;
        this.state = "esc";
        this.held = "\u001b";
        sliceStart = index + 1;
        index += 1;
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        this.csiParams = "";
        index += 1;
        continue;
      }
      if (code === 0x9d) {
        this.state = "osc";
        index += 1;
        continue;
      }
      if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.state = "string";
        index += 1;
        continue;
      }
      if (code < 0x20) {
        this.applyC0(code);
        index += 1;
        continue;
      }
      if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        index += 1;
        continue;
      }

      const cp = chunk.codePointAt(index) ?? code;
      const step = cp > 0xffff ? 2 : 1;
      this.advancePrintable(codePointWidth(cp));
      index += step;
    }

    if (!mutated) return chunk;
    flushSlice(chunk.length);
    return parts.join("");
  }

  flush(): string {
    const remaining = this.held;
    this.held = "";
    return remaining;
  }

  private formatReport(isPrivate: boolean): string {
    const reportRow = this.originMode
      ? Math.max(
          0,
          Math.min(
            this.scrollBottom - this.scrollTop,
            this.row - this.scrollTop,
          ),
        ) + 1
      : this.row + 1;
    const reportCol = this.col + 1;
    return isPrivate
      ? `\u001b[?${reportRow};${reportCol}R`
      : `\u001b[${reportRow};${reportCol}R`;
  }

  private saveCursor(): void {
    const saved: SavedCursor = {
      row: this.row,
      col: this.col,
      originMode: this.originMode,
      autowrap: this.autowrap,
    };
    if (this.altScreen) this.savedAlt = saved;
    else this.savedMain = saved;
  }

  private restoreCursor(): void {
    const saved = this.altScreen ? this.savedAlt : this.savedMain;
    this.row = Math.min(saved.row, this.rows - 1);
    this.col = Math.min(saved.col, this.cols - 1);
    this.originMode = saved.originMode;
    this.autowrap = saved.autowrap;
    this.pendingWrap = false;
  }

  private homeCursor(): void {
    this.row = this.originMode ? this.scrollTop : 0;
    this.col = 0;
    this.pendingWrap = false;
  }

  private lineFeed(): void {
    if (this.row === this.scrollBottom) {
      return;
    }
    if (this.row < this.rows - 1) {
      this.row += 1;
    }
  }

  private reverseIndex(): void {
    if (this.row === this.scrollTop) {
      return;
    }
    if (this.row > 0) {
      this.row -= 1;
    }
  }

  private applyC0(code: number): void {
    switch (code) {
      case 0x08:
        if (this.pendingWrap) {
          this.pendingWrap = false;
        } else if (this.col > 0) {
          this.col -= 1;
        }
        return;
      case 0x09:
        this.pendingWrap = false;
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.pendingWrap = false;
        this.lineFeed();
        return;
      case 0x0d:
        this.pendingWrap = false;
        this.col = 0;
        return;
    }
  }

  private applyEsc(code: number): void {
    switch (code) {
      case 0x37:
        this.saveCursor();
        return;
      case 0x38:
        this.restoreCursor();
        return;
      case 0x44:
        this.pendingWrap = false;
        this.lineFeed();
        return;
      case 0x45:
        this.pendingWrap = false;
        this.col = 0;
        this.lineFeed();
        return;
      case 0x4d:
        this.pendingWrap = false;
        this.reverseIndex();
        return;
      case 0x63:
        this.row = 0;
        this.col = 0;
        this.pendingWrap = false;
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
        this.originMode = false;
        this.autowrap = true;
        this.altScreen = false;
        this.savedMain = { row: 0, col: 0, originMode: false, autowrap: true };
        this.savedAlt = { row: 0, col: 0, originMode: false, autowrap: true };
        return;
    }
  }

  private applyCsi(rawParams: string, finalByte: number): void {
    if (rawParams.startsWith("?")) {
      if (finalByte !== 0x68 && finalByte !== 0x6c) return;
      const enable = finalByte === 0x68;
      for (const part of rawParams.slice(1).split(";")) {
        const mode = Number.parseInt(part, 10);
        if (mode === 6) {
          this.originMode = enable;
          this.homeCursor();
        } else if (mode === 7) {
          this.autowrap = enable;
        } else if (mode === 47 || mode === 1047) {
          this.altScreen = enable;
          this.pendingWrap = false;
        } else if (mode === 1049) {
          if (enable) {
            if (!this.altScreen) {
              this.saveCursor();
              this.altScreen = true;
              this.row = 0;
              this.col = 0;
              this.pendingWrap = false;
            }
          } else if (this.altScreen) {
            this.altScreen = false;
            this.restoreCursor();
          }
        }
      }
      return;
    }

    if (
      rawParams.length > 0 &&
      (rawParams.charCodeAt(0) < 0x30 || rawParams.charCodeAt(0) > 0x3b)
    ) {
      return;
    }

    const parts = rawParams.length === 0 ? [] : rawParams.split(";");
    const topBound = this.originMode ? this.scrollTop : 0;
    const bottomBound = this.originMode ? this.scrollBottom : this.rows - 1;

    switch (finalByte) {
      case 0x41: {
        const n = parseCsiParam(parts[0], 1);
        const limit = this.row >= this.scrollTop ? this.scrollTop : 0;
        this.row = Math.max(limit, this.row - n);
        this.pendingWrap = false;
        return;
      }
      case 0x42:
      case 0x65: {
        const n = parseCsiParam(parts[0], 1);
        const limit =
          this.row <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
        this.row = Math.min(limit, this.row + n);
        this.pendingWrap = false;
        return;
      }
      case 0x43:
      case 0x61: {
        const n = parseCsiParam(parts[0], 1);
        this.col = Math.min(this.cols - 1, this.col + n);
        this.pendingWrap = false;
        return;
      }
      case 0x44: {
        const n = parseCsiParam(parts[0], 1);
        this.col = Math.max(0, this.col - n);
        this.pendingWrap = false;
        return;
      }
      case 0x45: {
        const n = parseCsiParam(parts[0], 1);
        const limit =
          this.row <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
        this.row = Math.min(limit, this.row + n);
        this.col = 0;
        this.pendingWrap = false;
        return;
      }
      case 0x46: {
        const n = parseCsiParam(parts[0], 1);
        const limit = this.row >= this.scrollTop ? this.scrollTop : 0;
        this.row = Math.max(limit, this.row - n);
        this.col = 0;
        this.pendingWrap = false;
        return;
      }
      case 0x47:
      case 0x60: {
        const col = parseCsiParam(parts[0], 1) - 1;
        this.col = Math.max(0, Math.min(this.cols - 1, col));
        this.pendingWrap = false;
        return;
      }
      case 0x48:
      case 0x66: {
        const targetRow = parseCsiParam(parts[0], 1) - 1;
        const targetCol = parseCsiParam(parts[1], 1) - 1;
        this.row = Math.max(
          topBound,
          Math.min(bottomBound, topBound + targetRow),
        );
        this.col = Math.max(0, Math.min(this.cols - 1, targetCol));
        this.pendingWrap = false;
        return;
      }
      case 0x64: {
        const targetRow = parseCsiParam(parts[0], 1) - 1;
        this.row = Math.max(
          topBound,
          Math.min(bottomBound, topBound + targetRow),
        );
        this.pendingWrap = false;
        return;
      }
      case 0x72: {
        const top = parseCsiParam(parts[0], 1) - 1;
        const bottom = parseCsiParam(parts[1], this.rows) - 1;
        if (top >= 0 && bottom < this.rows && top < bottom) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
        } else {
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        this.homeCursor();
        return;
      }
      case 0x73:
        if (rawParams.length === 0) {
          this.saveCursor();
        }
        return;
      case 0x75:
        if (rawParams.length === 0) {
          this.restoreCursor();
        }
        return;
    }
  }

  private advancePrintable(width: number): void {
    if (width === 0) return;
    if (this.pendingWrap) {
      if (this.autowrap) {
        this.col = 0;
        this.lineFeed();
      }
      this.pendingWrap = false;
    }
    if (this.col + width >= this.cols) {
      if (this.autowrap) {
        if (width === 2 && this.col === this.cols - 1) {
          this.col = 0;
          this.lineFeed();
          this.col = Math.min(this.cols - 1, width);
        } else {
          this.col = this.cols - 1;
          this.pendingWrap = true;
        }
      } else {
        this.col = this.cols - 1;
      }
    } else {
      this.col += width;
    }
  }
}
