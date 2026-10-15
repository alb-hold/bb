import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hasProcessExited, waitForProcessExit } from "@bb/config/child-process-exit";
import { runBbApp, runLauncherEntry } from "../../src/launcher.ts";

const marker = process.env.P7_SHUTDOWN_MARKER;
const appendEvent = (event, details = {}) => {
  appendFileSync(
    marker,
    `${JSON.stringify({ event, at: Date.now(), pid: process.pid, ...details })}\n`,
  );
};

async function startManagedProcess(args) {
  appendEvent(args.processName + ':factory-start');
  const childProgram = `
const role = ${JSON.stringify(args.processName)};
const marker = process.env.P7_SHUTDOWN_MARKER;
const appendEvent = (event, details = {}) => require('node:fs').appendFileSync(marker, JSON.stringify({ event, at: Date.now(), pid: process.pid, ...details }) + '\\n');
const phases = JSON.parse(process.env.P7_SERVER_PHASES_MS || '[]');
let stopping = false;
if (role === 'server') {
  require('node:http').createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID || 'test' }));
      return;
    }
    response.writeHead(404);
    response.end();
  }).listen(Number(process.env.P7_SERVER_PORT || process.env.BB_SERVER_PORT || 41188), '127.0.0.1', () => {
    appendEvent(role + ':ready');
    process.send?.('ready');
  });
} else {
  appendEvent(role + ':ready');
  process.send?.('ready');
}
process.on('SIGTERM', async () => {
  if (stopping) return;
  stopping = true;
  appendEvent(role + ':received-sigterm');
  if (role === 'daemon') await new Promise(resolve => setTimeout(resolve, Number(process.env.P7_DAEMON_DETACH_MS)));
  else for (const phase of phases) await new Promise(resolve => setTimeout(resolve, phase));
  if (role === 'daemon') appendEvent('daemon:detach-acked');
  appendEvent(role + ':shutdown-complete');
  process.exit(0);
});
setInterval(() => undefined, 1000);
`;
  const child = spawn(process.execPath, ["--eval", childProgram], {
    detached: process.env.P7_DETACHED_CHILDREN === "true",
    env: { ...process.env, ...args.env },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  await new Promise((resolve, reject) => {
    child.once("message", (message) => {
      if (message === "ready") resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`managed ${args.processName} exited before ready: ${String(code)} ${String(signal)}`));
    });
  });
  const exit = waitForProcessExit(child).then((result) => {
    appendEvent(args.processName + ':exit', result);
    return { processName: args.processName, result };
  });
  return {
    exit,
    async terminate(signal) {
      appendEvent(args.processName + ':terminate-requested', { signal });
      if (!hasProcessExited(child)) child.kill(signal);
      await exit;
    },
  };
}

process.once("exit", (code) => appendEvent("launcher:exit", { code }));
runLauncherEntry(() =>
  runBbApp(
    [
      "start",
      "--data-dir",
      process.env.BB_DATA_DIR,
      "--server-port",
      process.env.P7_SERVER_PORT || "41188",
      "--host-daemon-port",
      process.env.P7_DAEMON_PORT || "41189",
      "--no-in-app-updates",
    ],
    { startManagedProcess, worktreePolicy: null },
  ),
);
