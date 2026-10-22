import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  truncateSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import path from "node:path";

const SEQUENCE_WIDTH = 12;
const SEQUENCE_NAME = /^\d{12}$/u;
const TEMP_NAME = /^\.tmp\.(\d+)\./u;
const MAX_RECORDS_PER_READ = 2_000;
const SCAN_INTERVAL_MS = 2_000;
const GAP_REPORT_AFTER_MS = 10_000;
const ABANDONED_TEMP_AGE_MS = 10 * 60_000;
const MAX_RESERVATIONS_PER_SCAN = 64;
const MAX_LOCK_SPINS = 2_000;
const APPEND_LOCK_NAME = "hooks.lock";
const STALE_LOCK_AFTER_MS = 10_000;
const INCOMPLETE_LINE_AFTER_MS = 10_000;
const MAX_APPEND_READ_BYTES = 4 * 1024 * 1024;
const NETWORK_FILESYSTEM_TYPES: ReadonlySet<number> = new Set([
  0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x01021997, 0x65735546, 0x5346414f,
  0x00c36400, 0x73757245,
]);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function sequenceName(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_WIDTH, "0");
}

export function createHookSpool(parent: string, label: string): string {
  return mkdtempSync(path.join(parent, `bb-native-activity-${label}-`));
}

export function removeHookSpool(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
}

export function filesystemTypeOf(directory: string): number | null {
  if (process.platform !== "linux") return null;
  let current = directory;
  for (;;) {
    try {
      return Number(statfsSync(current).type);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export function hookSpoolCandidates(args: {
  env: NodeJS.ProcessEnv;
  filesystemType?: (directory: string) => number | null;
  home: string;
  tmpDir: string;
}): string[] {
  const candidates = [args.tmpDir];
  const runtimeDir = args.env.XDG_RUNTIME_DIR;
  if (
    runtimeDir !== undefined &&
    path.isAbsolute(runtimeDir) &&
    isOwnedDirectory(runtimeDir)
  ) {
    candidates.push(runtimeDir);
  }
  candidates.push(path.join(args.home, ".bb", "native-terminals", "hooks"));
  const unique = [...new Set(candidates)];
  const typeOf = args.filesystemType ?? filesystemTypeOf;
  const isNetwork = (directory: string): boolean => {
    const type = typeOf(directory);
    return type !== null && NETWORK_FILESYSTEM_TYPES.has(type);
  };
  return [
    ...unique.filter((directory) => !isNetwork(directory)),
    ...unique.filter(isNetwork),
  ];
}

export function openHookSpool(
  candidates: readonly string[],
  label: string,
  supportsLinks: (directory: string) => boolean = hookSpoolSupportsLinks,
): string | null {
  for (const parent of candidates) {
    let directory: string;
    try {
      mkdirSync(parent, { mode: 0o700, recursive: true });
      directory = createHookSpool(parent, label);
    } catch {
      continue;
    }
    if (supportsLinks(directory)) return directory;
    removeHookSpool(directory);
  }
  return null;
}

export function openHookAppendFile(
  candidates: readonly string[],
  label: string,
): { directory: string; file: string } | null {
  for (const parent of candidates) {
    let directory: string;
    try {
      mkdirSync(parent, { mode: 0o700, recursive: true });
      directory = createHookSpool(parent, label);
    } catch {
      continue;
    }
    const file = path.join(directory, "hooks.jsonl");
    try {
      closeSync(openSync(file, "wx", 0o600));
      return { directory, file };
    } catch {
      removeHookSpool(directory);
    }
  }
  return null;
}

export type HookSource =
  | string
  | { appendFile: string }
  | { unavailable: true }
  | null;

export interface HookCapture {
  directory: string | null;
  source: Exclude<HookSource, null>;
}

export function openHookCapture(
  candidates: readonly string[],
  label: string,
  events: { appendFallback(): void; unsupported(): void },
  supportsLinks: (directory: string) => boolean = hookSpoolSupportsLinks,
): HookCapture {
  const spool = openHookSpool(candidates, label, supportsLinks);
  if (spool !== null) return { directory: spool, source: spool };
  const append = openHookAppendFile(candidates, label);
  if (append !== null) {
    events.appendFallback();
    return { directory: append.directory, source: { appendFile: append.file } };
  }
  events.unsupported();
  return { directory: null, source: { unavailable: true } };
}

export function hookSpoolSupportsLinks(directory: string): boolean {
  const source = path.join(directory, `.probe.${process.pid}`);
  const target = `${source}.link`;
  try {
    closeSync(openSync(source, "wx", 0o600));
    linkSync(source, target);
    return true;
  } catch {
    return false;
  } finally {
    for (const file of [source, target]) {
      try {
        unlinkSync(file);
      } catch {
        continue;
      }
    }
  }
}

export function hookSpoolCommand(directory: string): string {
  const spool = shellQuote(directory);
  return [
    "exec 2>/dev/null",
    `d=${spool}`,
    't=$(mktemp "$d/.tmp.$$.XXXXXX") || exit 0',
    'cat >"$t" || exit 0',
    'n=$(cat "$d/.hint" 2>/dev/null)',
    "case \"$n\" in ''|*[!0-9]*) n=0;; esac",
    "while :; do n=$((n+1)); f=$(printf '%012d' \"$n\");" +
      ' if ln "$t" "$d/$f"; then break; fi;' +
      ' [ -e "$d/$f" ] || exit 0; done',
    'printf \'%s\' "$n" >"$d/.hint.$$" && mv -f "$d/.hint.$$" "$d/.hint"',
    'rm -f "$t"',
    "exit 0",
  ].join("; ");
}

export function hookAppendCommand(
  file: string,
  spins: number = MAX_LOCK_SPINS,
): string {
  return [
    "exec 2>/dev/null",
    `d=${shellQuote(path.dirname(file))}`,
    `f=${shellQuote(file)}`,
    'm="$d/.tmp.$$.mark"',
    ': >"$m" || exit 0',
    "r=$(cat) || exit 0",
    "i=0",
    `until mkdir "$d/${APPEND_LOCK_NAME}"; do i=$((i+1)); [ "$i" -lt ${spins} ] || exit 0; done`,
    'printf \'%s\\n\' "$r" >>"$f" && rm -f "$m"',
    `rm -rf "$d/${APPEND_LOCK_NAME}"`,
    "exit 0",
  ].join("; ");
}

export function hookCommandFor(target: string | { appendFile: string }): string {
  return typeof target === "string"
    ? hookSpoolCommand(target)
    : hookAppendCommand(target.appendFile);
}

export interface HookSpoolRead {
  records: unknown[];
  unreadable: number;
}

export class HookSpoolReader {
  private next = 1;
  private lastScanAt = 0;
  private gapSince: number | null = null;
  private gapCounted = false;
  private readonly skipped: Array<{ from: number; to: number }> = [];
  private readonly reportedLate = new Set<string>();
  private readonly reportedTemps = new Set<string>();

  constructor(private readonly directory: string) {}

  read(now: number = Date.now()): HookSpoolRead {
    const records: unknown[] = [];
    let unreadable = this.drain(records);
    if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
      this.lastScanAt = now;
      unreadable += this.scan(now);
      unreadable += this.drain(records);
    }
    return { records, unreadable };
  }

  private drain(records: unknown[]): number {
    let unreadable = 0;
    for (let count = 0; count < MAX_RECORDS_PER_READ; count += 1) {
      const file = path.join(this.directory, sequenceName(this.next));
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (error) {
        if (isMissing(error)) break;
        unreadable += 1;
        this.next += 1;
        continue;
      }
      this.next += 1;
      this.gapSince = null;
      try {
        records.push(JSON.parse(content));
      } catch {
        unreadable += 1;
      }
      try {
        truncateSync(file, 0);
      } catch {
        continue;
      }
    }
    return unreadable;
  }

  private scan(now: number): number {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return 0;
    }
    let lost = 0;
    let firstBeyondGap: number | null = null;
    const expectedMissing = !names.includes(sequenceName(this.next));
    for (const name of names) {
      if (SEQUENCE_NAME.test(name)) {
        const sequence = Number(name);
        if (expectedMissing && sequence > this.next) {
          firstBeyondGap =
            firstBeyondGap === null ? sequence : Math.min(firstBeyondGap, sequence);
        }
        lost += this.settleLate(name, sequence);
        continue;
      }
      const temp = TEMP_NAME.exec(name);
      if (temp === null || this.reportedTemps.has(name)) continue;
      if (isInFlightOrPublished(this.directory, name, Number(temp[1]), now)) {
        continue;
      }
      this.reportedTemps.add(name);
      lost += 1;
    }
    if (firstBeyondGap === null) {
      this.gapSince = null;
      this.gapCounted = false;
      return lost;
    }
    this.gapSince ??= now;
    if (now - this.gapSince >= GAP_REPORT_AFTER_MS) {
      const from = this.next;
      let outcome: ReturnType<typeof reserveSequence> = "reserved";
      while (
        this.next < firstBeyondGap &&
        this.next - from < MAX_RESERVATIONS_PER_SCAN
      ) {
        outcome = reserveSequence(this.directory, this.next);
        if (outcome !== "reserved") break;
        this.next += 1;
      }
      if (this.next > from) this.skipped.push({ from, to: this.next });
      if ((this.next > from || outcome === "failed") && !this.gapCounted) {
        this.gapCounted = true;
        lost += 1;
      }
      if (this.next >= firstBeyondGap) {
        this.gapSince = null;
        this.gapCounted = false;
      }
    }
    return lost;
  }

  private settleLate(name: string, sequence: number): number {
    if (
      this.reportedLate.has(name) ||
      !this.skipped.some((range) => sequence >= range.from && sequence < range.to)
    ) {
      return 0;
    }
    const file = path.join(this.directory, name);
    try {
      if (statSync(file).size === 0) return 0;
      truncateSync(file, 0);
    } catch {
      return 0;
    }
    this.reportedLate.add(name);
    return 1;
  }
}

export function reserveSequence(
  directory: string,
  sequence: number,
): "reserved" | "present" | "failed" {
  try {
    closeSync(
      openSync(path.join(directory, sequenceName(sequence)), "wx", 0o600),
    );
    return "reserved";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST"
      ? "present"
      : "failed";
  }
}

function isInFlightOrPublished(
  directory: string,
  name: string,
  pid: number,
  now: number,
): boolean {
  let stats: Stats;
  try {
    stats = statSync(path.join(directory, name));
  } catch {
    return true;
  }
  if (stats.nlink > 1) return true;
  if (now - stats.mtimeMs > ABANDONED_TEMP_AGE_MS) return false;
  return processIsAlive(pid);
}

function isOwnedDirectory(directory: string): boolean {
  try {
    const stats = statSync(directory);
    return (
      stats.isDirectory() &&
      (process.getuid === undefined || stats.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

export class HookAppendReader {
  private offset = 0;
  private lastScanAt = 0;
  private incompleteSince: number | null = null;
  private incompleteOffset = -1;
  private incompleteCounted = false;
  private brokenLocks = 0;
  private readonly reportedMarkers = new Set<string>();

  constructor(private readonly file: string) {}

  read(now: number = Date.now()): HookSpoolRead {
    const result = this.readLines(now);
    if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
      this.lastScanAt = now;
      result.unreadable += this.breakStaleLock(now) + this.scanMarkers(now);
    }
    return result;
  }

  private readLines(now: number): HookSpoolRead {
    const records: unknown[] = [];
    let unreadable = 0;
    let descriptor: number;
    try {
      descriptor = openSync(this.file, "r");
    } catch {
      return { records, unreadable };
    }
    try {
      const size = fstatSync(descriptor).size;
      const length = Math.min(size - this.offset, MAX_APPEND_READ_BYTES);
      if (length <= 0) {
        this.incompleteSince = null;
        return { records, unreadable };
      }
      const buffer = Buffer.alloc(length);
      const filled = readSync(descriptor, buffer, 0, length, this.offset);
      const text = buffer.subarray(0, filled);
      const end = text.lastIndexOf(0x0a);
      if (end < 0 && filled >= MAX_APPEND_READ_BYTES) {
        this.offset += filled;
        return { records, unreadable: 1 };
      }
      const consumed = end + 1;
      this.offset += consumed;
      for (const line of text
        .subarray(0, consumed)
        .toString("utf8")
        .split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          unreadable += 1;
        }
      }
      unreadable += this.trackIncompleteLine(
        filled > consumed && this.offset + filled - consumed >= size,
        now,
      );
    } catch {
      return { records, unreadable };
    } finally {
      closeSync(descriptor);
    }
    return { records, unreadable };
  }

  private trackIncompleteLine(incomplete: boolean, now: number): number {
    if (!incomplete) {
      this.incompleteSince = null;
      return 0;
    }
    if (this.incompleteSince === null || this.incompleteOffset !== this.offset) {
      this.incompleteSince = now;
      this.incompleteOffset = this.offset;
      this.incompleteCounted = false;
    }
    if (
      !this.incompleteCounted &&
      now - this.incompleteSince >= INCOMPLETE_LINE_AFTER_MS
    ) {
      this.incompleteCounted = true;
      return 1;
    }
    return 0;
  }

  private breakStaleLock(now: number): number {
    const lock = path.join(path.dirname(this.file), APPEND_LOCK_NAME);
    try {
      if (now - statSync(lock).mtimeMs < STALE_LOCK_AFTER_MS) return 0;
      this.brokenLocks += 1;
      const moved = `${lock}.stale.${process.pid}.${this.brokenLocks}`;
      renameSync(lock, moved);
      rmSync(moved, { force: true, recursive: true });
      return 1;
    } catch {
      return 0;
    }
  }

  private scanMarkers(now: number): number {
    const directory = path.dirname(this.file);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return 0;
    }
    let lost = 0;
    for (const name of names) {
      const marker = TEMP_NAME.exec(name);
      if (marker === null || this.reportedMarkers.has(name)) continue;
      if (isInFlightOrPublished(directory, name, Number(marker[1]), now)) {
        continue;
      }
      this.reportedMarkers.add(name);
      lost += 1;
    }
    return lost;
  }
}

export interface HookRecordSource {
  read(now?: number): HookSpoolRead;
}

export function hookRecordSource(source: HookSource): HookRecordSource | null {
  if (source === null) return null;
  if (typeof source === "string") return new HookSpoolReader(source);
  if ("appendFile" in source) return new HookAppendReader(source.appendFile);
  return null;
}

export function hookSourceIsUnavailable(source: HookSource): boolean {
  return source !== null && typeof source === "object" && "unavailable" in source;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && error.code === "EPERM"
    );
  }
}
