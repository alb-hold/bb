import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { spawnLoggedProcess } from "../../src/logged-process.ts";

const dir = process.env.BB_ORPHAN_DIR;
const port = Number(process.env.BB_SERVER_PORT);
const holder = spawn(process.execPath, [process.env.BB_HOLDER_ENTRY], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, BB_HOLDER_READY: process.env.BB_HOLDER_READY },
});
writeFileSync(process.env.BB_HOLDER_PID_FILE, String(holder.pid));
const server = spawnLoggedProcess({
  command: process.execPath,
  args: [process.env.BB_ORPHAN_SERVER_ENTRY],
  env: {
    ...process.env,
    BB_SERVER_PORT: String(port),
    BB_ORPHAN_MARKER: process.env.BB_ORPHAN_MARKER,
    BB_ORPHAN_PID_FILE: process.env.BB_ORPHAN_PID_FILE,
  },
  ipc: true,
  logDir: dir + "/logs",
  logName: "server",
});
writeFileSync(process.env.BB_ORPHAN_LAUNCHER_READY, String(process.pid));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.once("exit", (code, signal) => resolve({ code, signal }));
});
