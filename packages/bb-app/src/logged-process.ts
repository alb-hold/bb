import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const stdioLogSizeLimit = 10 * 1024 * 1024;
const stdioLogFileCount = 5;

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
  let currentSize = existsSync(logPath) ? statSync(logPath).size : 0;
  let fd = openSync(logPath, "a", 0o600);

  const rotate = () => {
    closeSync(fd);
    const oldestPath = `${logPath}.${stdioLogFileCount}`;
    if (existsSync(oldestPath)) unlinkSync(oldestPath);
    for (let index = stdioLogFileCount - 1; index >= 1; index -= 1) {
      const sourcePath = `${logPath}.${index}`;
      if (!existsSync(sourcePath)) continue;
      renameSync(sourcePath, `${logPath}.${index + 1}`);
    }
    if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
    fd = openSync(logPath, "a", 0o600);
    currentSize = 0;
  };

  const append = (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (currentSize >= stdioLogSizeLimit) rotate();
      const length = Math.min(
        stdioLogSizeLimit - currentSize,
        chunk.length - offset,
      );
      const written = writeSync(fd, chunk, offset, length);
      if (written === 0) throw new Error("Unable to write stdio log");
      offset += written;
      currentSize += written;
    }
  };

  const child = spawn(args.command, args.args, {
    cwd: process.cwd(),
    env: args.env,
    stdio:
      args.ipc === true
        ? ["ignore", "pipe", "pipe", "ipc"]
        : ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("close", () => {
    closeSync(fd);
  });
  return child;
}
