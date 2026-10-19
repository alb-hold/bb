import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const logPath = process.argv[1];
const writerBarrier = process.argv[2] ? JSON.parse(process.argv[2]) : null;
const sizeLimit = 10 * 1024 * 1024;
const retainedBackups = 5;
const maxWriteAttempts = 3;
const retryDelayMs = 10;
const maxChunkRetryMs = 2_000;
const recoveryIntervalMs = writerBarrier?.recoveryIntervalMs ?? 1_000;
const recoveryPlatform = writerBarrier?.recoveryPlatform ?? process.platform;
const errorCode = (error) => typeof error?.code === "string" ? error.code : "UNKNOWN";
const reportDiagnostic = (message) => {
  try {
    fs.writeSync(2, Buffer.from("[bb] " + message + "\\n"));
  } catch (error) {
    const diagnosticErrorCode = errorCode(error);
    if (diagnosticErrorCode === "EPIPE") return;
  }
};
const reportFsError = (operation, error) => reportDiagnostic(operation + ": " + errorCode(error));
const fingerprint = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
const readProcStartTime = (pid) => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const startTime = stat.slice(close + 2).trim().split(/\\s+/)[19];
    return /^\\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
};
const readPsStartTime = (pid) => {
  try {
    const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 1_000,
    }).trim();
    return startTime || undefined;
  } catch {
    return undefined;
  }
};
const readProcessIdentity = (pid) => {
  if (process.platform === "linux" && writerBarrier?.forcePsIdentity !== true) {
    const startTime = readProcStartTime(pid);
    if (startTime !== undefined) return { source: 1, fingerprint: fingerprint(startTime) };
  }
  const startTime = readPsStartTime(pid);
  if (startTime !== undefined) return { source: 2, fingerprint: fingerprint(startTime) };
  return { source: 0, fingerprint: "0000000000000000" };
};
const ownerIdentity = writerBarrier?.ownerIdentity ?? readProcessIdentity(process.pid);
if (writerBarrier?.ownerIdentitySource !== undefined) ownerIdentity.source = writerBarrier.ownerIdentitySource;
const ownerPid = writerBarrier?.ownerIdentity?.pid ?? process.pid;
const socketToken = crypto.randomUUID();
let pipeToken = socketToken;
const token = ownerPid + "-" + ownerIdentity.source + "-" + ownerIdentity.fingerprint + "-" + socketToken;
const familyPrefix = logPath + ".";
const familyHash = crypto.createHash("sha256").update(path.resolve(logPath) + "-" + (process.getuid?.() ?? process.env.USERNAME ?? "")).digest("hex").slice(0, 12);
const socketPathLimit = 103;
const socketDirName = ".bb-stdio-" + familyHash;
let socketDir;
let socketPath;
let socketDirectoryAvailable = process.platform === "win32";
let livenessEndpointAvailable = false;
let livenessEndpointWasBound = false;
let livenessSocketIdentity;
let livenessEndpointRecoveryPromise;
let livenessRecoveryDiagnosticReported = false;
let activePath;
const rejectSocketDirectory = (message) => {
  const error = new Error(message);
  error.code = "EACCES";
  throw error;
};
if (process.platform !== "win32") {
  const candidateDir = path.join("/tmp", socketDirName);
  const candidateSocketPath = path.join(candidateDir, "s-" + socketToken);
  if (Buffer.byteLength(candidateSocketPath) <= socketPathLimit) {
    try {
      try {
        fs.mkdirSync(candidateDir, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(candidateDir);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        process.getuid === undefined ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o7777) !== 0o700
      ) {
        rejectSocketDirectory("stdio liveness directory is not an owned 0700 directory");
      }
      socketDir = candidateDir;
      socketPath = candidateSocketPath;
      socketDirectoryAvailable = true;
    } catch (error) {
      reportFsError("stdio liveness directory rejected", error);
    }
  }
  if (!socketDirectoryAvailable) {
    reportDiagnostic("stdio liveness endpoint unavailable; using process identity recovery");
  }
}
if (process.platform === "win32") {
  socketPath = "\\\\\\\\.\\\\pipe\\\\bb-stdio-" + familyHash + "-" + pipeToken;
}
const livenessServer = net.createServer((connection) => connection.destroy());
const livenessReady = new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  if (!socketDirectoryAvailable) {
    finish();
    return;
  }
  const onListenError = (error) => {
    livenessEndpointAvailable = false;
    reportFsError("stdio liveness endpoint setup failed", error);
    if (!livenessEndpointWasBound) socketDirectoryAvailable = false;
    finish();
  };
  livenessServer.on("error", onListenError);
  try {
    livenessServer.listen(socketPath, () => {
      livenessEndpointWasBound = true;
      if (process.platform === "win32") {
        livenessEndpointAvailable = true;
      } else {
        livenessSocketIdentity = socketFileState();
        livenessEndpointAvailable = livenessSocketIdentity.trusted;
      }
      finish();
    });
  } catch (error) {
    onListenError(error);
  }
});
const socketFileState = () => {
  if (process.platform === "win32" || socketPath === undefined) return { exists: false, trusted: false };
  try {
    const stat = fs.lstatSync(socketPath);
    return {
      exists: true,
      trusted:
        !stat.isSymbolicLink() &&
        stat.isSocket() &&
        process.getuid !== undefined &&
        stat.uid === process.getuid(),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, trusted: false };
    return { exists: true, trusted: false };
  }
};
const socketFileStateAt = (socketFilePath) => {
  if (process.platform === "win32") return { exists: false, trusted: false };
  try {
    const stat = fs.lstatSync(socketFilePath);
    return {
      exists: true,
      trusted:
        !stat.isSymbolicLink() &&
        stat.isSocket() &&
        process.getuid !== undefined &&
        stat.uid === process.getuid(),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, trusted: false };
    return { exists: true, trusted: false };
  }
};
const sameSocketFile = (left, right) => left?.trusted === true && right?.trusted === true && left.dev === right.dev && left.ino === right.ino;
const socketDirectoryIsTrusted = () => {
  try {
    const stat = fs.lstatSync(socketDir);
    return !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      process.getuid !== undefined &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o7777) === 0o700;
  } catch {
    return false;
  }
};
const ensureSocketDirectory = () => {
  try {
    fs.mkdirSync(socketDir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") return false;
  }
  return socketDirectoryIsTrusted();
};
const ensureLivenessEndpoint = () => {
  if (finalized || inputEnded || !socketDirectoryAvailable || socketPath === undefined) {
    return Promise.resolve();
  }
  if (process.platform !== "win32" && (socketDir === undefined || !ensureSocketDirectory())) {
    livenessEndpointAvailable = false;
    if (!livenessRecoveryDiagnosticReported) {
      reportDiagnostic("stdio liveness directory unavailable; endpoint rebind skipped");
      livenessRecoveryDiagnosticReported = true;
    }
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    if (livenessServer.listening) {
      livenessEndpointAvailable = true;
      return Promise.resolve();
    }
    if (livenessEndpointRecoveryPromise !== undefined) return livenessEndpointRecoveryPromise;
    livenessEndpointRecoveryPromise = new Promise((resolveListen) => {
      if (livenessEndpointWasBound) {
        pipeToken = crypto.randomUUID();
        socketPath = "\\\\\\\\.\\\\pipe\\\\bb-stdio-" + familyHash + "-" + pipeToken;
      }
      const onListenError = (error) => {
        livenessEndpointAvailable = false;
        reportFsError("stdio liveness endpoint rebind failed", error);
        resolveListen();
      };
      livenessServer.once("error", onListenError);
      try {
        livenessServer.listen(socketPath, () => {
          livenessServer.off("error", onListenError);
          livenessEndpointWasBound = true;
          livenessEndpointAvailable = true;
          refreshActivePathForSocketIdentity();
          resolveListen();
        });
      } catch (error) {
        livenessServer.off("error", onListenError);
        onListenError(error);
      }
    }).finally(() => {
      livenessEndpointRecoveryPromise = undefined;
    });
    return livenessEndpointRecoveryPromise;
  }
  const currentIdentity = socketFileState();
  if (livenessServer.listening && sameSocketFile(currentIdentity, livenessSocketIdentity)) {
    livenessEndpointAvailable = true;
    refreshActivePathForSocketIdentity();
    return Promise.resolve();
  }
  if (currentIdentity.exists && !sameSocketFile(currentIdentity, livenessSocketIdentity)) {
    livenessEndpointAvailable = false;
    if (!livenessRecoveryDiagnosticReported) {
      reportDiagnostic("stdio liveness socket path is not owned by the writer; endpoint rebind skipped");
      livenessRecoveryDiagnosticReported = true;
    }
    return Promise.resolve();
  }
  if (livenessEndpointRecoveryPromise !== undefined) return livenessEndpointRecoveryPromise;
  livenessEndpointRecoveryPromise = (async () => {
    try {
      if (livenessServer.listening) {
        await new Promise((resolveClose) => {
          livenessServer.close((error) => {
            if (error) reportFsError("stdio liveness endpoint close failed", error);
            resolveClose();
          });
        });
      }
      const remainingIdentity = socketFileState();
      if (remainingIdentity.exists) {
        if (!livenessEndpointWasBound || !sameSocketFile(remainingIdentity, livenessSocketIdentity)) {
          livenessEndpointAvailable = false;
          return;
        }
        fs.unlinkSync(socketPath);
      }
      await new Promise((resolveListen) => {
        const onListenError = (error) => {
          livenessEndpointAvailable = false;
          reportFsError("stdio liveness endpoint rebind failed", error);
          resolveListen();
        };
        livenessServer.once("error", onListenError);
        try {
          livenessServer.listen(socketPath, () => {
            livenessServer.off("error", onListenError);
            livenessEndpointWasBound = true;
            livenessSocketIdentity = socketFileState();
            livenessEndpointAvailable = livenessSocketIdentity.trusted;
            refreshActivePathForSocketIdentity();
            resolveListen();
          });
        } catch (error) {
          livenessServer.off("error", onListenError);
          reportFsError("stdio liveness endpoint rebind failed", error);
          livenessEndpointAvailable = false;
          resolveListen();
        }
      });
    } catch (error) {
      livenessEndpointAvailable = false;
      reportFsError("stdio liveness endpoint recovery failed", error);
    }
  })().finally(() => {
    livenessEndpointRecoveryPromise = undefined;
  });
  return livenessEndpointRecoveryPromise;
};
let recoveryPromise;
let initializationPromise;
let activeFd;
let activeSize = 0;
let aliasSequence = 0;
let writerBarrierUsed = false;
let postRenameBarrierUsed = false;
let pruneSnapshotBarrierUsed = false;
let initialized = false;
let processing = false;
let inputPaused = false;
let inputEnded = false;
let finalized = false;
let retryTimer;
let recoveryTimer;
let periodicRecoveryPromise;
let writeAttempts = 0;
let chunkRetryStartedAt;
let pendingOffset = 0;
let pendingLossBytes = 0;
let pendingLossErrno = "";
let pendingLossMarker;
let pendingLossMarkerOffset = 0;
let finalizationAttempts = 0;
const pendingChunks = [];
let pendingBytes = 0;
const maxPendingBytes = 16 * 1024 * 1024;
const backupPattern = /^.+\\.backup-[0-9]+-[0-9]+-[a-f0-9-]+$/;
const activePattern = /^.+\\.active-[0-9]+-[012]-[a-f0-9]{16}-(?:[en]-)?[a-f0-9-]+(?:-i-[0-9]+-[0-9]+|-p-[a-f0-9-]+)?$/;
const paths = () => fs.readdirSync(path.dirname(logPath)).map((name) => path.join(path.dirname(logPath), name));
const socketPathForToken = (value) => recoveryPlatform === "win32"
  ? "\\\\\\\\.\\\\pipe\\\\bb-stdio-" + familyHash + "-" + value
  : socketDir === undefined ? undefined : path.join(socketDir, "s-" + value);
const ownerProcessHoldsSegment = (pid, segmentPath) => {
  try {
    if (process.platform === "darwin") {
      const segmentStat = fs.statSync(segmentPath, { bigint: true });
      const output = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-F", "pDfi", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 750,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      let processFound = false;
      let device;
      let inode;
      for (const line of output.split(/\\r?\\n/)) {
        if (line === "p" + pid) {
          processFound = true;
        } else if (line.startsWith("f")) {
          device = undefined;
          inode = undefined;
        } else if (line.startsWith("D")) {
          device = BigInt(line.slice(1));
        } else if (line.startsWith("i")) {
          inode = BigInt(line.slice(1));
        }
        if (
          device === segmentStat.dev &&
          inode === segmentStat.ino
        ) {
          return true;
        }
      }
      if (!processFound) {
        reportDiagnostic("stdio segment holder check inconclusive: lsof omitted process");
        return undefined;
      }
      return false;
    }
    if (process.platform === "linux") {
      const descriptorDirectory = "/proc/" + pid + "/fd";
      let segmentStat;
      try {
        segmentStat = fs.statSync(segmentPath);
      } catch (error) {
        reportFsError("stdio segment holder check inconclusive", error);
        return undefined;
      }
      for (const descriptor of fs.readdirSync(descriptorDirectory)) {
        try {
          const descriptorStat = fs.statSync(path.join(descriptorDirectory, descriptor));
          if (descriptorStat.dev === segmentStat.dev && descriptorStat.ino === segmentStat.ino) return true;
        } catch (error) {
          if (error.code !== "ENOENT") {
            reportFsError("stdio segment holder check inconclusive", error);
            return undefined;
          }
        }
      }
      return false;
    }
    return undefined;
  } catch (error) {
    if (error.status === 1 && !String(error.stderr ?? "").trim()) return false;
    const failure = typeof error.status === "number" ? "EXIT_" + error.status : errorCode(error);
    reportDiagnostic("stdio segment holder check inconclusive: " + failure);
    return undefined;
  }
};
const probeOwnerSocketOnce = (ownerSocketPath) => new Promise((resolve) => {
  const client = net.createConnection(ownerSocketPath);
  let settled = false;
  const timer = setTimeout(() => finish(undefined), 500);
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.destroy();
    resolve(result);
  };
  client.once("connect", () => finish(true));
  client.once("error", (error) => {
    if (error.code === "ECONNREFUSED") {
      finish(false);
    } else {
      finish(undefined);
    }
  });
});
const probeOwnerPipeOnce = (ownerPipePath, ownerToken) => {
  const injected = writerBarrier?.pipeProbeResultsByToken?.[ownerToken];
  if (injected !== undefined) {
    if (injected.length === 0) return Promise.resolve(undefined);
    const result = injected.shift();
    return Promise.resolve(result === "connected" ? true : result === "ENOENT" ? false : undefined);
  }
  const fallback = writerBarrier?.pipeProbeResults;
  if (Array.isArray(fallback) && fallback.length > 0) {
    const result = fallback.shift();
    return Promise.resolve(result === "connected" ? true : result === "ENOENT" ? false : undefined);
  }
  return new Promise((resolve) => {
    const client = net.createConnection(ownerPipePath);
    let settled = false;
    const timer = setTimeout(() => finish(undefined), 500);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };
    client.once("connect", () => finish(true));
    client.once("error", (error) => finish(error.code === "ENOENT" ? false : undefined));
  });
};
const probeOwnerPipe = async (ownerToken) => {
  const ownerPipePath = socketPathForToken(ownerToken);
  if (ownerPipePath === undefined) return undefined;
  const refusalWindowMs = Math.max(1_500, recoveryIntervalMs + 500);
  const startedAt = Date.now();
  let notFoundCount = 0;
  while (Date.now() - startedAt < refusalWindowMs) {
    const result = await probeOwnerPipeOnce(ownerPipePath, ownerToken);
    if (result === true || result === undefined) return result;
    notFoundCount += 1;
    if (Date.now() - startedAt < refusalWindowMs) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return notFoundCount >= 2 ? false : undefined;
};
const probeOwnerSocket = async (value, expectedIdentity, ownerPid, segmentPath) => {
  const ownerSocketPath = socketPathForToken(value);
  if (ownerSocketPath === undefined || expectedIdentity === undefined) return undefined;
  if (writerBarrier?.unreadableOwnerSocketTokens?.includes(value)) {
    return undefined;
  }
  const sameRecordedSocket = () => {
    if (!socketDirectoryIsTrusted()) return false;
    const current = socketFileStateAt(ownerSocketPath);
    return current.trusted && current.dev === expectedIdentity.dev && current.ino === expectedIdentity.ino;
  };
  if (!sameRecordedSocket()) return undefined;
  const refusalWindowMs = Math.max(1_500, recoveryIntervalMs + 500);
  const refusalRetryDelayMs = 200;
  const startedAt = Date.now();
  let refusals = 0;
  while (Date.now() - startedAt < refusalWindowMs) {
    if (!sameRecordedSocket()) return undefined;
    const result = await probeOwnerSocketOnce(ownerSocketPath);
    if (result === true) return true;
    if (result !== false) return undefined;
    const ownerHoldsSegment = ownerProcessHoldsSegment(ownerPid, segmentPath);
    if (ownerHoldsSegment === true) return true;
    if (ownerHoldsSegment === undefined) return undefined;
    refusals += 1;
    if (Date.now() - startedAt < refusalWindowMs) {
      await new Promise((resolve) => setTimeout(resolve, refusalRetryDelayMs));
    }
  }
  if (refusals < 2 || !sameRecordedSocket()) return undefined;
  const ownerHoldsSegment = ownerProcessHoldsSegment(ownerPid, segmentPath);
  return ownerHoldsSegment === false ? false : ownerHoldsSegment === true ? true : undefined;
};
const uniqueBackupPath = () => familyPrefix + "backup-" + Date.now() + "-" + token + "-" + crypto.randomUUID();
const makeInjectedFailure = (operation) => {
  const error = new Error("injected stdio " + operation + " failure");
  error.code = "EIO";
  return error;
};
const openSync = fs.openSync;
fs.openSync = (filePath, ...args) => {
  if (filePath === activePath && writerBarrier !== null && writerBarrier.failActiveOpenCount > 0) {
    writerBarrier.failActiveOpenCount -= 1;
    throw makeInjectedFailure("active open");
  }
  return openSync(filePath, ...args);
};
const writeSync = fs.writeSync;
fs.writeSync = (fd, ...args) => {
  if (fd === activeFd && writerBarrier !== null && writerBarrier.failActiveWriteCount > 0) {
    writerBarrier.failActiveWriteCount -= 1;
    throw makeInjectedFailure("active append");
  }
  return writeSync(fd, ...args);
};
const publishAliasTo = (targetPath) => {
  const temporary = logPath + ".alias-" + token + "-" + (++aliasSequence);
  try {
    fs.linkSync(targetPath, temporary);
    try {
      fs.renameSync(temporary, logPath);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "EPERM") reportFsError("stdio alias replace failed", error);
      try {
        fs.unlinkSync(logPath);
        fs.renameSync(temporary, logPath);
      } catch (replaceError) {
        reportFsError("stdio alias publish failed", replaceError);
      }
    }
  } catch (error) {
    reportFsError("stdio alias link failed", error);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") reportFsError("stdio alias cleanup failed", cleanupError);
    }
  }
};
const pruneBackups = () => {
  let noProgressScans = 0;
  let previousBackupCount;
  let rescanPending = false;
  let pruneUnlinkAttempt = 0;
  while (true) {
    let backupPaths;
    try {
      backupPaths = paths().filter((file) => file.startsWith(familyPrefix) && backupPattern.test(path.basename(file)));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        reportFsError("stdio backup scan failed", error);
        return;
      }
      reportFsError("stdio backup scan failed", error);
      return;
    }
    let backups;
    try {
      backups = backupPaths.map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }));
    } catch (error) {
      if (error.code === "ENOENT") {
        rescanPending = true;
        continue;
      }
      reportFsError("stdio backup scan failed", error);
      return;
    }
    backups.sort((left, right) => left.mtimeMs - right.mtimeMs);
    backups = backups.map(({ file }) => file);
    if (rescanPending) {
      noProgressScans = previousBackupCount !== undefined && backups.length < previousBackupCount
        ? 0
        : noProgressScans + 1;
      if (noProgressScans >= 32) {
        reportDiagnostic("stdio backup prune made no progress");
        return;
      }
      rescanPending = false;
    }
    previousBackupCount = backups.length;
    if (pruneSnapshotBarrierUsed && writerBarrier?.pruneObservedCountsPath !== undefined) {
      fs.appendFileSync(writerBarrier.pruneObservedCountsPath, String(backups.length) + "\\n");
    }
    if (backups.length <= retainedBackups) return;
    if (
      !pruneSnapshotBarrierUsed &&
      writerBarrier?.pruneSnapshotEnteredPath !== undefined &&
      writerBarrier.pruneSnapshotReleasePath !== undefined
    ) {
      pruneSnapshotBarrierUsed = true;
      fs.writeFileSync(writerBarrier.pruneSnapshotEnteredPath, String(backups.length));
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(writerBarrier.pruneSnapshotReleasePath)) Atomics.wait(waitCell, 0, 0, 10);
    }
    if (pruneSnapshotBarrierUsed && writerBarrier?.pruneObservedCountsPath !== undefined) {
      fs.appendFileSync(writerBarrier.pruneObservedCountsPath, String(backups.length) + "\\n");
    }
    const oldest = backups[0];
    if (
      writerBarrier?.pruneUnlinkAttemptPath !== undefined &&
      writerBarrier.pruneUnlinkReleasePath !== undefined
    ) {
      pruneUnlinkAttempt += 1;
      const attemptPath = writerBarrier.pruneUnlinkAttemptPath + "." + pruneUnlinkAttempt;
      fs.writeFileSync(attemptPath, oldest);
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      const releasePath = writerBarrier.pruneUnlinkReleasePath + "." + pruneUnlinkAttempt;
      while (!fs.existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 10);
    }
    try {
      const aliasStat = fs.statSync(logPath);
      const oldestStat = fs.statSync(oldest);
      if (aliasStat.dev === oldestStat.dev && aliasStat.ino === oldestStat.ino) {
        const replacement = paths()
          .filter((file) => file !== oldest && (activePattern.test(path.basename(file)) || backupPattern.test(path.basename(file))))
          .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
        if (replacement !== undefined) publishAliasTo(replacement);
        else fs.unlinkSync(logPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") reportFsError("stdio alias retention update failed", error);
    }
    try {
      fs.unlinkSync(oldest);
    } catch (error) {
      if (error.code === "ENOENT") {
        rescanPending = true;
        continue;
      }
      reportFsError("stdio backup prune failed", error);
      return;
    }
    noProgressScans = 0;
    rescanPending = false;
  }
};
const migrateLegacyFiles = () => {
  const baseName = path.basename(logPath);
  const numberedBackups = paths().filter((file) => {
    const name = path.basename(file);
    const suffix = name.slice(baseName.length + 1);
    return name.startsWith(baseName + ".") && /^[1-9][0-9]*$/.test(suffix);
  }).sort((left, right) => Number(path.basename(right).slice(baseName.length + 1)) - Number(path.basename(left).slice(baseName.length + 1)));
  const candidates = [...numberedBackups, logPath];
  for (const sourcePath of candidates) {
    if (!fs.existsSync(sourcePath)) continue;
    let sourceFd;
    let backupFd;
    try {
      const sourceStat = fs.statSync(sourcePath);
      const alreadySegmented = paths().some((file) => {
        if (file === sourcePath || (!activePattern.test(path.basename(file)) && !backupPattern.test(path.basename(file))) || !fs.existsSync(file)) return false;
        const candidateStat = fs.statSync(file);
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
          const backupPath = uniqueBackupPath();
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
    } catch (error) {
      reportFsError("legacy stdio migration failed", error);
      if (sourceFd !== undefined) {
        try {
          fs.closeSync(sourceFd);
        } catch (closeError) {
          reportFsError("legacy stdio source close failed", closeError);
        }
      }
      if (backupFd !== undefined) {
        try {
          fs.closeSync(backupFd);
        } catch (closeError) {
          reportFsError("legacy stdio backup close failed", closeError);
        }
      }
      throw error;
    }
  }
  pruneBackups();
};
const recoverClosedSegments = async () => {
  if (recoveryPromise !== undefined) return recoveryPromise;
  recoveryPromise = (async () => {
    await livenessReady;
    for (const file of paths()) {
      const name = path.basename(file);
      if (!file.startsWith(familyPrefix) || file === activePath || !activePattern.test(name)) continue;
      const ownerParts = name.slice(name.indexOf(".active-") + 8).split("-");
      const ownerPid = Number(ownerParts[0]);
      const ownerSource = Number(ownerParts[1]);
      const ownerFingerprint = ownerParts[2];
      const hasEndpointFlag = ownerParts[3] === "e" || ownerParts[3] === "n";
      const endpointAvailable = hasEndpointFlag && ownerParts[3] === "e";
      const socketIdentityMarker = ownerParts.length - 3;
      const pipeIdentityMarker = ownerParts.length - 6;
      const hasSocketIdentity = endpointAvailable && socketIdentityMarker > 4 && ownerParts[socketIdentityMarker] === "i";
      const hasPipeIdentity = endpointAvailable && pipeIdentityMarker > 4 && ownerParts[pipeIdentityMarker] === "p";
      const ownerSocketIdentity = hasSocketIdentity
        ? { dev: Number(ownerParts[ownerParts.length - 2]), ino: Number(ownerParts[ownerParts.length - 1]) }
        : undefined;
      const ownerPipeToken = hasPipeIdentity ? ownerParts.slice(pipeIdentityMarker + 1).join("-") : undefined;
      const ownerUuid = ownerParts.slice(hasEndpointFlag ? 4 : 3, hasSocketIdentity ? socketIdentityMarker : hasPipeIdentity ? pipeIdentityMarker : undefined).join("-");
      if (!Number.isInteger(ownerPid) || ownerPid < 1 || ownerUuid.length === 0) continue;
      let recover = false;
      try {
        process.kill(ownerPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          recover = true;
        } else if (error.code !== "EPERM") {
          reportFsError("stdio segment owner check failed", error);
          continue;
        }
      }
      if (!recover) {
        if (endpointAvailable && recoveryPlatform === "win32" && ownerPipeToken !== undefined) {
          const pipeAlive = await probeOwnerPipe(ownerPipeToken);
          if (pipeAlive === true) continue;
          if (pipeAlive === false) recover = true;
        } else if (endpointAvailable && recoveryPlatform !== "win32") {
          const socketAlive = await probeOwnerSocket(ownerUuid, ownerSocketIdentity, ownerPid, file);
          if (socketAlive === true) continue;
          if (socketAlive === false) recover = true;
        }
        if (!recover && recoveryPlatform === "win32") continue;
        if (!recover) {
          const currentIdentity = writerBarrier?.recoveryIdentity ?? readProcessIdentity(ownerPid);
          if (
            ownerSource > 0 &&
            currentIdentity.source === ownerSource &&
            currentIdentity.fingerprint !== ownerFingerprint
          ) {
            recover = true;
          } else {
            const ownerHoldsSegment = ownerProcessHoldsSegment(ownerPid, file);
            if (ownerHoldsSegment === true) continue;
            if (ownerHoldsSegment === false) {
              recover = true;
            } else {
              continue;
            }
          }
        }
      }
      if (recover) {
        try {
          fs.renameSync(file, uniqueBackupPath());
          pruneBackups();
          try {
            const staleSocketPath = socketPathForToken(ownerUuid);
            if (staleSocketPath !== undefined) fs.unlinkSync(staleSocketPath);
          } catch (socketError) {
            if (socketError.code !== "ENOENT") reportFsError("stale stdio owner socket cleanup failed", socketError);
          }
        } catch (renameError) {
          if (renameError.code !== "ENOENT") reportFsError("orphan stdio segment recovery failed", renameError);
        }
      }
    }
    pruneBackups();
  })().finally(() => {
    recoveryPromise = undefined;
  });
  return recoveryPromise;
};
const createActive = () => {
  const endpointFlag = livenessEndpointAvailable ? "e" : "n";
  const socketIdentity = endpointFlag !== "e" ? "" : recoveryPlatform === "win32"
    ? "-p-" + pipeToken
    : livenessSocketIdentity?.trusted ? "-i-" + livenessSocketIdentity.dev + "-" + livenessSocketIdentity.ino : "";
  activePath = familyPrefix + "active-" + ownerPid + "-" + ownerIdentity.source + "-" + ownerIdentity.fingerprint + "-" + endpointFlag + "-" + socketToken + socketIdentity;
  activeFd = fs.openSync(activePath, "wx", 0o600);
  activeSize = fs.fstatSync(activeFd).size;
  publishAliasTo(activePath);
};
function refreshActivePathForSocketIdentity() {
  if (activeFd === undefined || activePath === undefined) return;
  if (recoveryPlatform !== "win32" && !livenessSocketIdentity?.trusted) return;
  const endpointIdentity = recoveryPlatform === "win32"
    ? "-p-" + pipeToken
    : "-i-" + livenessSocketIdentity.dev + "-" + livenessSocketIdentity.ino;
  const nextPath = familyPrefix + "active-" + ownerPid + "-" + ownerIdentity.source + "-" + ownerIdentity.fingerprint + "-e-" + socketToken + endpointIdentity;
  if (nextPath === activePath) return;
  try {
    fs.renameSync(activePath, nextPath);
    activePath = nextPath;
    publishAliasTo(activePath);
  } catch (error) {
    reportFsError("stdio active segment socket identity update failed", error);
  }
}
const ensureInitialized = () => {
  if (initialized) return Promise.resolve();
  if (initializationPromise !== undefined) return initializationPromise;
  initializationPromise = (async () => {
    await livenessReady;
    migrateLegacyFiles();
    await recoverClosedSegments();
    createActive();
    initialized = true;
  })().finally(() => {
    initializationPromise = undefined;
  });
  return initializationPromise;
};
const closeActive = (archive) => {
  if (activeFd !== undefined) {
    fs.closeSync(activeFd);
    activeFd = undefined;
  }
  if (archive && activePath !== undefined && fs.existsSync(activePath)) {
    fs.renameSync(activePath, uniqueBackupPath());
    if (
      !postRenameBarrierUsed &&
      writerBarrier?.postRenameEnteredPath !== undefined &&
      writerBarrier.postRenameReleasePath !== undefined
    ) {
      postRenameBarrierUsed = true;
      fs.writeFileSync(writerBarrier.postRenameEnteredPath, "renamed");
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(writerBarrier.postRenameReleasePath)) Atomics.wait(waitCell, 0, 0, 10);
    }
    pruneBackups();
  }
};
const closeLivenessServer = async () => {
  if (livenessEndpointRecoveryPromise !== undefined) await livenessEndpointRecoveryPromise;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (process.platform === "win32" || socketDir === undefined || socketPath === undefined) {
        resolve();
        return;
      }
      if (!socketDirectoryIsTrusted()) {
        resolve();
        return;
      }
      const socketInfo = socketFileState();
      if (socketInfo.exists && sameSocketFile(socketInfo, livenessSocketIdentity)) {
        try {
          fs.unlinkSync(socketPath);
        } catch (error) {
          if (error.code !== "ENOENT") {
            reject(error);
            return;
          }
        }
      } else if (socketInfo.exists && !livenessRecoveryDiagnosticReported) {
        reportDiagnostic("stdio liveness socket cleanup skipped for an untrusted path");
        livenessRecoveryDiagnosticReported = true;
      }
      try {
        fs.rmdirSync(socketDir);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") {
          reject(error);
          return;
        }
      }
      resolve();
    };
    if (!livenessServer.listening) {
      cleanup();
      return;
    }
    livenessServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        cleanup();
      }
    });
  });
};
const rotateOwnedSegment = async () => {
  closeActive(true);
  await recoverClosedSegments();
  createActive();
};
const appendBuffer = async (buffer, startOffset, kind) => {
  let offset = startOffset;
  while (offset < buffer.length) {
    await ensureInitialized();
    if (activeFd === undefined) createActive();
    if (activeSize >= sizeLimit) await rotateOwnedSegment();
    const length = Math.min(sizeLimit - activeSize, buffer.length - offset);
    if (kind === "output" && writerBarrier !== null && !writerBarrierUsed && writerBarrier.pauseAtBytes !== undefined && activeSize >= writerBarrier.pauseAtBytes) {
      writerBarrierUsed = true;
      fs.writeFileSync(writerBarrier.enteredPath, "entered");
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(writerBarrier.releasePath)) Atomics.wait(waitCell, 0, 0, 10);
    }
    const startingSize = activeSize;
    try {
      const written = fs.writeSync(activeFd, buffer, offset, length);
      if (written <= 0) throw new Error("stdio segment write made no progress");
      offset += written;
      activeSize += written;
    } catch (error) {
      try {
        const observedSize = fs.fstatSync(activeFd).size;
        const observedProgress = Math.max(0, observedSize - startingSize);
        if (observedProgress <= length) {
          activeSize = observedSize;
          offset += observedProgress;
        } else {
          reportDiagnostic("stdio segment size changed unexpectedly during failed append");
        }
      } catch (statError) {
        reportFsError("stdio segment size recovery failed", statError);
      }
      const failure = new Error("stdio " + kind + " append failed", { cause: error });
      failure.code = errorCode(error);
      failure.writerKind = kind;
      failure.writerOffset = offset;
      throw failure;
    }
  }
  return offset;
};
const writePendingLossMarker = async () => {
  if (pendingLossBytes === 0) return;
  if (pendingLossMarker === undefined) pendingLossMarker = Buffer.from("[bb] " + pendingLossBytes + " bytes of child output lost: " + pendingLossErrno + "\\n");
  pendingLossMarkerOffset = await appendBuffer(pendingLossMarker, pendingLossMarkerOffset, "marker");
  pendingLossBytes = 0;
  pendingLossErrno = "";
  pendingLossMarker = undefined;
  pendingLossMarkerOffset = 0;
};
const resumeInputIfDrained = () => {
  if (inputPaused && pendingBytes < maxPendingBytes / 2) {
    inputPaused = false;
    process.stdin.resume();
  }
};
const dequeueChunk = (chunk) => {
  pendingChunks.shift();
  pendingBytes -= chunk.length;
  pendingOffset = 0;
  writeAttempts = 0;
  chunkRetryStartedAt = undefined;
  resumeInputIfDrained();
};
const scheduleRetry = (delayMs = retryDelayMs) => {
  processing = false;
  if (retryTimer !== undefined || finalized) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void processNext();
  }, delayMs);
};
const finishStream = async () => {
  if (finalized) return;
  clearInterval(recoveryTimer);
  try {
    if (writerBarrier?.finalizationEnteredPath !== undefined) {
      fs.writeFileSync(writerBarrier.finalizationEnteredPath, String(process.pid));
      while (
        writerBarrier.finalizationReleasePath !== undefined &&
        !fs.existsSync(writerBarrier.finalizationReleasePath)
      ) {
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(waitCell, 0, 0, 10);
      }
    }
    if (periodicRecoveryPromise !== undefined) await periodicRecoveryPromise;
    if (pendingLossBytes > 0) await writePendingLossMarker();
    closeActive(true);
    await closeLivenessServer();
    if (writerBarrier?.completionPath !== undefined) {
      fs.writeFileSync(writerBarrier.completionPath, "done");
    }
    finalized = true;
  } catch (error) {
    finalizationAttempts += 1;
    reportFsError("stdio finalization retry " + finalizationAttempts + "/" + maxWriteAttempts, error);
    scheduleRetry(Math.min(1_000, retryDelayMs * Math.max(1, finalizationAttempts)));
  }
};
const processNext = async () => {
  if (processing || finalized) return;
  processing = true;
  const chunk = pendingChunks[0];
  if (chunk === undefined) {
    if (inputEnded) {
      await finishStream();
      processing = false;
      return;
    }
    processing = false;
    return;
  }
  if (chunkRetryStartedAt === undefined) chunkRetryStartedAt = Date.now();
  try {
    await ensureInitialized();
    await writePendingLossMarker();
    pendingOffset = await appendBuffer(chunk, pendingOffset, "output");
    dequeueChunk(chunk);
    processing = false;
    setImmediate(() => void processNext());
  } catch (error) {
    const code = errorCode(error);
    if (error.writerKind === "marker") pendingLossMarkerOffset = error.writerOffset;
    if (error.writerKind === "output") pendingOffset = error.writerOffset;
    writeAttempts += 1;
    if (writeAttempts <= maxWriteAttempts) reportFsError("stdio output retry " + writeAttempts + "/" + maxWriteAttempts, error);
    if (writeAttempts < maxWriteAttempts || Date.now() - chunkRetryStartedAt < maxChunkRetryMs) {
      const delayMs = writeAttempts < maxWriteAttempts ? retryDelayMs : 100;
      if (writeAttempts >= maxWriteAttempts) writeAttempts = 0;
      scheduleRetry(delayMs);
      return;
    }
    const lostBytes = Math.max(0, chunk.length - pendingOffset);
    dequeueChunk(chunk);
    pendingLossBytes += lostBytes;
    pendingLossErrno = code;
    if (lostBytes > 0) reportDiagnostic(lostBytes + " bytes of child output lost: " + code);
    processing = false;
    setImmediate(() => void processNext());
  }
};
void ensureInitialized().catch((error) => reportFsError("stdio writer setup failed", error));
process.stdin.on("data", (chunk) => {
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;
  if (!inputPaused && pendingBytes >= maxPendingBytes) {
    inputPaused = true;
    process.stdin.pause();
  }
  void processNext();
});
process.stdin.on("end", () => {
  inputEnded = true;
  void processNext();
});
process.stdin.on("error", (error) => {
  reportFsError("stdio input stream failed", error);
  inputEnded = true;
  void processNext();
});
process.stderr.on("error", (error) => {
  const diagnosticErrorCode = errorCode(error);
  if (diagnosticErrorCode !== "EPIPE") reportFsError("stdio diagnostic stream failed", error);
});
process.on("uncaughtException", (error) => {
  reportFsError("uncaught stdio writer error", error);
  processing = false;
  scheduleRetry();
});
recoveryTimer = setInterval(() => {
  if (finalized || inputEnded || periodicRecoveryPromise !== undefined) return;
  try {
    if (activeFd !== undefined) {
      const now = new Date();
      fs.futimesSync(activeFd, now, now);
    }
    periodicRecoveryPromise = ensureLivenessEndpoint()
      .then(() => recoverClosedSegments())
      .catch((error) => reportFsError("stdio periodic segment recovery failed", error))
      .finally(() => {
        periodicRecoveryPromise = undefined;
      });
  } catch (error) {
    reportFsError("stdio periodic segment recovery failed", error);
  }
}, recoveryIntervalMs);
recoveryTimer.unref();
`;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
  logDir: string;
  logName: "server" | "host-daemon";
  testWriterBarrier?: StdioLogWriterTestBarrier;
}

export interface LoggedChildProcess extends ChildProcess {
  readonly writerProcess: ChildProcess;
  readonly writerExit: Promise<void>;
}

export interface StdioLogWriterTestBarrier {
  enteredPath?: string;
  releasePath?: string;
  pauseAtBytes?: number;
  failActiveOpenCount?: number;
  failActiveWriteCount?: number;
  recoveryIntervalMs?: number;
  unreadableOwnerSocketTokens?: string[];
  recoveryPlatform?: NodeJS.Platform;
  pipeProbeResults?: Array<"ENOENT" | "connected" | "busy">;
  pipeProbeResultsByToken?: Record<
    string,
    Array<"ENOENT" | "connected" | "busy">
  >;
  recoveryIdentity?: {
    source: 0 | 1 | 2;
    fingerprint: string;
  };
  ownerIdentity?: {
    pid: number;
    source: 0 | 1 | 2;
    fingerprint: string;
  };
  ownerIdentitySource?: 0 | 1 | 2;
  forcePsIdentity?: boolean;
  writerEnv?: Partial<
    Pick<NodeJS.ProcessEnv, "LC_ALL" | "NODE_OPTIONS" | "TMPDIR" | "TZ">
  >;
  diagnosticPath?: string;
  completionPath?: string;
  finalizationEnteredPath?: string;
  finalizationReleasePath?: string;
  postRenameEnteredPath?: string;
  postRenameReleasePath?: string;
  pruneSnapshotEnteredPath?: string;
  pruneSnapshotReleasePath?: string;
  pruneObservedCountsPath?: string;
  pruneUnlinkAttemptPath?: string;
  pruneUnlinkReleasePath?: string;
}

export function spawnLoggedProcess(
  args: SpawnLoggedProcessArgs,
): LoggedChildProcess {
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
      env: { ...process.env, ...args.testWriterBarrier?.writerEnv },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  logWriter.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    if (args.testWriterBarrier?.diagnosticPath !== undefined) {
      try {
        appendFileSync(args.testWriterBarrier.diagnosticPath, chunk);
      } catch (error) {
        process.stderr.write(
          `[bb] could not capture stdio writer diagnostic: ${String(error)}\n`,
        );
      }
    }
  });
  const writerExit = new Promise<void>((resolvePromise) => {
    logWriter.once("exit", () => {
      resolvePromise();
    });
    logWriter.on("error", () => {
      if (logWriter.pid === undefined) resolvePromise();
    });
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
  return Object.assign(child, { writerExit, writerProcess: logWriter });
}
