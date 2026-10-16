import { writeFileSync } from "node:fs";
import { initDb } from "../../../../apps/server/src/db.ts";
import {
  SERVER_SHUTDOWN_BOUND_MS,
} from "@bb/config/full-stack-shutdown";
import {
  shutdownHttpBeforePlugins,
  startHttpListener,
} from "../../../../apps/server/src/start-server.ts";

const db = initDb(":memory:");
const server = startHttpListener({
  fetch: async () => new Response("ready"),
  logger: { warn: () => {} },
  serverConfig: {
    BB_SERVER_BIND_HOST: "127.0.0.1",
    BB_SERVER_PORT: 0,
  },
});
await new Promise((resolve) => server.once("listening", resolve));
let databaseClosed = false;
let pluginObservedDatabaseError = false;
const pluginProbe = setInterval(() => {
  try {
    db.$client.prepare("SELECT 1").get();
  } catch {
    pluginObservedDatabaseError = true;
  }
}, 25);
const startedAt = Date.now();
const result = await shutdownHttpBeforePlugins({
  closeDatabase: () => {
    databaseClosed = true;
    db.$client.close();
  },
  closeWebSockets: async () => {},
  server,
  stopPlugins: () => new Promise(() => {}),
  stopTerminalDataPlane: () => {},
});
if (result?.pluginStopTimedOut !== true) {
  databaseClosed = true;
  db.$client.close();
}
await new Promise((resolve) => setTimeout(resolve, 50));
clearInterval(pluginProbe);
let dbReadable = false;
try {
  dbReadable = !databaseClosed && db.$client.prepare("SELECT 1").get() !== undefined;
} catch {}
writeFileSync(
  process.env.BB_PLUGIN_TIMEOUT_RESULT,
  JSON.stringify({
    completedWithinBounds: result?.completedWithinBounds ?? false,
    databaseClosed,
    dbReadable,
    elapsedMs: Date.now() - startedAt,
    pluginObservedDatabaseError,
    pluginStopTimedOut: result?.pluginStopTimedOut ?? false,
    shutdownBoundMs: SERVER_SHUTDOWN_BOUND_MS,
  }),
);
process.exit(0);
