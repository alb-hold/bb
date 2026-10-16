import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const logPath = process.argv[1];
const lockPath = logPath + ".lock";
const sizeLimit = 10 * 1024 * 1024;
const fileCount = 5;
const lockWaitLimitMs = 500;
const rotate = () => {
  const oldestPath = logPath + "." + fileCount;
  if (fs.existsSync(oldestPath)) fs.unlinkSync(oldestPath);
  for (let index = fileCount - 1; index >= 1; index -= 1) {
    const sourcePath = logPath + "." + index;
    if (fs.existsSync(sourcePath)) fs.renameSync(sourcePath, logPath + "." + (index + 1));
  }
  if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath + ".1");
};
const releaseLock = (fd) => {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
};
const lockOwnerIsAlive = () => {
  try {
    const stat = fs.statSync(lockPath);
    if (stat.size === 0 && Date.now() - stat.mtimeMs > 1000) return false;
    const ownerPid = Number(fs.readFileSync(lockPath, "utf8"));
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
    if (!lockOwnerIsAlive()) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
    return null;
  }
};
const processChunk = (chunk, startedAt) => {
  const lockFd = acquireLock();
  if (lockFd === null) {
    if (Date.now() - startedAt < lockWaitLimitMs) {
      setTimeout(() => processChunk(chunk, startedAt), 10);
      return;
    }
    let fd;
    try {
      fd = fs.openSync(logPath, "a", 0o600);
      fs.writeSync(fd, chunk);
    } catch {}
    finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      process.stdin.resume();
    }
    return;
  }
  if (lockFd < 0) {
    process.stdin.resume();
    return;
  }
  let fd;
  try {
    let size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    if (size > sizeLimit) {
      rotate();
      size = 0;
    }
    fd = fs.openSync(logPath, "a", 0o600);
    let offset = 0;
    while (offset < chunk.length) {
      if (size >= sizeLimit) {
        fs.closeSync(fd);
        fd = undefined;
        rotate();
        size = 0;
        fd = fs.openSync(logPath, "a", 0o600);
      }
      const length = Math.min(sizeLimit - size, chunk.length - offset);
      const written = fs.writeSync(fd, chunk, offset, length);
      if (written === 0) break;
      offset += written;
      size += written;
    }
  } catch {}
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    releaseLock(lockFd);
    process.stdin.resume();
  }
};
process.on("uncaughtException", () => {});
process.stdin.on("error", () => {});
process.stdin.on("data", (chunk) => {
  process.stdin.pause();
  processChunk(chunk, Date.now());
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
