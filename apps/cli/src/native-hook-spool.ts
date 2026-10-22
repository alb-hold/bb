import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
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

export function hookSpoolCandidates(args: {
  env: NodeJS.ProcessEnv;
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
  return [...new Set(candidates)];
}

export function openHookSpool(
  candidates: readonly string[],
  label: string,
  onUnsupported: () => void,
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
  onUnsupported();
  return null;
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

export interface HookSpoolRead {
  records: unknown[];
  unreadable: number;
}

export class HookSpoolReader {
  private next = 1;
  private lastScanAt = 0;
  private gapSince: number | null = null;
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
      if (this.isInFlightOrPublished(name, Number(temp[1]), now)) continue;
      this.reportedTemps.add(name);
      lost += 1;
    }
    if (firstBeyondGap === null) {
      this.gapSince = null;
      return lost;
    }
    this.gapSince ??= now;
    if (now - this.gapSince >= GAP_REPORT_AFTER_MS) {
      this.skipped.push({ from: this.next, to: firstBeyondGap });
      this.next = firstBeyondGap;
      this.gapSince = null;
      lost += 1;
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

  private isInFlightOrPublished(
    name: string,
    pid: number,
    now: number,
  ): boolean {
    let stats: Stats;
    try {
      stats = statSync(path.join(this.directory, name));
    } catch {
      return true;
    }
    if (stats.nlink > 1) return true;
    if (now - stats.mtimeMs > ABANDONED_TEMP_AGE_MS) return false;
    return processIsAlive(pid);
  }
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
