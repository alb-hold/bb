import { z } from "zod";
import { terminalColsSchema, terminalRowsSchema } from "@bb/domain";
import {
  readTerminalFontFamily,
  readTerminalFontMetrics,
  TERMINAL_LINE_HEIGHT,
} from "./terminal-font";

const STORAGE_KEY = "bb.terminal.fit-grids.v1";
const MAX_ENTRIES = 32;
const positive = z.number().finite().positive();
const size = positive.int().max(100_000);
const entrySchema = z.object({
  terminalId: z.string().min(1).max(256),
  viewportWidth: size,
  viewportHeight: size,
  widthClass: z.enum(["compact", "wide"]),
  width: size,
  height: size,
  fontSize: positive.max(256),
  fontFamily: z.string().max(2048),
  lineHeight: positive.max(4),
  fontWeight: positive.max(1000),
  dpr: positive.max(16),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});
const entriesSchema = z.array(entrySchema).max(MAX_ENTRIES);
type Entry = z.infer<typeof entrySchema>;
let memory: Entry[] = [];
let storageUnavailable = false;

function readEntries(): Entry[] {
  if (storageUnavailable) return memory;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return (memory = []);
    if (raw.length > 128_000) return memory;
    const parsed = entriesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) memory = parsed.data;
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
  const parsed = entrySchema.safeParse({
    ...current,
    fontFamily,
    lineHeight,
    fontWeight,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    ...grid,
  });
  if (!parsed.success) return;
  const entry = parsed.data;
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
