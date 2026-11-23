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

type CodePointRange = readonly [number, number];

const UNICODE_V11_BMP_COMBINING: readonly CodePointRange[] = [
  [768, 879], [1155, 1161], [1425, 1469], [1471, 1471], [1473, 1474],
  [1476, 1477], [1479, 1479], [1536, 1541], [1552, 1562], [1564, 1564],
  [1611, 1631], [1648, 1648], [1750, 1757], [1759, 1764], [1767, 1768],
  [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968],
  [2027, 2035], [2045, 2045], [2070, 2073], [2075, 2083], [2085, 2087],
  [2089, 2093], [2137, 2139], [2259, 2306], [2362, 2362], [2364, 2364],
  [2369, 2376], [2381, 2381], [2385, 2391], [2402, 2403], [2433, 2433],
  [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2558, 2558],
  [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637],
  [2641, 2641], [2672, 2673], [2677, 2677], [2689, 2690], [2748, 2748],
  [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2810, 2815],
  [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2884], [2893, 2893],
  [2902, 2902], [2914, 2915], [2946, 2946], [3008, 3008], [3021, 3021],
  [3072, 3072], [3076, 3076], [3134, 3136], [3142, 3144], [3146, 3149],
  [3157, 3158], [3170, 3171], [3201, 3201], [3260, 3260], [3263, 3263],
  [3270, 3270], [3276, 3277], [3298, 3299], [3328, 3329], [3387, 3388],
  [3393, 3396], [3405, 3405], [3426, 3427], [3530, 3530], [3538, 3540],
  [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761],
  [3764, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895],
  [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3981, 3991],
  [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4151], [4153, 4154],
  [4157, 4158], [4184, 4185], [4190, 4192], [4209, 4212], [4226, 4226],
  [4229, 4230], [4237, 4237], [4253, 4253], [4448, 4607], [4957, 4959],
  [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069],
  [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6158],
  [6277, 6278], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450],
  [6457, 6459], [6679, 6680], [6683, 6683], [6742, 6742], [6744, 6750],
  [6752, 6752], [6754, 6754], [6757, 6764], [6771, 6780], [6783, 6783],
  [6832, 6846], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972],
  [6978, 6978], [7019, 7027], [7040, 7041], [7074, 7077], [7080, 7081],
  [7083, 7085], [7142, 7142], [7144, 7145], [7149, 7149], [7151, 7153],
  [7212, 7219], [7222, 7223], [7376, 7378], [7380, 7392], [7394, 7400],
  [7405, 7405], [7412, 7412], [7416, 7417], [7616, 7673], [7675, 7679],
  [8203, 8207], [8234, 8238], [8288, 8292], [8294, 8303], [8400, 8432],
  [11503, 11505], [11647, 11647], [11744, 11775], [12330, 12333],
  [12441, 12442], [42607, 42610], [42612, 42621], [42654, 42655],
  [42736, 42737], [43010, 43010], [43014, 43014], [43019, 43019],
  [43045, 43046], [43204, 43205], [43232, 43249], [43263, 43263],
  [43302, 43309], [43335, 43345], [43392, 43394], [43443, 43443],
  [43446, 43449], [43452, 43453], [43493, 43493], [43561, 43566],
  [43569, 43570], [43573, 43574], [43587, 43587], [43596, 43596],
  [43644, 43644], [43696, 43696], [43698, 43700], [43703, 43704],
  [43710, 43711], [43713, 43713], [43756, 43757], [43766, 43766],
  [44005, 44005], [44008, 44008], [44013, 44013], [64286, 64286],
  [65024, 65039], [65056, 65071], [65279, 65279], [65529, 65531],
];

const UNICODE_V11_NON_BMP_COMBINING: readonly CodePointRange[] = [
  [66045, 66045], [66272, 66272], [66422, 66426], [68097, 68099],
  [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159],
  [68325, 68326], [68900, 68903], [69446, 69456], [69633, 69633],
  [69688, 69702], [69759, 69761], [69811, 69814], [69817, 69818],
  [69821, 69821], [69837, 69837], [69888, 69890], [69927, 69931],
  [69933, 69940], [70003, 70003], [70016, 70017], [70070, 70078],
  [70089, 70092], [70191, 70193], [70196, 70196], [70198, 70199],
  [70206, 70206], [70367, 70367], [70371, 70378], [70400, 70401],
  [70459, 70460], [70464, 70464], [70502, 70508], [70512, 70516],
  [70712, 70719], [70722, 70724], [70726, 70726], [70750, 70750],
  [70835, 70840], [70842, 70842], [70847, 70848], [70850, 70851],
  [71090, 71093], [71100, 71101], [71103, 71104], [71132, 71133],
  [71219, 71226], [71229, 71229], [71231, 71232], [71339, 71339],
  [71341, 71341], [71344, 71349], [71351, 71351], [71453, 71455],
  [71458, 71461], [71463, 71467], [71727, 71735], [71737, 71738],
  [72148, 72151], [72154, 72155], [72160, 72160], [72193, 72202],
  [72243, 72248], [72251, 72254], [72263, 72263], [72273, 72278],
  [72281, 72283], [72330, 72342], [72344, 72345], [72752, 72758],
  [72760, 72765], [72767, 72767], [72850, 72871], [72874, 72880],
  [72882, 72883], [72885, 72886], [73009, 73014], [73018, 73018],
  [73020, 73021], [73023, 73029], [73031, 73031], [73104, 73105],
  [73109, 73109], [73111, 73111], [73459, 73460], [78896, 78904],
  [92912, 92916], [92976, 92982], [94031, 94031], [94095, 94098],
  [113821, 113822], [113824, 113827], [119143, 119145], [119155, 119170],
  [119173, 119179], [119210, 119213], [119362, 119364], [121344, 121398],
  [121403, 121452], [121461, 121461], [121476, 121476], [121499, 121503],
  [121505, 121519], [122880, 122886], [122888, 122904], [122907, 122913],
  [122915, 122916], [122918, 122922], [123184, 123190], [123628, 123631],
  [125136, 125142], [125252, 125258], [917505, 917505], [917536, 917631],
  [917760, 917999],
];

const UNICODE_V11_BMP_WIDE: readonly CodePointRange[] = [
  [4352, 4447], [8986, 8987], [9001, 9002], [9193, 9196], [9200, 9200],
  [9203, 9203], [9725, 9726], [9748, 9749], [9800, 9811], [9855, 9855],
  [9875, 9875], [9889, 9889], [9898, 9899], [9917, 9918], [9924, 9925],
  [9934, 9934], [9940, 9940], [9962, 9962], [9970, 9971], [9973, 9973],
  [9978, 9978], [9981, 9981], [9989, 9989], [9994, 9995], [10024, 10024],
  [10060, 10060], [10062, 10062], [10067, 10069], [10071, 10071],
  [10133, 10135], [10160, 10160], [10175, 10175], [11035, 11036],
  [11088, 11088], [11093, 11093], [11904, 11929], [11931, 12019],
  [12032, 12245], [12272, 12283], [12288, 12329], [12334, 12350],
  [12353, 12438], [12443, 12543], [12549, 12591], [12593, 12686],
  [12688, 12730], [12736, 12771], [12784, 12830], [12832, 12871],
  [12880, 19903], [19968, 42124], [42128, 42182], [43360, 43388],
  [44032, 55203], [63744, 64255], [65040, 65049], [65072, 65106],
  [65108, 65126], [65128, 65131], [65281, 65376], [65504, 65510],
];

const UNICODE_V11_NON_BMP_WIDE: readonly CodePointRange[] = [
  [94176, 94179], [94208, 100343], [100352, 101106], [110592, 110878],
  [110928, 110930], [110948, 110951], [110960, 111355], [126980, 126980],
  [127183, 127183], [127374, 127374], [127377, 127386], [127488, 127490],
  [127504, 127547], [127552, 127560], [127568, 127569], [127584, 127589],
  [127744, 127776], [127789, 127797], [127799, 127868], [127870, 127891],
  [127904, 127946], [127951, 127955], [127968, 127984], [127988, 127988],
  [127992, 128062], [128064, 128064], [128066, 128252], [128255, 128317],
  [128331, 128334], [128336, 128359], [128378, 128378], [128405, 128406],
  [128420, 128420], [128507, 128591], [128640, 128709], [128716, 128716],
  [128720, 128722], [128725, 128725], [128747, 128748], [128756, 128762],
  [128992, 129003], [129293, 129393], [129395, 129398], [129402, 129442],
  [129445, 129450], [129454, 129482], [129485, 129535], [129648, 129651],
  [129656, 129658], [129664, 129666], [129680, 129685], [131072, 196605],
  [196608, 262141],
];

let bmpWidthTable: Uint8Array | undefined;

function getBmpWidthTable(): Uint8Array {
  if (bmpWidthTable === undefined) {
    const table = new Uint8Array(65536);
    table.fill(1);
    table.fill(0, 0, 32);
    table.fill(0, 127, 160);
    for (const [start, end] of UNICODE_V11_BMP_COMBINING) {
      table.fill(0, start, end + 1);
    }
    for (const [start, end] of UNICODE_V11_BMP_WIDE) {
      table.fill(2, start, end + 1);
    }
    bmpWidthTable = table;
  }
  return bmpWidthTable;
}

function inRanges(
  cp: number,
  ranges: readonly CodePointRange[],
): boolean {
  let low = 0;
  let high = ranges.length - 1;
  if (cp < ranges[0]![0] || cp > ranges[high]![1]) return false;
  while (high >= low) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (cp > range[1]) low = mid + 1;
    else if (cp < range[0]) high = mid - 1;
    else return true;
  }
  return false;
}

export function unicodeV11CellWidth(cp: number): number {
  if (cp < 32) return 0;
  if (cp < 127) return 1;
  if (cp < 65536) return getBmpWidthTable()[cp] ?? 1;
  if (inRanges(cp, UNICODE_V11_NON_BMP_COMBINING)) return 0;
  if (inRanges(cp, UNICODE_V11_NON_BMP_WIDE)) return 2;
  return 1;
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

      if (code >= 0x20 && code < 0x7f) {
        const runStart = index;
        index += 1;
        while (index < chunk.length) {
          const next = chunk.charCodeAt(index);
          if (next < 0x20 || next >= 0x7f) break;
          index += 1;
        }
        this.advanceAsciiRun(index - runStart);
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
      this.advancePrintable(unicodeV11CellWidth(cp));
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
    const reportRow = this.row + 1;
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

  private lineFeed(count = 1): void {
    if (count <= 0) return;
    if (this.row <= this.scrollBottom) {
      this.row = Math.min(this.scrollBottom, this.row + count);
      return;
    }
    this.row = Math.min(this.rows - 1, this.row + count);
  }

  private advanceAsciiRun(count: number): void {
    if (count <= 0) return;
    if (!this.autowrap) {
      this.pendingWrap = false;
      this.col = Math.min(this.cols - 1, this.col + count);
      return;
    }
    if (this.pendingWrap) {
      this.col = 0;
      this.lineFeed(1);
      this.pendingWrap = false;
    }
    const remaining = this.cols - this.col;
    if (count < remaining) {
      this.col += count;
      return;
    }
    const rest = count - remaining;
    if (rest === 0) {
      this.col = this.cols - 1;
      this.pendingWrap = true;
      return;
    }
    const wraps = Math.ceil(rest / this.cols);
    this.lineFeed(wraps);
    const rem = rest % this.cols;
    if (rem === 0) {
      this.col = this.cols - 1;
      this.pendingWrap = true;
    } else {
      this.col = rem;
      this.pendingWrap = false;
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
          if (width >= this.cols) {
            this.col = this.cols - 1;
            this.pendingWrap = true;
          } else {
            this.col = width;
          }
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
