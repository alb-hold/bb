import {
  closeSync,
  linkSync,
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
  private gapReported = false;
  private readonly reportedTemps = new Set<string>();

  constructor(private readonly directory: string) {}

  read(now: number = Date.now()): HookSpoolRead {
    const records: unknown[] = [];
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
      this.gapReported = false;
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
    if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
      this.lastScanAt = now;
      unreadable += this.scan(now);
    }
    return { records, unreadable };
  }

  private scan(now: number): number {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return 0;
    }
    let lost = 0;
    let beyondGap = false;
    const expectedMissing = !names.includes(sequenceName(this.next));
    for (const name of names) {
      if (SEQUENCE_NAME.test(name)) {
        if (expectedMissing && Number(name) > this.next) beyondGap = true;
        continue;
      }
      const temp = TEMP_NAME.exec(name);
      if (temp === null || this.reportedTemps.has(name)) continue;
      if (this.isInFlightOrPublished(name, Number(temp[1]), now)) continue;
      this.reportedTemps.add(name);
      lost += 1;
    }
    if (beyondGap) {
      this.gapSince ??= now;
      if (!this.gapReported && now - this.gapSince >= GAP_REPORT_AFTER_MS) {
        this.gapReported = true;
        lost += 1;
      }
    } else {
      this.gapSince = null;
    }
    return lost;
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
