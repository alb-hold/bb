const MAX_CSI_PARAMS = 32;
const MAX_CSI_PARAM_VALUE = 0x7fffffff;
const MIN_GUARANTEED_SCROLLBACK = 200;

type ParserState =
  | "ground"
  | "esc"
  | "esc-intermediate"
  | "csi-entry"
  | "csi-param"
  | "csi-intermediate"
  | "csi-ignore"
  | "osc"
  | "dcs-entry"
  | "dcs-param"
  | "dcs-intermediate"
  | "dcs-passthrough"
  | "dcs-ignore"
  | "sos-pm"
  | "apc";

interface BufferCursorState {
  x: number;
  y: number;
  ybase: number;
  ybaseKnown: boolean;
  scrollsSinceReset: number;
  hasWrappedLine: boolean;
  maxPrintedCol: number;
  linesLength: number;
  scrollTop: number;
  scrollBottom: number;
  tabs: Set<number>;
  tabsKnown: boolean;
  rowKnown: boolean;
  colKnown: boolean;
  savedX: number;
  savedY: number;
  savedOriginMode: boolean;
  savedAutowrap: boolean;
  savedRowKnown: boolean;
  savedColKnown: boolean;
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

function collectByte(current: number, byte: number): number {
  if (current > 0xffff) return 0x1000000;
  return (current << 8) | byte;
}

function createDefaultTabs(cols: number): Set<number> {
  const tabs = new Set<number>();
  for (let i = 0; i < cols; i += 8) {
    tabs.add(i);
  }
  return tabs;
}

function prevTabStop(tabs: Set<number>, cols: number, startX: number): number {
  let x = startX - 1;
  while (!tabs.has(x) && x > 0) {
    x -= 1;
  }
  return x >= cols ? cols - 1 : x < 0 ? 0 : x;
}

function nextTabStop(tabs: Set<number>, cols: number, startX: number): number {
  let x = startX + 1;
  while (!tabs.has(x) && x < cols) {
    x += 1;
  }
  return x >= cols ? cols - 1 : x < 0 ? 0 : x;
}

function extendTabStops(tabs: Set<number>, cols: number, fromIndex: number): void {
  let i = fromIndex;
  if (!tabs.has(i)) {
    i = prevTabStop(tabs, cols, i);
  }
  for (; i < cols; i += 8) {
    tabs.add(i);
  }
}

function createBufferCursorState(
  cols: number,
  rows: number,
  initialLinesLength: number,
): BufferCursorState {
  return {
    x: 0,
    y: 0,
    ybase: 0,
    ybaseKnown: true,
    scrollsSinceReset: 0,
    hasWrappedLine: false,
    maxPrintedCol: 0,
    linesLength: initialLinesLength,
    scrollTop: 0,
    scrollBottom: rows - 1,
    tabs: createDefaultTabs(cols),
    tabsKnown: true,
    rowKnown: true,
    colKnown: true,
    savedX: 0,
    savedY: 0,
    savedOriginMode: false,
    savedAutowrap: true,
    savedRowKnown: true,
    savedColKnown: true,
  };
}

export class TerminalCursorPositionQueries {
  private cols: number;
  private rows: number;
  private normal: BufferCursorState;
  private alt: BufferCursorState;
  private altScreen = false;
  private originMode = false;
  private autowrap = true;
  private reverseWraparound = false;
  private insertMode = false;
  private convertEol = false;
  private precedingWidth = 0;
  private highSurrogate = 0;
  private state: ParserState = "ground";
  private escCollect = 0;
  private csiCollect = 0;
  private readonly csiParams = new Int32Array(MAX_CSI_PARAMS);
  private csiParamCount = 1;
  private csiDigitIsSub = false;
  private csiRejectDigits = false;
  private held = "";

  constructor(cols: number, rows: number) {
    this.cols = Math.max(2, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.normal = createBufferCursorState(this.cols, this.rows, this.rows);
    this.alt = createBufferCursorState(this.cols, this.rows, 0);
  }

  private active(): BufferCursorState {
    return this.altScreen ? this.alt : this.normal;
  }

  private isPositionKnown(): boolean {
    const buf = this.active();
    return buf.rowKnown && buf.colKnown;
  }

  resize(cols: number, rows: number): void {
    if (Number.isNaN(cols) || Number.isNaN(rows)) return;
    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(1, Math.floor(rows));
    const prevCols = this.cols;
    const prevRows = this.rows;

    this.resizeNormalBuffer(prevCols, prevRows, nextCols, nextRows);
    this.resizeAltBuffer(nextCols, nextRows);

    this.cols = nextCols;
    this.rows = nextRows;

    if (this.normal.tabsKnown) {
      extendTabStops(this.normal.tabs, nextCols, nextCols);
    }
    if (this.alt.tabsKnown) {
      extendTabStops(this.alt.tabs, nextCols, nextCols);
    }
  }

  private resizeNormalBuffer(
    prevCols: number,
    prevRows: number,
    nextCols: number,
    nextRows: number,
  ): void {
    const buf = this.normal;
    const mayReflow =
      (nextCols > prevCols && buf.hasWrappedLine) ||
      (nextCols < prevCols &&
        (buf.hasWrappedLine || buf.maxPrintedCol > nextCols));
    if (!mayReflow && buf.ybaseKnown && buf.rowKnown && buf.colKnown) {
      let addToY = 0;
      if (prevRows < nextRows) {
        for (let y = prevRows; y < nextRows; y += 1) {
          if (buf.linesLength < nextRows + buf.ybase) {
            if (buf.ybase > 0 && buf.linesLength <= buf.ybase + buf.y + addToY + 1) {
              buf.ybase -= 1;
              addToY += 1;
            } else {
              buf.linesLength += 1;
            }
          }
        }
      } else {
        for (let y = prevRows; y > nextRows; y -= 1) {
          if (buf.linesLength > nextRows + buf.ybase) {
            if (buf.linesLength > buf.ybase + buf.y + 1) {
              buf.linesLength -= 1;
            } else {
              buf.ybase += 1;
            }
          }
        }
      }
      const newMaxLength = nextRows + MIN_GUARANTEED_SCROLLBACK;
      if (buf.linesLength > newMaxLength) {
        const trim = buf.linesLength - newMaxLength;
        buf.linesLength -= trim;
        buf.ybase = Math.max(buf.ybase - trim, 0);
        buf.savedY = Math.max(buf.savedY - trim, 0);
      }
      buf.x = Math.min(buf.x, nextCols - 1);
      buf.y = Math.min(buf.y, nextRows - 1) + addToY;
      buf.savedX = Math.min(buf.savedX, nextCols - 1);
      buf.scrollTop = 0;
      buf.scrollBottom = nextRows - 1;
      buf.maxPrintedCol = Math.min(buf.maxPrintedCol, nextCols);
      const maxY = Math.max(0, buf.linesLength - buf.ybase - 1);
      buf.y = Math.min(buf.y, maxY);
      return;
    }

    buf.scrollTop = 0;
    buf.scrollBottom = nextRows - 1;
    buf.savedX = Math.min(buf.savedX, nextCols - 1);
    if (nextCols !== prevCols) {
      buf.hasWrappedLine = true;
      buf.maxPrintedCol = nextCols;
    }
    if (nextCols === prevCols && nextRows === prevRows) {
      if (buf.colKnown) buf.x = Math.min(buf.x, nextCols - 1);
      if (buf.rowKnown) buf.y = Math.min(buf.y, nextRows - 1);
      return;
    }

    buf.rowKnown = false;
    buf.colKnown = false;
    buf.ybaseKnown = false;
    buf.savedRowKnown = false;
    buf.savedColKnown = false;
  }

  private resizeAltBuffer(nextCols: number, nextRows: number): void {
    const buf = this.alt;
    if (buf.linesLength > 0) {
      if (buf.colKnown) {
        buf.x = Math.min(buf.x, nextCols - 1);
      }
      if (buf.rowKnown) {
        buf.y = Math.min(buf.y, nextRows - 1);
      } else if (nextRows === 1) {
        buf.y = 0;
        buf.rowKnown = true;
      }
      buf.savedX = Math.min(buf.savedX, nextCols - 1);
      buf.scrollTop = 0;
      buf.linesLength = nextRows;
    }
    buf.scrollBottom = nextRows - 1;
  }

  private resetCsi(): void {
    this.csiCollect = 0;
    this.csiParams[0] = 0;
    this.csiParamCount = 1;
    this.csiDigitIsSub = false;
    this.csiRejectDigits = false;
  }

  private addCsiParam(): void {
    this.csiDigitIsSub = false;
    if (this.csiParamCount >= MAX_CSI_PARAMS) {
      this.csiRejectDigits = true;
      return;
    }
    this.csiParams[this.csiParamCount] = 0;
    this.csiParamCount += 1;
  }

  private addCsiDigit(digit: number): void {
    if (this.csiDigitIsSub || this.csiRejectDigits) return;
    const idx = this.csiParamCount - 1;
    const next = this.csiParams[idx]! * 10 + digit;
    this.csiParams[idx] = next > MAX_CSI_PARAM_VALUE ? MAX_CSI_PARAM_VALUE : next;
  }

  push(chunk: string, reply: (data: string) => void): string {
    if (chunk.length === 0) return "";
    const parts: string[] = [];
    let sliceStart = 0;
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
    if (this.highSurrogate !== 0) {
      const prevHigh = this.highSurrogate;
      this.highSurrogate = 0;
      const first = chunk.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) {
        const combined = ((prevHigh - 0xd800) << 10) + (first - 0xdc00) + 0x10000;
        this.processNonAsciiCodePoint(combined);
        index = 1;
      } else {
        this.processNonAsciiCodePoint(prevHigh);
      }
    }

    while (index < chunk.length) {
      const code = chunk.charCodeAt(index);

      if (code === 0xfeff) {
        if (this.held.length > 0) {
          emitRaw(this.held);
          this.held = "";
          mutated = true;
        }
        index += 1;
        continue;
      }

      if (this.held.length > 0) {
        if (this.state === "esc" && code === 0x5b) {
          this.held = "\u001b[";
          this.state = "csi-entry";
          this.resetCsi();
          mutated = true;
          sliceStart = index + 1;
          index += 1;
          continue;
        }
        if (this.state === "csi-entry" && this.held === "\u001b[" && code === 0x3f) {
          this.held = "\u001b[?";
          this.csiCollect = 0x3f;
          this.state = "csi-param";
          mutated = true;
          sliceStart = index + 1;
          index += 1;
          continue;
        }
        if (
          (this.state === "csi-entry" || this.state === "csi-param") &&
          (this.held === "\u001b[" || this.held === "\u001b[?") &&
          code === 0x36
        ) {
          this.held += "6";
          this.addCsiDigit(6);
          this.state = "csi-param";
          mutated = true;
          sliceStart = index + 1;
          index += 1;
          continue;
        }
        if (
          this.state === "csi-param" &&
          (this.held === "\u001b[6" || this.held === "\u001b[?6") &&
          code === 0x6e
        ) {
          const fullQuery = `${this.held}n`;
          const isPrivate = this.held === "\u001b[?6";
          this.held = "";
          this.state = "ground";
          this.precedingWidth = 0;
          mutated = true;
          sliceStart = index + 1;
          if (this.isPositionKnown()) {
            reply(this.formatReport(isPrivate));
          } else {
            emitRaw(fullQuery);
          }
          index += 1;
          continue;
        }
        if (code === 0x1b) {
          flushSlice(index);
          emitRaw(this.held);
          this.held = "\u001b";
          this.state = "esc";
          this.escCollect = 0;
          if (this.isPayloadState()) {
            this.precedingWidth = 0;
          }
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
        if (this.isPayloadState()) {
          this.precedingWidth = 0;
        }
        this.held = "\u001b";
        this.state = "esc";
        this.escCollect = 0;
        mutated = true;
        sliceStart = index + 1;
        index += 1;
        continue;
      }

      if (code >= 0x80 && code <= 0x9f) {
        this.handleC1(code);
        index += 1;
        continue;
      }

      if (code === 0x18 || code === 0x1a) {
        this.precedingWidth = 0;
        this.state = "ground";
        index += 1;
        continue;
      }

      if (this.state === "ground") {
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
        if (code < 0x20) {
          this.applyExecute(code);
          index += 1;
          continue;
        }
        if (code === 0x7f) {
          index += 1;
          continue;
        }
        if (code >= 0xd800 && code <= 0xdbff) {
          if (index + 1 >= chunk.length) {
            this.highSurrogate = code;
            index += 1;
            continue;
          }
          const low = chunk.charCodeAt(index + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            const cp = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
            this.printCodePoint(cp);
            index += 2;
            continue;
          }
        }
        this.printCodePoint(code);
        index += 1;
        continue;
      }

      if (this.state === "osc") {
        if (code === 0x07) {
          this.precedingWidth = 0;
          this.state = "ground";
        } else if (code >= 0xd800 && code <= 0xdbff && index + 1 >= chunk.length) {
          this.highSurrogate = code;
        }
        index += 1;
        continue;
      }

      if (
        this.state === "sos-pm" ||
        this.state === "apc" ||
        this.state === "dcs-passthrough" ||
        this.state === "dcs-ignore"
      ) {
        if (code >= 0xd800 && code <= 0xdbff && index + 1 >= chunk.length) {
          this.highSurrogate = code;
        }
        index += 1;
        continue;
      }

      if (
        this.state === "dcs-entry" ||
        this.state === "dcs-param" ||
        this.state === "dcs-intermediate"
      ) {
        this.stepDcsHeader(code);
        index += 1;
        continue;
      }

      if (this.state === "esc") {
        if (code < 0x20) {
          this.applyExecute(code);
        } else if (code >= 0x20 && code <= 0x2f) {
          this.escCollect = collectByte(this.escCollect, code);
          this.state = "esc-intermediate";
        } else if (code === 0x5b) {
          this.resetCsi();
          this.state = "csi-entry";
        } else if (code === 0x5d) {
          this.state = "osc";
        } else if (code === 0x50) {
          this.state = "dcs-entry";
        } else if (code === 0x58 || code === 0x5e) {
          this.state = "sos-pm";
        } else if (code === 0x5f) {
          this.state = "apc";
        } else if (code >= 0x30 && code <= 0x7e) {
          this.applyEsc(0, code);
          this.precedingWidth = 0;
          this.state = "ground";
        } else if (code !== 0x7f) {
          this.state = "ground";
        }
        index += 1;
        continue;
      }

      if (this.state === "esc-intermediate") {
        if (code < 0x20) {
          this.applyExecute(code);
        } else if (code >= 0x20 && code <= 0x2f) {
          this.escCollect = collectByte(this.escCollect, code);
        } else if (code >= 0x30 && code <= 0x7e) {
          this.applyEsc(this.escCollect, code);
          this.precedingWidth = 0;
          this.state = "ground";
        } else if (code !== 0x7f) {
          this.state = "ground";
        }
        index += 1;
        continue;
      }

      this.stepCsi(code);
      index += 1;
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

  private isPayloadState(): boolean {
    return (
      this.state === "osc" ||
      this.state === "dcs-passthrough" ||
      this.state === "apc"
    );
  }

  private processNonAsciiCodePoint(cp: number): void {
    if (cp === 0xfeff) return;
    if (cp >= 0x80 && cp <= 0x9f) {
      this.handleC1(cp);
      return;
    }
    if (this.state === "ground") {
      this.printCodePoint(cp);
      return;
    }
    if (
      this.state === "osc" ||
      this.state === "csi-ignore" ||
      this.state === "dcs-ignore" ||
      this.state === "dcs-passthrough" ||
      this.state === "apc"
    ) {
      return;
    }
    this.state = "ground";
  }

  private handleC1(code: number): void {
    if (this.isPayloadState()) {
      this.precedingWidth = 0;
    }
    switch (code) {
      case 0x90:
        this.state = "dcs-entry";
        return;
      case 0x98:
      case 0x9e:
        this.state = "sos-pm";
        return;
      case 0x9b:
        this.resetCsi();
        this.state = "csi-entry";
        return;
      case 0x9c:
        this.state = "ground";
        return;
      case 0x9d:
        this.state = "osc";
        return;
      case 0x9f:
        this.state = "apc";
        return;
      default:
        this.applyExecute(code);
        this.state = "ground";
        return;
    }
  }

  private stepDcsHeader(code: number): void {
    if (code < 0x20 || code === 0x7f) {
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.state = "dcs-passthrough";
      return;
    }
    if (this.state === "dcs-entry") {
      if (code >= 0x20 && code <= 0x2f) {
        this.state = "dcs-intermediate";
      } else if (code >= 0x30 && code <= 0x3f) {
        this.state = "dcs-param";
      } else {
        this.state = "ground";
      }
      return;
    }
    if (this.state === "dcs-param") {
      if (code >= 0x20 && code <= 0x2f) {
        this.state = "dcs-intermediate";
      } else if (code >= 0x3c && code <= 0x3f) {
        this.state = "dcs-ignore";
      } else if (code > 0x7f) {
        this.state = "ground";
      }
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.state = "dcs-ignore";
    } else if (code > 0x7f) {
      this.state = "ground";
    }
  }

  private stepCsi(code: number): void {
    if (code < 0x20) {
      this.applyExecute(code);
      return;
    }
    if (code === 0x7f) {
      return;
    }
    if (this.state === "csi-ignore") {
      if (code >= 0x40 && code <= 0x7e) {
        this.state = "ground";
      }
      return;
    }
    if (this.state === "csi-entry") {
      if (code >= 0x40 && code <= 0x7e) {
        this.applyCsi(code);
        this.precedingWidth = 0;
        this.state = "ground";
      } else if (code >= 0x30 && code <= 0x39) {
        this.addCsiDigit(code - 0x30);
        this.state = "csi-param";
      } else if (code === 0x3b) {
        this.addCsiParam();
        this.state = "csi-param";
      } else if (code === 0x3a) {
        this.csiDigitIsSub = true;
        this.state = "csi-param";
      } else if (code >= 0x3c && code <= 0x3f) {
        this.csiCollect = collectByte(this.csiCollect, code);
        this.state = "csi-param";
      } else if (code >= 0x20 && code <= 0x2f) {
        this.csiCollect = collectByte(this.csiCollect, code);
        this.state = "csi-intermediate";
      } else {
        this.state = "ground";
      }
      return;
    }
    if (this.state === "csi-param") {
      if (code >= 0x40 && code <= 0x7e) {
        this.applyCsi(code);
        this.precedingWidth = 0;
        this.state = "ground";
      } else if (code >= 0x30 && code <= 0x39) {
        this.addCsiDigit(code - 0x30);
      } else if (code === 0x3b) {
        this.addCsiParam();
      } else if (code === 0x3a) {
        this.csiDigitIsSub = true;
      } else if (code >= 0x20 && code <= 0x2f) {
        this.csiCollect = collectByte(this.csiCollect, code);
        this.state = "csi-intermediate";
      } else if (code >= 0x3c && code <= 0x3f) {
        this.state = "csi-ignore";
      } else {
        this.state = "ground";
      }
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.applyCsi(code);
      this.precedingWidth = 0;
      this.state = "ground";
    } else if (code >= 0x20 && code <= 0x2f) {
      this.csiCollect = collectByte(this.csiCollect, code);
    } else if (code >= 0x30 && code <= 0x3f) {
      this.state = "csi-ignore";
    } else {
      this.state = "ground";
    }
  }

  private formatReport(isPrivate: boolean): string {
    const buf = this.active();
    const reportRow = buf.y + 1;
    const reportCol = buf.x + 1;
    return isPrivate
      ? `\u001b[?${reportRow};${reportCol}R`
      : `\u001b[${reportRow};${reportCol}R`;
  }

  private restrictCursor(maxCol = this.cols - 1): void {
    const buf = this.active();
    if (buf.colKnown) {
      buf.x = Math.min(maxCol, Math.max(0, buf.x));
    }
    const minRow = this.originMode ? buf.scrollTop : 0;
    const maxRow = this.originMode ? buf.scrollBottom : this.rows - 1;
    if (buf.rowKnown) {
      buf.y = Math.min(maxRow, Math.max(minRow, buf.y));
    } else if (minRow === maxRow) {
      buf.y = minRow;
      buf.rowKnown = true;
    }
  }

  private setViewportCursor(
    x: number,
    viewportRow: number,
    setsCol: boolean,
    setsRow: boolean,
  ): void {
    const buf = this.active();
    if (setsCol || buf.colKnown) {
      buf.x = x;
      if (setsCol) buf.colKnown = true;
    }
    if (setsRow || buf.rowKnown) {
      buf.y = viewportRow;
      if (setsRow) buf.rowKnown = true;
    }
    this.restrictCursor();
  }

  private applyXtermOriginSetCursor(
    x: number,
    rowArgBeforeXtermOriginOffset: number,
    setsCol: boolean,
    setsRow: boolean,
  ): void {
    const buf = this.active();
    const viewportRow = this.originMode
      ? buf.scrollTop + rowArgBeforeXtermOriginOffset
      : rowArgBeforeXtermOriginOffset;
    this.setViewportCursor(x, viewportRow, setsCol, setsRow);
  }

  private applyXtermOriginMoveCursor(dx: number, dy: number): void {
    this.restrictCursor();
    const buf = this.active();
    this.applyXtermOriginSetCursor(buf.x + dx, buf.y + dy, false, false);
  }

  private recordNormalScrolls(count: number): void {
    if (count <= 0) return;
    const buf = this.normal;
    if (buf.scrollTop !== 0) return;
    if (!buf.ybaseKnown) return;
    buf.scrollsSinceReset += count;
    if (buf.scrollsSinceReset > MIN_GUARANTEED_SCROLLBACK) {
      buf.ybaseKnown = false;
      return;
    }
    buf.ybase += count;
    buf.linesLength = this.rows + buf.ybase;
  }

  private advanceRowsDown(count: number): void {
    if (count <= 0) return;
    const buf = this.active();
    if (!buf.rowKnown) {
      if (!this.altScreen && buf.scrollTop === 0) {
        this.normal.ybaseKnown = false;
      }
      return;
    }
    if (buf.y <= buf.scrollBottom) {
      const dist = buf.scrollBottom - buf.y;
      if (count <= dist) {
        buf.y += count;
      } else {
        buf.y = buf.scrollBottom;
        if (!this.altScreen) {
          this.recordNormalScrolls(count - dist);
        }
      }
      return;
    }
    buf.y = Math.min(this.rows - 1, buf.y + count);
  }

  private saveCursor(): void {
    const buf = this.active();
    buf.savedX = buf.x;
    buf.savedColKnown = buf.colKnown;
    if (this.altScreen) {
      buf.savedY = buf.y;
      buf.savedRowKnown = buf.rowKnown;
    } else if (buf.rowKnown && buf.ybaseKnown) {
      buf.savedY = buf.ybase + buf.y;
      buf.savedRowKnown = true;
    } else {
      buf.savedRowKnown = false;
    }
    buf.savedOriginMode = this.originMode;
    buf.savedAutowrap = this.autowrap;
  }

  private restoreCursor(): void {
    const buf = this.active();
    this.originMode = buf.savedOriginMode;
    this.autowrap = buf.savedAutowrap;
    buf.x = buf.savedX || 0;
    buf.colKnown = buf.savedColKnown;
    if (this.altScreen) {
      buf.y = Math.max(buf.savedY, 0);
      buf.rowKnown = buf.savedRowKnown;
    } else if (buf.savedRowKnown && buf.ybaseKnown) {
      buf.y = Math.max(buf.savedY - buf.ybase, 0);
      buf.rowKnown = true;
    } else {
      buf.rowKnown = false;
    }
    this.restrictCursor();
  }

  private activateAltBuffer(): void {
    if (this.altScreen) return;
    if (this.alt.linesLength === 0) {
      this.alt.linesLength = this.rows;
    }
    this.alt.x = this.normal.x;
    this.alt.y = this.normal.y;
    this.alt.colKnown = this.normal.colKnown;
    this.alt.rowKnown = this.normal.rowKnown;
    this.altScreen = true;
  }

  private activateNormalBuffer(): void {
    if (!this.altScreen) return;
    this.normal.x = this.alt.x;
    this.normal.y = this.alt.y;
    this.normal.colKnown = this.alt.colKnown;
    this.normal.rowKnown = this.alt.rowKnown;
    this.alt.x = 0;
    this.alt.y = 0;
    this.alt.linesLength = 0;
    this.alt.scrollTop = 0;
    this.alt.scrollBottom = this.rows - 1;
    this.alt.tabs = createDefaultTabs(this.cols);
    this.alt.tabsKnown = true;
    this.alt.rowKnown = true;
    this.alt.colKnown = true;
    this.altScreen = false;
  }

  private fullReset(): void {
    this.normal = createBufferCursorState(this.cols, this.rows, this.rows);
    this.alt = createBufferCursorState(this.cols, this.rows, 0);
    this.altScreen = false;
    this.originMode = false;
    this.autowrap = true;
    this.reverseWraparound = false;
    this.insertMode = false;
    this.precedingWidth = 0;
  }

  private softReset(): void {
    const buf = this.active();
    buf.scrollTop = 0;
    buf.scrollBottom = this.rows - 1;
    this.originMode = false;
    this.autowrap = true;
    this.reverseWraparound = false;
    this.insertMode = false;
    buf.savedX = 0;
    buf.savedColKnown = true;
    if (this.altScreen) {
      buf.savedY = 0;
      buf.savedRowKnown = true;
    } else if (buf.ybaseKnown) {
      buf.savedY = buf.ybase;
      buf.savedRowKnown = true;
    } else {
      buf.savedRowKnown = false;
    }
    buf.savedOriginMode = false;
    buf.savedAutowrap = true;
  }

  private lineFeed(): void {
    const buf = this.active();
    if (this.convertEol) {
      buf.x = 0;
      buf.colKnown = true;
    }
    this.advanceRowsDown(1);
    if (buf.colKnown && buf.x >= this.cols) {
      buf.x -= 1;
    }
  }

  private index(): void {
    this.restrictCursor();
    this.advanceRowsDown(1);
    this.restrictCursor();
  }

  private nextLine(): void {
    const buf = this.active();
    buf.x = 0;
    buf.colKnown = true;
    this.index();
  }

  private reverseIndex(): void {
    this.restrictCursor();
    const buf = this.active();
    if (!buf.rowKnown) return;
    if (buf.y !== buf.scrollTop) {
      buf.y -= 1;
      this.restrictCursor();
    }
  }

  private tabSet(): void {
    const buf = this.active();
    if (buf.colKnown) {
      buf.tabs.add(buf.x);
    } else {
      buf.tabsKnown = false;
    }
  }

  private forwardTab(count: number): void {
    const buf = this.active();
    if (!buf.colKnown) return;
    if (buf.x >= this.cols) return;
    if (!buf.tabsKnown) {
      buf.colKnown = false;
      return;
    }
    const steps = Math.min(count, this.cols);
    for (let i = 0; i < steps; i += 1) {
      buf.x = nextTabStop(buf.tabs, this.cols, buf.x);
    }
  }

  private backwardTab(count: number): void {
    const buf = this.active();
    if (!buf.colKnown) return;
    if (buf.x >= this.cols) return;
    if (!buf.tabsKnown) {
      buf.colKnown = false;
      return;
    }
    const steps = Math.min(count, this.cols);
    for (let i = 0; i < steps; i += 1) {
      buf.x = prevTabStop(buf.tabs, this.cols, buf.x);
    }
  }

  private backspace(): void {
    const buf = this.active();
    if (!this.reverseWraparound) {
      this.restrictCursor();
      if (buf.colKnown && buf.x > 0) {
        buf.x -= 1;
      }
      return;
    }
    this.restrictCursor(this.cols);
    if (!buf.colKnown) {
      buf.rowKnown = false;
      return;
    }
    if (buf.x > 0) {
      buf.x -= 1;
      this.restrictCursor();
      return;
    }
    if (buf.rowKnown && (buf.y <= buf.scrollTop || buf.y > buf.scrollBottom)) {
      this.restrictCursor();
      return;
    }
    buf.rowKnown = false;
    buf.colKnown = false;
  }

  private recordNormalPrinted(endCol: number, wrapped: boolean): void {
    if (this.altScreen) return;
    const buf = this.normal;
    if (wrapped) {
      buf.hasWrappedLine = true;
      buf.maxPrintedCol = this.cols;
      return;
    }
    if (this.insertMode && buf.maxPrintedCol > 0) {
      buf.maxPrintedCol = this.cols;
      return;
    }
    const clamped = Math.min(this.cols, endCol);
    if (clamped > buf.maxPrintedCol) {
      buf.maxPrintedCol = clamped;
    }
  }

  private advanceAsciiRun(count: number): void {
    if (count <= 0) return;
    const buf = this.active();
    this.precedingWidth = 1;
    if (!buf.colKnown) {
      this.recordNormalPrinted(this.cols, this.autowrap);
      if (this.autowrap) {
        buf.rowKnown = false;
        if (!this.altScreen && buf.scrollTop === 0) {
          this.normal.ybaseKnown = false;
        }
      }
      return;
    }
    if (!this.autowrap) {
      buf.x = Math.min(this.cols, buf.x + count);
      this.recordNormalPrinted(buf.x, false);
      return;
    }
    let remaining = count;
    let wrapped = false;
    if (buf.x > this.cols) {
      this.advanceRowsDown(1);
      buf.x = 1;
      wrapped = true;
      remaining -= 1;
      if (remaining === 0) {
        this.recordNormalPrinted(buf.x, true);
        return;
      }
    }
    if (buf.x + remaining <= this.cols) {
      buf.x += remaining;
      this.recordNormalPrinted(buf.x, wrapped);
      return;
    }
    const afterLine = buf.x + remaining - this.cols;
    const wraps = Math.ceil(afterLine / this.cols);
    this.advanceRowsDown(wraps);
    buf.x = ((afterLine - 1) % this.cols) + 1;
    this.recordNormalPrinted(buf.x, true);
  }

  private printWideCount(count: number): void {
    if (count <= 0) return;
    const buf = this.active();
    this.precedingWidth = 2;
    if (!buf.colKnown) {
      this.recordNormalPrinted(this.cols, this.autowrap);
      if (this.autowrap) {
        buf.rowKnown = false;
        if (!this.altScreen && buf.scrollTop === 0) {
          this.normal.ybaseKnown = false;
        }
      }
      return;
    }
    if (!this.autowrap) {
      if (buf.x + 2 > this.cols) {
        buf.x = this.cols - 1;
      } else if (count === 1) {
        buf.x += 2;
      } else if (buf.x + count * 2 <= this.cols) {
        buf.x += count * 2;
      } else {
        buf.x = this.cols - 1;
      }
      this.recordNormalPrinted(buf.x, false);
      return;
    }
    let wrapped = false;
    if (count <= 8) {
      for (let i = 0; i < count; i += 1) {
        if (buf.x + 2 > this.cols) {
          this.advanceRowsDown(1);
          buf.x = 2;
          wrapped = true;
        } else {
          buf.x += 2;
        }
      }
      this.recordNormalPrinted(buf.x, wrapped);
      return;
    }
    let remaining = count;
    if (buf.x + 2 > this.cols) {
      this.advanceRowsDown(1);
      buf.x = 2;
      wrapped = true;
      remaining -= 1;
    }
    const fitCurrent = Math.floor((this.cols - buf.x) / 2);
    if (remaining <= fitCurrent) {
      buf.x += remaining * 2;
      this.recordNormalPrinted(buf.x, wrapped);
      return;
    }
    remaining -= fitCurrent;
    const perLine = Math.floor(this.cols / 2);
    const wraps = Math.ceil(remaining / perLine);
    this.advanceRowsDown(wraps);
    const onLastLine = ((remaining - 1) % perLine) + 1;
    buf.x = onLastLine * 2;
    this.recordNormalPrinted(buf.x, true);
  }

  private printCodePoint(cp: number): void {
    if (cp === 0xad) return;
    const width = unicodeV11CellWidth(cp);
    if (width === 1) {
      this.advanceAsciiRun(1);
      return;
    }
    if (width === 2) {
      this.printWideCount(1);
      return;
    }
    if (this.precedingWidth > 0) {
      return;
    }
    const buf = this.active();
    this.precedingWidth = 0;
    if (!buf.colKnown) {
      this.recordNormalPrinted(this.cols, this.autowrap);
      if (this.autowrap) {
        buf.rowKnown = false;
        if (!this.altScreen && buf.scrollTop === 0) {
          this.normal.ybaseKnown = false;
        }
      }
      return;
    }
    if (buf.x > this.cols) {
      if (this.autowrap) {
        this.advanceRowsDown(1);
        buf.x = 1;
        this.recordNormalPrinted(buf.x, true);
      } else {
        buf.x = this.cols;
        this.recordNormalPrinted(buf.x, false);
      }
      return;
    }
    buf.x += 1;
    this.recordNormalPrinted(buf.x, false);
  }

  private repeatPreceding(count: number): void {
    if (this.precedingWidth === 1) {
      this.advanceAsciiRun(count);
    } else if (this.precedingWidth === 2) {
      this.printWideCount(count);
    }
  }

  private applyExecute(code: number): void {
    this.precedingWidth = 0;
    switch (code) {
      case 0x08:
        this.backspace();
        return;
      case 0x09:
        this.forwardTab(1);
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed();
        return;
      case 0x0d: {
        const buf = this.active();
        buf.x = 0;
        buf.colKnown = true;
        return;
      }
      case 0x84:
        this.index();
        return;
      case 0x85:
        this.nextLine();
        return;
      case 0x88:
        this.tabSet();
        return;
    }
  }

  private applyEsc(collect: number, finalByte: number): void {
    if (collect === 0) {
      switch (finalByte) {
        case 0x37:
          this.saveCursor();
          return;
        case 0x38:
          this.restoreCursor();
          return;
        case 0x44:
          this.index();
          return;
        case 0x45:
          this.nextLine();
          return;
        case 0x48:
          this.tabSet();
          return;
        case 0x4d:
          this.reverseIndex();
          return;
        case 0x63:
          this.fullReset();
          return;
      }
      return;
    }
    if (collect === 0x23 && finalByte === 0x38) {
      if (!this.altScreen) {
        this.normal.maxPrintedCol = this.cols;
      }
      this.applyXtermOriginSetCursor(0, 0, true, true);
    }
  }

  private cursorUp(count: number): void {
    const buf = this.active();
    if (!buf.rowKnown) {
      this.restrictCursor();
      return;
    }
    const diffToTop = buf.y - buf.scrollTop;
    const delta = diffToTop >= 0 ? -Math.min(diffToTop, count) : -count;
    this.applyXtermOriginMoveCursor(0, delta);
  }

  private cursorDown(count: number): void {
    const buf = this.active();
    if (!buf.rowKnown) {
      this.restrictCursor();
      return;
    }
    const diffToBottom = buf.scrollBottom - buf.y;
    const delta = diffToBottom >= 0 ? Math.min(diffToBottom, count) : count;
    this.applyXtermOriginMoveCursor(0, delta);
  }

  private applyCsi(finalByte: number): void {
    const collect = this.csiCollect;
    const p0 = this.csiParams[0]!;

    if (collect === 0x3f) {
      if (finalByte === 0x4a) {
        this.restrictCursor(this.cols);
        if (p0 === 3 && !this.altScreen) {
          this.normal.ybase = 0;
          this.normal.ybaseKnown = true;
          this.normal.scrollsSinceReset = 0;
          this.normal.linesLength = this.rows;
        }
        return;
      }
      if (finalByte === 0x4b) {
        this.restrictCursor(this.cols);
        return;
      }
      if (finalByte !== 0x68 && finalByte !== 0x6c) return;
      const enable = finalByte === 0x68;
      for (let i = 0; i < this.csiParamCount; i += 1) {
        const mode = this.csiParams[i]!;
        switch (mode) {
          case 6:
            this.originMode = enable;
            this.applyXtermOriginSetCursor(0, 0, true, true);
            break;
          case 7:
            this.autowrap = enable;
            break;
          case 45:
            this.reverseWraparound = enable;
            break;
          case 1048:
            if (enable) this.saveCursor();
            else this.restoreCursor();
            break;
          case 1049:
            if (enable) {
              this.saveCursor();
              this.activateAltBuffer();
            } else {
              this.activateNormalBuffer();
              this.restoreCursor();
            }
            break;
          case 47:
          case 1047:
            if (enable) this.activateAltBuffer();
            else this.activateNormalBuffer();
            break;
        }
      }
      return;
    }

    if (collect === 0x21) {
      if (finalByte === 0x70) {
        this.softReset();
      }
      return;
    }

    if ((collect === 0x20 && finalByte === 0x41) || (collect === 0x27 && finalByte === 0x7d)) {
      if (!this.altScreen && this.normal.maxPrintedCol > 0) {
        this.normal.maxPrintedCol = this.cols;
      }
      return;
    }

    if (collect !== 0) {
      return;
    }

    const buf = this.active();
    switch (finalByte) {
      case 0x40:
        this.restrictCursor();
        if (!this.altScreen && this.normal.maxPrintedCol > 0) {
          this.normal.maxPrintedCol = this.cols;
        }
        return;
      case 0x50:
      case 0x58:
        this.restrictCursor();
        return;
      case 0x41:
        this.cursorUp(p0 || 1);
        return;
      case 0x42:
        this.cursorDown(p0 || 1);
        return;
      case 0x43:
      case 0x61:
        this.applyXtermOriginMoveCursor(p0 || 1, 0);
        return;
      case 0x44:
        this.applyXtermOriginMoveCursor(-(p0 || 1), 0);
        return;
      case 0x45:
        this.cursorDown(p0 || 1);
        buf.x = 0;
        buf.colKnown = true;
        return;
      case 0x46:
        this.cursorUp(p0 || 1);
        buf.x = 0;
        buf.colKnown = true;
        return;
      case 0x47:
      case 0x60:
        this.applyXtermOriginSetCursor((p0 || 1) - 1, buf.y, true, false);
        return;
      case 0x48:
      case 0x66: {
        const col = this.csiParamCount >= 2 ? (this.csiParams[1]! || 1) - 1 : 0;
        const row = (p0 || 1) - 1;
        this.applyXtermOriginSetCursor(col, row, true, true);
        return;
      }
      case 0x49:
        this.forwardTab(p0 || 1);
        return;
      case 0x4a:
        this.restrictCursor(this.cols);
        if (p0 === 3 && !this.altScreen) {
          this.normal.ybase = 0;
          this.normal.ybaseKnown = true;
          this.normal.scrollsSinceReset = 0;
          this.normal.linesLength = this.rows;
        }
        return;
      case 0x4b:
        this.restrictCursor(this.cols);
        return;
      case 0x4c:
      case 0x4d:
        this.restrictCursor();
        if (!buf.rowKnown) {
          buf.colKnown = false;
        } else if (buf.y >= buf.scrollTop && buf.y <= buf.scrollBottom) {
          buf.x = 0;
          buf.colKnown = true;
        }
        return;
      case 0x5a:
        this.backwardTab(p0 || 1);
        return;
      case 0x62:
        this.repeatPreceding(p0 || 1);
        return;
      case 0x64:
        this.applyXtermOriginSetCursor(buf.x, (p0 || 1) - 1, false, true);
        return;
      case 0x65:
        this.applyXtermOriginMoveCursor(0, p0 || 1);
        return;
      case 0x67:
        if (p0 === 0) {
          if (buf.colKnown) {
            buf.tabs.delete(buf.x);
          } else {
            buf.tabsKnown = false;
          }
        } else if (p0 === 3) {
          buf.tabs.clear();
          buf.tabsKnown = true;
        }
        return;
      case 0x68:
      case 0x6c: {
        const enable = finalByte === 0x68;
        for (let i = 0; i < this.csiParamCount; i += 1) {
          const mode = this.csiParams[i];
          if (mode === 4) {
            this.insertMode = enable;
          } else if (mode === 20) {
            this.convertEol = enable;
          }
        }
        return;
      }
      case 0x72: {
        const top = p0 || 1;
        const rawBottom = this.csiParamCount >= 2 ? this.csiParams[1]! : 0;
        const bottom =
          rawBottom === 0 || rawBottom > this.rows ? this.rows : rawBottom;
        if (bottom > top) {
          buf.scrollTop = top - 1;
          buf.scrollBottom = bottom - 1;
          this.applyXtermOriginSetCursor(0, 0, true, true);
        }
        return;
      }
      case 0x73:
        this.saveCursor();
        return;
      case 0x75:
        this.restoreCursor();
        return;
    }
  }
}
