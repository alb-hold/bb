import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const logPath = process.argv[1];
const writerBarrier = process.argv[2] ? JSON.parse(process.argv[2]) : null;
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
let writerBarrierUsed = false;
let writerAfterStatBarrierUsed = false;
let writerAttemptPathUsed = false;
const waitForFile = (path, lockToken) =>
  new Promise((resolve) => {
    const poll = () => {
      if (fs.existsSync(path)) resolve();
      else {
        if (lockToken !== undefined) refreshLock(appendLockPath, lockToken);
        setTimeout(poll, 10);
      }
    };
    poll();
  });
const rotate = () => {
  const oldestPath = logPath + "." + fileCount;
  if (fs.existsSync(oldestPath)) fs.unlinkSync(oldestPath);
  for (let index = fileCount - 1; index >= 1; index -= 1) {
    const sourcePath = logPath + "." + index;
    if (fs.existsSync(sourcePath)) fs.renameSync(sourcePath, logPath + "." + (index + 1));
  }
  if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath + ".1");
};
const readLock = (path) => {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch {
    return null;
  }
  let value;
  try {
    value = fs.readFileSync(path, "utf8");
  } catch {
    return { stat, pid: null, token: null };
  }
  try {
    let lock;
    try {
      lock = JSON.parse(value);
    } catch {
      lock = { pid: Number(value), token: null };
    }
    if (!Number.isInteger(lock.pid) || lock.pid < 1) return { stat, pid: null, token: null };
    return { stat, pid: lock.pid, token: typeof lock.token === "string" ? lock.token : null };
  } catch {
    return { stat, pid: null, token: null };
  }
};
const lockOwnerIsAlive = (owner) => {
  if (owner === null || owner.pid === null) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
const ownsLock = (path, token) => {
  const owner = readLock(path);
  return owner !== null && owner.pid === process.pid && owner.token === token;
};
const refreshLock = (path, token) => {
  if (!ownsLock(path, token)) return false;
  try {
    const now = new Date();
    fs.utimesSync(path, now, now);
  } catch {
    return false;
  }
  return ownsLock(path, token);
};
const claimExpiredLock = (path, owner) => {
  const claimedPath = path + ".reclaim-" + process.pid + "-" + crypto.randomUUID();
  try {
    fs.renameSync(path, claimedPath);
  } catch {
    return;
  }
  let claimed;
  try {
    claimed = readLock(claimedPath);
    if (claimed === null || claimed.stat.ino !== owner.stat.ino || claimed.stat.dev !== owner.stat.dev) {
      try { fs.renameSync(claimedPath, path); } catch {}
      return;
    }
    if (Date.now() - claimed.stat.mtimeMs <= appendLockStaleMs) {
      try { fs.renameSync(claimedPath, path); } catch {}
      return;
    }
    fs.unlinkSync(claimedPath);
  } catch {}
};
const createLock = (path) => {
  const token = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(path, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token }));
    return { fd, token };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(path); } catch {}
    }
    if (error.code !== "EEXIST") return -1;
    const owner = readLock(path);
    if (owner !== null && Date.now() - owner.stat.mtimeMs > appendLockStaleMs) {
      claimExpiredLock(path, owner);
    } else if (!lockOwnerIsAlive(owner)) {
      claimExpiredLock(path, owner);
    }
    return null;
  }
};
const appendWithLock = async (chunk, done, initialOffset, lockFd, lockToken) => {
  let fd;
  let offset = initialOffset;
  let retrying = false;
  if (writerBarrier !== null && writerBarrier.attemptPath && !writerAttemptPathUsed) {
    writerAttemptPathUsed = true;
    fs.writeFileSync(writerBarrier.attemptPath, "attempted");
  }
  const continueAfterLostLock = () => {
    retrying = true;
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      fd = undefined;
    }
    releaseLock(appendLockPath, lockFd, lockToken);
  };
  try {
    while (offset < chunk.length) {
      if (!refreshLock(appendLockPath, lockToken)) {
        continueAfterLostLock();
        return;
      }
      let size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      if (size >= sizeLimit) {
        if (fd !== undefined) {
          fs.closeSync(fd);
          fd = undefined;
        }
        if (!refreshLock(appendLockPath, lockToken)) {
          continueAfterLostLock();
          return;
        }
        rotate();
        size = 0;
      }
      if (!refreshLock(appendLockPath, lockToken)) {
        continueAfterLostLock();
        return;
      }
      if (fd === undefined) fd = fs.openSync(logPath, "a", 0o600);
      if (
        writerBarrier !== null &&
        writerBarrier.afterStatEnteredPath &&
        !writerAfterStatBarrierUsed
      ) {
        writerAfterStatBarrierUsed = true;
        fs.writeFileSync(
          writerBarrier.afterStatEnteredPath,
          JSON.stringify({ pid: process.pid, token: lockToken }),
        );
        await waitForFile(writerBarrier.afterStatReleasePath, lockToken);
        if (!refreshLock(appendLockPath, lockToken)) {
          continueAfterLostLock();
          return;
        }
      }
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
    releaseLock(appendLockPath, lockFd, lockToken);
    if (retrying) setTimeout(() => appendSerialized(chunk, done, offset), 10);
    else done();
  }
};
const appendSerialized = (chunk, done, initialOffset = 0) => {
  const reservation = createLock(appendLockPath);
  if (reservation === null) {
    setTimeout(() => appendSerialized(chunk, done, initialOffset), 10);
    return;
  }
  if (reservation === -1) {
    done();
    return;
  }
  const append = () => appendWithLock(chunk, done, initialOffset, reservation.fd, reservation.token);
  if (
    writerBarrier !== null &&
    writerBarrier.enteredPath &&
    !writerBarrierUsed
  ) {
    writerBarrierUsed = true;
    fs.writeFileSync(writerBarrier.enteredPath, JSON.stringify({ pid: process.pid, token: reservation.token }));
    const waitForRelease = () => {
      if (!fs.existsSync(writerBarrier.releasePath)) {
        refreshLock(appendLockPath, reservation.token);
        setTimeout(waitForRelease, 10);
        return;
      }
      append();
    };
    waitForRelease();
    return;
  }
  append();
};
const releaseLock = (path, fd, token) => {
  try { fs.closeSync(fd); } catch {}
  if (ownsLock(path, token)) {
    try { fs.unlinkSync(path); } catch {}
  }
};
const acquireLock = () => {
  const reservation = createLock(lockPath);
  if (reservation === null || reservation === -1) return reservation === -1 ? -1 : null;
  return reservation;
};
const processChunk = (chunk, startedAt, done) => {
  if (Date.now() < locklessUntil) {
    appendSerialized(chunk, done);
    return;
  }
  const lock = acquireLock();
  if (lock === null) {
    if (Date.now() - startedAt < lockWaitLimitMs) {
      setTimeout(() => processChunk(chunk, startedAt, done), 10);
      return;
    }
    locklessUntil = Date.now() + locklessPeriodMs;
    appendSerialized(chunk, done);
    return;
  }
  if (lock < 0) {
    done();
    return;
  }
  appendSerialized(chunk, () => {
    releaseLock(lockPath, lock.fd, lock.token);
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
  testWriterBarrier?: {
    enteredPath?: string;
    releasePath?: string;
    afterStatEnteredPath?: string;
    afterStatReleasePath?: string;
    attemptPath?: string;
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
    {
      detached: true,
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    },
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
