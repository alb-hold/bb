import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { watchLauncherDisconnect } from "../../../../apps/server/src/services/system/launcher-disconnect.ts";

const marker = process.env.BB_ORPHAN_MARKER;
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.setHeader("x-bb-server-launch-id", process.env.BB_SERVER_LAUNCH_ID ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "x-bb-server-launch-id": process.env.BB_SERVER_LAUNCH_ID ?? "",
  });
  response.end(
    JSON.stringify({ ok: true, launchId: process.env.BB_SERVER_LAUNCH_ID }),
  );
});

server.listen(Number(process.env.BB_SERVER_PORT), "127.0.0.1", () => {
  writeFileSync(process.env.BB_ORPHAN_PID_FILE, String(process.pid));
});

process.on("SIGTERM", () => undefined);

const launcherDisconnect = watchLauncherDisconnect(process);
launcherDisconnect.setShutdown({
  shutdown: () =>
    new Promise((resolve, reject) => {
      appendFileSync(marker, "shutdown-started\n");
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        appendFileSync(marker, "shutdown-finished\n");
        resolve();
      });
      server.closeAllConnections();
    }),
  exit: (code) => process.exit(code),
});
