import { writeFileSync } from "node:fs";
import { initDb } from "../../../../apps/server/src/db.ts";
import {
  SERVER_SHUTDOWN_BOUND_MS,
} from "@bb/config/full-stack-shutdown";
import {
  shutdownServerRuntime,
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
let pluginObservedDatabaseError = false;
const pluginProbe = setInterval(() => {
  try {
    db.$client.prepare("SELECT 1").get();
  } catch {
    pluginObservedDatabaseError = true;
  }
}, 25);
const startedAt = Date.now();
const result = await shutdownServerRuntime({
  closeWebSockets: async () => {},
  db,
  logger: { warn() {} },
  stopPeriodicUpdateChecks: async () => {},
  stopPlugins: () => new Promise(() => {}),
  server,
  stopTerminalDataPlane: () => {},
});
await new Promise((resolve) => setTimeout(resolve, 50));
clearInterval(pluginProbe);
let dbReadable = false;
try {
  dbReadable = db.$client.prepare("SELECT 1").get() !== undefined;
} catch {}
const databaseClosed = !dbReadable;
writeFileSync(
  process.env.BB_PLUGIN_TIMEOUT_RESULT,
  JSON.stringify({
    completedWithinBounds: result.completedWithinBounds,
    databaseClosed,
    dbReadable,
    elapsedMs: Date.now() - startedAt,
    pluginObservedDatabaseError,
    pluginStopTimedOut: result.pluginStopTimedOut,
    shutdownBoundMs: SERVER_SHUTDOWN_BOUND_MS,
  }),
);
process.exit(0);
