import { existsSync, writeFileSync } from "node:fs";
import { spawnLoggedProcess } from "../../src/logged-process.ts";

const dir = process.env.BB_OWNERSHIP_DIR;
const port = Number(process.env.BB_SERVER_PORT);
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
if (process.env.BB_DISCONNECT_MODE === "after-ready") {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
child.disconnect();
writeFileSync(process.env.BB_DISCONNECT_READY_FILE, "disconnected");
while (!existsSync(process.env.BB_LAUNCHER_RELEASE_FILE)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.exit(0);
