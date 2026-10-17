import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const logPath = process.argv[1];
const lockPath = logPath + ".lock";
const appendLockPath = logPath + ".append.lock";
const sizeLimit = 10 * 1024 * 1024;
const fileCount = 5;
const lockWaitLimitMs = 500;
const locklessPeriodMs = 5_000;
const appendLockStaleMs = 2_000;
const maxPendingBytes = 16 * 1024 * 1024;
let locklessUntil = 0;
const pendingChunks = [];
let processing = false;
let pendingBytes = 0;
let inputPaused = false;
const rotate = () => {
  const oldestPath = logPath + "." + fileCount;
  if (fs.existsSync(oldestPath)) fs.unlinkSync(oldestPath);
  for (let index = fileCount - 1; index >= 1; index -= 1) {
    const sourcePath = logPath + "." + index;
    if (fs.existsSync(sourcePath)) fs.renameSync(sourcePath, logPath + "." + (index + 1));
  }
  if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath + ".1");
};
const lockOwnerIsAlive = (path) => {
  try {
    const stat = fs.statSync(path);
    if (stat.size === 0 && Date.now() - stat.mtimeMs > 1000) return false;
    const ownerPid = Number(fs.readFileSync(path, "utf8"));
    if (!Number.isInteger(ownerPid) || ownerPid < 1) return true;
    if (ownerPid === process.pid) return false;
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  } catch {
    return true;
  }
};
const acquireLock = () => {
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeSync(fd, String(process.pid));
    return fd;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
    if (error.code !== "EEXIST") return -1;
    if (!lockOwnerIsAlive(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
    return null;
  }
};
const appendSerialized = (chunk, done) => {
  let lockFd;
  try {
    lockFd = fs.openSync(appendLockPath, "wx", 0o600);
    fs.writeSync(lockFd, String(process.pid));
  } catch (error) {
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(appendLockPath); } catch {}
    }
    if (error.code === "EEXIST") {
      let stale;
      try {
        stale = Date.now() - fs.statSync(appendLockPath).mtimeMs > appendLockStaleMs;
      } catch (statError) {
        if (statError.code !== "ENOENT") {
          done();
          return;
        }
      }
      if (stale || !lockOwnerIsAlive(appendLockPath)) {
        try { fs.unlinkSync(appendLockPath); } catch {}
      }
      setTimeout(() => appendSerialized(chunk, done), 10);
      return;
    }
    done();
    return;
  }
  let fd;
  try {
    let offset = 0;
    while (offset < chunk.length) {
      let size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      if (size >= sizeLimit) {
        if (fd !== undefined) {
          fs.closeSync(fd);
          fd = undefined;
        }
        rotate();
        size = 0;
      }
      if (fd === undefined) fd = fs.openSync(logPath, "a", 0o600);
      const length = Math.min(sizeLimit - size, chunk.length - offset);
      const written = fs.writeSync(fd, chunk, offset, length);
      if (written === 0) break;
      offset += written;
    }
  } catch {}
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    releaseLock(appendLockPath, lockFd);
    done();
  }
};
const releaseLock = (path, fd) => {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(path); } catch {}
};
const processChunk = (chunk, startedAt, done) => {
  if (Date.now() < locklessUntil) {
    appendSerialized(chunk, done);
    return;
  }
  const lockFd = acquireLock();
  if (lockFd === null) {
    if (Date.now() - startedAt < lockWaitLimitMs) {
      setTimeout(() => processChunk(chunk, startedAt, done), 10);
      return;
    }
    locklessUntil = Date.now() + locklessPeriodMs;
    appendSerialized(chunk, done);
    return;
  }
  if (lockFd < 0) {
    done();
    return;
  }
  appendSerialized(chunk, () => {
    releaseLock(lockPath, lockFd);
    done();
  });
};
const processNext = () => {
  if (processing) return;
  const chunk = pendingChunks.shift();
  if (chunk === undefined) return;
  pendingBytes -= chunk.length;
  if (inputPaused && pendingBytes < maxPendingBytes) {
    inputPaused = false;
    process.stdin.resume();
  }
  processing = true;
  processChunk(chunk, Date.now(), () => {
    processing = false;
    processNext();
  });
};
process.on("uncaughtException", () => {});
process.stdin.on("error", () => {});
process.stdin.on("data", (chunk) => {
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;
  if (!inputPaused && pendingBytes >= maxPendingBytes) {
    inputPaused = true;
    process.stdin.pause();
  }
  processNext();
});
`;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
  logDir: string;
  logName: "server" | "host-daemon";
}

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  mkdirSync(args.logDir, { recursive: true });

  const logPath = join(args.logDir, `${args.logName}-stdio.log`);
  const logWriter = spawn(process.execPath, ["-e", stdioLogWriter, logPath], {
    detached: true,
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  });
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
