import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const logPath = process.argv[1];
const sizeLimit = 10 * 1024 * 1024;
const fileCount = 5;
for (let index = 0; index <= fileCount; index += 1) {
  const filePath = index === 0 ? logPath : logPath + "." + index;
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > sizeLimit) {
    fs.unlinkSync(filePath);
  }
}
let size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
let fd = fs.openSync(logPath, "a", 0o600);
const rotate = () => {
  fs.closeSync(fd);
  const oldestPath = logPath + "." + fileCount;
  if (fs.existsSync(oldestPath)) fs.unlinkSync(oldestPath);
  for (let index = fileCount - 1; index >= 1; index -= 1) {
    const sourcePath = logPath + "." + index;
    if (fs.existsSync(sourcePath)) fs.renameSync(sourcePath, logPath + "." + (index + 1));
  }
  if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath + ".1");
  fd = fs.openSync(logPath, "a", 0o600);
  size = 0;
};
process.stdin.on("data", (chunk) => {
  let offset = 0;
  while (offset < chunk.length) {
    if (size >= sizeLimit) rotate();
    const length = Math.min(sizeLimit - size, chunk.length - offset);
    const written = fs.writeSync(fd, chunk, offset, length);
    if (written === 0) throw new Error("Unable to write stdio log");
    offset += written;
    size += written;
  }
});
process.stdin.on("end", () => fs.closeSync(fd));
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
