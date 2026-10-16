import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnLoggedProcess } from "../../src/logged-process.ts";
import { terminateProcessIfRunning } from "../../src/launcher.ts";

const child = spawnLoggedProcess({
  command: process.execPath,
  args: [process.env.BB_SHUTDOWN_CHILD_ENTRY],
  env: {
    ...process.env,
    BB_CHILD_NAME: "server",
    BB_CHILD_STOP_DELAY_MS: "100",
    BB_IGNORE_SIGTERM: "true",
  },
  ipc: true,
  logDir: process.env.BB_SHUTDOWN_LOG_DIR,
  logName: "server",
});
const originalKill = child.kill.bind(child);
child.kill = (signal) => signal === "SIGKILL" ? true : originalKill(signal);
writeFileSync(process.env.BB_REPORT_PID_FILE, String(child.pid));
while (!existsSync(process.env.BB_SHUTDOWN_MARKER) || !readFileSync(process.env.BB_SHUTDOWN_MARKER, "utf8").includes("server:ready")) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await terminateProcessIfRunning({
  childProcess: child,
  processName: "server",
  signal: "SIGTERM",
});
process.exit(0);
