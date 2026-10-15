import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageNodeModules = join(packageRoot, "node_modules");

export function createP7InstalledRuntime() {
  const buildRoot = join(packageRoot, "dist");
  if (!existsSync(join(buildRoot, "bb-app.js"))) {
    throw new Error(
      "Build bb-app before creating the installed shutdown fixture",
    );
  }
  const installedRoot = mkdtempSync(
    join(packageNodeModules, ".p7-installed-bb-app-"),
  );
  const installedDist = join(installedRoot, "dist");
  const serverDist = join(installedRoot, "server", "dist");
  const daemonDist = join(installedRoot, "host-daemon", "dist");
  const appDist = join(installedRoot, "app", "dist");
  cpSync(buildRoot, installedDist, { recursive: true });
  copyFileSync(
    join(packageRoot, "package.json"),
    join(installedRoot, "package.json"),
  );
  mkdirSync(serverDist, { recursive: true });
  mkdirSync(daemonDist, { recursive: true });
  mkdirSync(join(daemonDist, "bb-chunks"), { recursive: true });
  mkdirSync(appDist, { recursive: true });
  writeFileSync(join(appDist, "index.html"), "<html></html>");
  writeFileSync(join(daemonDist, "bb"), "#!/usr/bin/env node\n");
  chmodSync(join(daemonDist, "bb"), 0o755);
  writeFileSync(join(daemonDist, "bb-chunks", "fixture.js"), "export {};");
  for (const name of [
    "bb-provider-bridge-worker.mjs",
    "bb-parcel-watcher-child.mjs",
    "bb-plugin-host-worker.mjs",
  ]) {
    writeFileSync(join(daemonDist, name), "export {};\n");
  }
  writeFileSync(join(serverDist, "index.js"), serverStub);
  writeFileSync(join(daemonDist, "daemon-bundle.mjs"), daemonStub);
  return {
    binPath: join(installedDist, "bb-app.js"),
    cleanup() {
      rmSync(installedRoot, { force: true, recursive: true });
    },
    packageRoot: installedRoot,
  };
}

const serverStub = `
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const marker = process.env.P7_SHUTDOWN_MARKER;
const event = (name, details = {}) => appendFileSync(marker, JSON.stringify({ event: name, at: Date.now(), pid: process.pid, ...details }) + "\\n");
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(process.env.BB_SERVER_PORT), "127.0.0.1", () => event("server:ready", { hasIpc: typeof process.send === "function" }));
process.once("SIGTERM", async () => {
  event("server:received-sigterm");
  for (const phase of JSON.parse(process.env.P7_SERVER_PHASES_MS || "[]")) await new Promise(resolve => setTimeout(resolve, phase));
  await new Promise(resolve => server.close(resolve));
  event("server:shutdown-complete");
  process.exit(0);
});
process.once("exit", code => event("server:process-exit", { code, signal: null }));
setInterval(() => undefined, 1000);
`;

const daemonStub = `
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const marker = process.env.P7_SHUTDOWN_MARKER;
const event = (name, details = {}) => appendFileSync(marker, JSON.stringify({ event: name, at: Date.now(), pid: process.pid, ...details }) + "\\n");
const server = createServer((request, response) => {
  if (request.url === "/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ connected: true, hostId: process.env.BB_HOST_ID, serverUrl: process.env.BB_SERVER_URL }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(process.env.BB_HOST_DAEMON_PORT), "127.0.0.1", () => event("daemon:ready"));
process.once("SIGTERM", async () => {
  event("daemon:received-sigterm");
  await new Promise(resolve => setTimeout(resolve, Number(process.env.P7_DAEMON_DETACH_MS || 5500)));
  await new Promise(resolve => server.close(resolve));
  event("daemon:detach-acked");
  event("daemon:shutdown-complete");
  process.exit(0);
});
process.once("exit", code => event("daemon:process-exit", { code, signal: null }));
setInterval(() => undefined, 1000);
`;
