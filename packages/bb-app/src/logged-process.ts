import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const logPath = process.argv[1];
const writerBarrier = process.argv[2] ? JSON.parse(process.argv[2]) : null;
const sizeLimit = 10 * 1024 * 1024;
const retainedBackups = 5;
const token = process.pid + "-" + crypto.randomUUID();
const familyPrefix = logPath + ".";
const activePath = familyPrefix + "active-" + token;
let activeFd;
let activeSize = 0;
let aliasSequence = 0;
let writerBarrierUsed = false;
let failedInjectedWrite = false;
let stopped = false;
const pendingChunks = [];
let pendingBytes = 0;
const maxPendingBytes = 16 * 1024 * 1024;
let processing = false;
let inputPaused = false;
const backupPattern = /^.+\\.backup-[0-9]+-[0-9]+-[a-f0-9-]+$/;
const activePattern = /^.+\\.active-[0-9]+-[a-f0-9-]+$/;
const paths = () => fs.readdirSync(require("node:path").dirname(logPath)).map((name) => require("node:path").join(require("node:path").dirname(logPath), name));
const uniqueBackupPath = () => familyPrefix + "backup-" + Date.now() + "-" + token + "-" + crypto.randomUUID();
const publishAliasTo = (targetPath) => {
  const temporary = logPath + ".alias-" + token + "-" + (++aliasSequence);
  try {
    fs.linkSync(targetPath, temporary);
    try {
      fs.renameSync(temporary, logPath);
    } catch {
      try { fs.unlinkSync(logPath); } catch {}
      fs.renameSync(temporary, logPath);
    }
  } catch {
    try { fs.unlinkSync(temporary); } catch {}
  }
};
const pruneBackups = () => {
  try {
    const backups = paths().filter((path) => path.startsWith(familyPrefix) && backupPattern.test(require("node:path").basename(path)));
    backups.sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);
    while (backups.length > retainedBackups) {
      const oldest = backups.shift();
      try {
        const aliasStat = fs.statSync(logPath);
        const oldestStat = fs.statSync(oldest);
        if (aliasStat.dev === oldestStat.dev && aliasStat.ino === oldestStat.ino) {
          const replacement = paths()
            .filter((path) => path !== oldest && (activePattern.test(require("node:path").basename(path)) || backupPattern.test(require("node:path").basename(path))))
            .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
          if (replacement !== undefined) publishAliasTo(replacement);
          else fs.unlinkSync(logPath);
        }
      } catch {}
      try { fs.unlinkSync(oldest); } catch {}
    }
  } catch {}
};
const migrateLegacyFiles = () => {
  const baseName = require("node:path").basename(logPath);
  const numberedBackups = paths().filter((path) => {
    const name = require("node:path").basename(path);
    const suffix = name.slice(baseName.length + 1);
    return name.startsWith(baseName + ".") && /^[1-9][0-9]*$/.test(suffix);
  }).sort((left, right) => Number(require("node:path").basename(right).slice(baseName.length + 1)) - Number(require("node:path").basename(left).slice(baseName.length + 1)));
  const candidates = [...numberedBackups, logPath];
  for (const sourcePath of candidates) {
    if (!fs.existsSync(sourcePath)) continue;
    let sourceFd;
    let backupFd;
    let backupPath;
    try {
      const sourceStat = fs.statSync(sourcePath);
      const alreadySegmented = paths().some((path) => {
        if (path === sourcePath || (!activePattern.test(require("node:path").basename(path)) && !backupPattern.test(require("node:path").basename(path))) || !fs.existsSync(path)) return false;
        const candidateStat = fs.statSync(path);
        return candidateStat.dev === sourceStat.dev && candidateStat.ino === sourceStat.ino;
      });
      if (alreadySegmented || sourceStat.size === 0) continue;
      sourceFd = fs.openSync(sourcePath, "r");
      let remaining = sourceStat.size;
      let segmentSize = 0;
      const buffer = Buffer.alloc(64 * 1024);
      while (remaining > 0) {
        if (backupFd === undefined || segmentSize >= sizeLimit) {
          if (backupFd !== undefined) fs.closeSync(backupFd);
          backupPath = uniqueBackupPath();
          backupFd = fs.openSync(backupPath, "wx", 0o600);
          segmentSize = 0;
        }
        const length = Math.min(buffer.length, remaining, sizeLimit - segmentSize);
        const read = fs.readSync(sourceFd, buffer, 0, length, null);
        if (read <= 0) throw new Error("legacy stdio log ended during migration");
        let offset = 0;
        while (offset < read) offset += fs.writeSync(backupFd, buffer, offset, read - offset);
        remaining -= read;
        segmentSize += read;
      }
      fs.closeSync(sourceFd);
      sourceFd = undefined;
      if (backupFd !== undefined) fs.closeSync(backupFd);
      backupFd = undefined;
      fs.unlinkSync(sourcePath);
    } catch {
      if (sourceFd !== undefined) { try { fs.closeSync(sourceFd); } catch {} }
      if (backupFd !== undefined) { try { fs.closeSync(backupFd); } catch {} }
    }
  }
  pruneBackups();
};
const recoverClosedSegments = () => {
  for (const path of paths()) {
    const name = require("node:path").basename(path);
    if (!path.startsWith(familyPrefix) || !activePattern.test(name)) continue;
    const ownerPid = Number(name.slice(name.indexOf(".active-") + 8).split("-")[0]);
    if (!Number.isInteger(ownerPid) || ownerPid < 1) continue;
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") continue;
      try { fs.renameSync(path, uniqueBackupPath()); } catch {}
    }
  }
  pruneBackups();
};
const createActive = () => {
  activeFd = fs.openSync(activePath, "wx", 0o600);
  activeSize = 0;
  publishAliasTo(activePath);
};
const closeActive = (archive) => {
  if (activeFd !== undefined) {
    try { fs.closeSync(activeFd); } catch {}
    activeFd = undefined;
  }
  if (archive && fs.existsSync(activePath)) {
    try { fs.renameSync(activePath, uniqueBackupPath()); } catch {}
    pruneBackups();
  }
};
const rotateOwnedSegment = () => {
  closeActive(true);
  createActive();
};
const append = (chunk) => {
  let offset = 0;
  while (offset < chunk.length) {
    if (activeSize >= sizeLimit) rotateOwnedSegment();
    const length = Math.min(sizeLimit - activeSize, chunk.length - offset);
    if (writerBarrier !== null && writerBarrier.failFirstWrite && !failedInjectedWrite) {
      failedInjectedWrite = true;
      const fullFd = fs.openSync("/dev/full", "w");
      try { fs.writeSync(fullFd, chunk, offset, length); } finally { fs.closeSync(fullFd); }
    }
    if (writerBarrier !== null && !writerBarrierUsed && activeSize >= writerBarrier.pauseAtBytes) {
      writerBarrierUsed = true;
      fs.writeFileSync(writerBarrier.enteredPath, "entered");
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(writerBarrier.releasePath)) Atomics.wait(waitCell, 0, 0, 10);
    }
    const written = fs.writeSync(activeFd, chunk, offset, length);
    if (written <= 0) throw new Error("stdio segment write made no progress");
    offset += written;
    activeSize += written;
  }
};
const processNext = () => {
  if (processing || stopped) return;
  const chunk = pendingChunks.shift();
  if (chunk === undefined) return;
  pendingBytes -= chunk.length;
  if (inputPaused && pendingBytes < maxPendingBytes / 2) {
    inputPaused = false;
    process.stdin.resume();
  }
  processing = true;
  try { append(chunk); } catch {}
  processing = false;
  setImmediate(processNext);
};
try {
  migrateLegacyFiles();
  recoverClosedSegments();
  createActive();
} catch {}
process.stdin.on("data", (chunk) => {
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;
  if (!inputPaused && pendingBytes >= maxPendingBytes) {
    inputPaused = true;
    process.stdin.pause();
  }
  processNext();
});
process.stdin.on("end", () => {
  stopped = true;
  while (pendingChunks.length > 0) {
    const chunk = pendingChunks.shift();
    pendingBytes -= chunk.length;
    try { append(chunk); } catch {}
  }
  closeActive(true);
});
process.stdin.on("error", () => {});
process.on("uncaughtException", () => {});
`;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
  logDir: string;
  logName: "server" | "host-daemon";
  testWriterBarrier?: {
    enteredPath?: string;
    releasePath?: string;
    pauseAtBytes?: number;
    failFirstWrite?: boolean;
  };
}

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  mkdirSync(args.logDir, { recursive: true });
  const logPath = join(args.logDir, `${args.logName}-stdio.log`);
  const logWriter = spawn(
    process.execPath,
    [
      "-e",
      stdioLogWriter,
      logPath,
      JSON.stringify(args.testWriterBarrier ?? null),
    ],
    { detached: true, env: process.env, stdio: ["pipe", "ignore", "ignore"] },
  );
  logWriter.unref();
  const child = spawn(args.command, args.args, {
    cwd: process.cwd(),
    env: args.env,
    stdio:
      args.ipc === true
        ? ["ignore", logWriter.stdin, logWriter.stdin, "ipc"]
        : ["ignore", logWriter.stdin, logWriter.stdin],
  });
  logWriter.stdin?.destroy();
  return child;
}
