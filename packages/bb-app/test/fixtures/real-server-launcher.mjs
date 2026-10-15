import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { spawnLoggedProcess } from "../../src/logged-process.ts";

const dir = process.env.BB_OWNERSHIP_DIR;
const port = Number(process.env.BB_SERVER_PORT);
const agent = spawn(process.execPath, [process.env.BB_AGENT_ENTRY], {
  detached: true,
  env: { ...process.env, BB_HOLDER_READY: process.env.BB_AGENT_READY },
  stdio: "ignore",
});
writeFileSync(process.env.BB_AGENT_PID_FILE, String(agent.pid));
const holder = spawn(process.execPath, [process.env.BB_HOLDER_ENTRY], {
  detached: true,
  env: { ...process.env, BB_HOLDER_READY: process.env.BB_NATIVE_HOLDER_READY },
  stdio: "ignore",
});
writeFileSync(process.env.BB_HOLDER_PID_FILE, String(holder.pid));
const child = spawnLoggedProcess({
  command: process.execPath,
  args: ["--conditions=source", "--import", "tsx", process.env.BB_REAL_SERVER_ENTRY],
  env: {
    ...process.env,
    BB_DATA_DIR: dir,
    BB_SERVER_BIND_HOST: "127.0.0.1",
    BB_SERVER_PORT: String(port),
    BB_HOST_DAEMON_PORT: String(port + 1),
    BB_TELEMETRY: "false",
    NODE_ENV: "test",
  },
  ipc: true,
  logDir: `${dir}/logs`,
  logName: "server",
});
writeFileSync(process.env.BB_SERVER_PID_FILE, String(child.pid));
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
