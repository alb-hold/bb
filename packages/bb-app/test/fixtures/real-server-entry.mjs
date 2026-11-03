import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Server } from "node:http";
import { register } from "tsx/esm/api";

register();
if (process.env.P7_DB_CLOSE_MARKER) {
  const dbRequire = createRequire(new URL("../../../db/package.json", import.meta.url));
  const Database = dbRequire("better-sqlite3");
  const closeDatabase = Database.prototype.close;
  Database.prototype.close = function (...args) {
    if (this.name === process.env.P7_DB_PATH) {
      writeFileSync(process.env.P7_DB_CLOSE_MARKER, "closed");
    }
    return closeDatabase.apply(this, args);
  };
}
const closeServer = Server.prototype.close;
Server.prototype.close = function (...args) {
  appendFileSync(process.env.BB_RUN_SHUTDOWN_MARKER, "server-close\n");
  return closeServer.apply(this, args);
};
const { loadServerConfig } = await import("@bb/config/server");
const { runServer } = await import("../../../../apps/server/src/start-server.ts");
const config = loadServerConfig({ env: process.env, mode: "test" });
writeFileSync(process.env.BB_ORPHAN_READY, "starting");
writeFileSync(process.env.BB_SERVER_PID_FILE, String(process.pid));
await runServer(config);
