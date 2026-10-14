import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnLoggedProcess } from "../../src/logged-process.ts";
import { terminateManagedFullStackProcesses } from "../../src/launcher.ts";

const marker = process.env.BB_SHUTDOWN_MARKER;
writeFileSync(marker, "");
const logDir = process.env.BB_SHUTDOWN_LOG_DIR;
const entry = process.env.BB_SHUTDOWN_CHILD_ENTRY;
const serverChild = spawnLoggedProcess({
  command: process.execPath,
  args: [entry],
  env: {
    ...process.env,
    BB_CHILD_NAME: "server",
    BB_CHILD_STOP_DELAY_MS: "3500",
  },
  ipc: true,
  logDir,
  logName: "server",
});
const daemonChild = spawnLoggedProcess({
  command: process.execPath,
  args: [entry],
  env: {
    ...process.env,
    BB_CHILD_NAME: "daemon",
    BB_CHILD_STOP_DELAY_MS: "3500",
  },
  logDir,
  logName: "host-daemon",
});
writeFileSync(process.env.BB_SERVER_CHILD_PID_FILE, String(serverChild.pid));
writeFileSync(process.env.BB_DAEMON_CHILD_PID_FILE, String(daemonChild.pid));
const makeRun = (processName, childProcess) => ({
  processName,
  exit: new Promise((resolve) => {
    childProcess.once("exit", (code, signal) =>
      resolve({ processName, result: { code, signal } }),
    );
  }),
  terminate(signal) {
    if (!childProcess.killed) childProcess.kill(signal);
    return this.exit;
  },
});
const processes = {
  daemonRun: makeRun("daemon", daemonChild),
  serverRun: makeRun("server", serverChild),
};
while (true) {
  const text = readFileSync(marker, "utf8");
  if (text.includes("server:ready") && text.includes("daemon:ready")) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.on("SIGTERM", () => {
  void terminateManagedFullStackProcesses({
    processes,
    signal: "SIGTERM",
  }).then(() => {
    appendFileSync(marker, "launcher:stopped\n");
    process.exit(0);
  });
});
appendFileSync(marker, "launcher:ready\n");
