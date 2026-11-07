import {
  readTerminalFontFamily,
  readTerminalFontMetrics,
  TERMINAL_LINE_HEIGHT,
} from "./terminal-font";

const STORAGE_KEY = "bb.terminal.fit-grids.v1";
const MAX_ENTRIES = 32;
interface Entry {
  terminalId: string;
  viewportWidth: number;
  viewportHeight: number;
  widthClass: "compact" | "wide";
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  fontWeight: number;
  dpr: number;
  cols: number;
  rows: number;
}

function positive(
  value: unknown,
  max: number,
  integer = false,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= max &&
    (!integer || Number.isInteger(value))
  );
}

function isEntry(value: unknown): value is Entry {
  return (
    typeof value === "object" &&
    value !== null &&
    "terminalId" in value &&
    typeof value.terminalId === "string" &&
    value.terminalId.length > 0 &&
    value.terminalId.length <= 256 &&
    "viewportWidth" in value &&
    positive(value.viewportWidth, 100_000, true) &&
    "viewportHeight" in value &&
    positive(value.viewportHeight, 100_000, true) &&
    "widthClass" in value &&
    (value.widthClass === "compact" || value.widthClass === "wide") &&
    "width" in value &&
    positive(value.width, 100_000, true) &&
    "height" in value &&
    positive(value.height, 100_000, true) &&
    "fontSize" in value &&
    positive(value.fontSize, 256) &&
    "fontFamily" in value &&
    typeof value.fontFamily === "string" &&
    value.fontFamily.length <= 2048 &&
    "lineHeight" in value &&
    positive(value.lineHeight, 4) &&
    "fontWeight" in value &&
    positive(value.fontWeight, 1000) &&
    "dpr" in value &&
    positive(value.dpr, 16) &&
    "cols" in value &&
    positive(value.cols, 500, true) &&
    "rows" in value &&
    positive(value.rows, 200, true)
  );
}
let memory: Entry[] = [];
let storageUnavailable = false;

function readEntries(): Entry[] {
  if (storageUnavailable) return memory;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return (memory = []);
    if (raw.length > 128_000) return memory;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length <= MAX_ENTRIES &&
      parsed.every(isEntry)
    )
      memory = parsed;
  } catch {
    storageUnavailable = true;
  }
  return memory;
}

function context(terminalId: string, fontSize: number) {
  if (typeof window === "undefined" || typeof document === "undefined")
    return null;
  return {
    terminalId,
    viewportWidth: Math.round(window.innerWidth),
    viewportHeight: Math.round(window.innerHeight),
    widthClass:
      window.innerWidth < 768 ? ("compact" as const) : ("wide" as const),
    fontSize,
    fontFamily: readTerminalFontFamily(),
    lineHeight: TERMINAL_LINE_HEIGHT,
    fontWeight: readTerminalFontMetrics().fontWeight,
    dpr: window.devicePixelRatio,
  };
}

function matchesContext(
  entry: Entry,
  current: NonNullable<ReturnType<typeof context>>,
) {
  return (
    entry.terminalId === current.terminalId &&
    entry.viewportWidth === current.viewportWidth &&
    entry.viewportHeight === current.viewportHeight &&
    entry.widthClass === current.widthClass &&
    entry.fontSize === current.fontSize &&
    entry.fontFamily === current.fontFamily &&
    entry.lineHeight === current.lineHeight &&
    entry.fontWeight === current.fontWeight &&
    entry.dpr === current.dpr
  );
}

export function rememberTerminalGrid(
  terminalId: string,
  container: HTMLElement,
  fontSize: number,
  grid: { cols: number; rows: number },
  fontFamily = readTerminalFontFamily(),
  lineHeight = TERMINAL_LINE_HEIGHT,
  fontWeight = readTerminalFontMetrics().fontWeight,
): void {
  const current = context(terminalId, fontSize);
  if (current === null) return;
  const rect = container.getBoundingClientRect();
  const entry = {
    ...current,
    fontFamily,
    lineHeight,
    fontWeight,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    ...grid,
  };
  if (!isEntry(entry)) return;
  const entries = readEntries();
  const matches = (candidate: Entry) =>
    matchesContext(candidate, entry) &&
    candidate.width === entry.width &&
    candidate.height === entry.height;
  const previous = entries.find(matches);
  if (
    previous === entries[0] &&
    previous?.cols === entry.cols &&
    previous.rows === entry.rows
  )
    return;
  memory = [entry, ...entries.filter((candidate) => !matches(candidate))].slice(
    0,
    MAX_ENTRIES,
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    storageUnavailable = true;
  }
}

export function readCachedTerminalGrid(
  terminalId: string,
  fontSize = readTerminalFontMetrics().fontSize,
): { cols: number; rows: number } | null {
  if (typeof window === "undefined") return null;
  const stored = readEntries();
  if (!stored.some((entry) => entry.terminalId === terminalId)) return null;
  const current = context(terminalId, fontSize);
  if (current === null) return null;
  const entries = stored.filter((candidate) =>
    matchesContext(candidate, current),
  );
  if (entries.length === 0) return null;
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
  );
  let container: HTMLElement | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      node instanceof HTMLElement &&
      node.dataset.terminalGridCacheId === terminalId
    ) {
      container = node;
      break;
    }
  }
  if (container && Number(container.dataset.terminalFontSize) !== fontSize)
    return null;
  const rect = container?.getBoundingClientRect();
  const entry = entries.find(
    (candidate) =>
      matchesContext(candidate, current) &&
      (!rect ||
        (Math.round(rect.width) === candidate.width &&
          Math.round(rect.height) === candidate.height)),
  );
  if (!entry) return null;
  return { cols: entry.cols, rows: entry.rows };
}
