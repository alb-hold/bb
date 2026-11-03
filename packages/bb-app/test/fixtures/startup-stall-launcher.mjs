import { writeFileSync } from "node:fs";
import { spawnLoggedProcess } from "../../src/logged-process.ts";

const dir = process.env.BB_OWNERSHIP_DIR;
const child = spawnLoggedProcess({
  command: process.execPath,
  args: ["--conditions=source", "--import", "tsx", process.env.BB_REAL_SERVER_ENTRY],
  env: {
    ...process.env,
    BB_DATA_DIR: dir,
    BB_SERVER_BIND_HOST: "127.0.0.1",
    BB_TELEMETRY: "false",
    BB_SERVER_PORT: process.env.BB_SERVER_PORT,
    BB_HOST_DAEMON_PORT: String(Number(process.env.BB_SERVER_PORT) + 1),
    NODE_ENV: "test",
  },
  ipc: true,
  logDir: `${dir}/logs`,
  logName: "server",
});
writeFileSync(process.env.BB_SERVER_PID_FILE, String(child.pid));
await new Promise((resolve) => child.once("exit", resolve));
