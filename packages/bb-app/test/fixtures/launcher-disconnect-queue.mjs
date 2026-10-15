import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { watchLauncherDisconnect } from "../../../../apps/server/src/services/system/launcher-disconnect.ts";

const marker = process.env.BB_DISCONNECT_MARKER;
const port = new EventEmitter();
port.channel = { unref() {} };
const watch = watchLauncherDisconnect(port);
port.emit("disconnect");
watch.setShutdown({
  async shutdown() {
    appendFileSync(marker, "shutdown\n");
  },
  exit(code) {
    appendFileSync(marker, `exit:${code}\n`);
    process.exit(code);
  },
});
