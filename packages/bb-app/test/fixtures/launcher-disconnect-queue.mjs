import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { watchLauncherDisconnect } from "../../../../apps/server/src/services/system/launcher-disconnect.ts";

const marker = process.env.BB_DISCONNECT_MARKER;
const port = new EventEmitter();
port.channel = { unref() {} };
const watch = watchLauncherDisconnect(port, {
  exit(code) {
    appendFileSync(marker, `exit:${code}\n`);
    process.exit(code);
  },
  log(message) {
    appendFileSync(marker, `${message}\n`);
  },
});
await watch.ready();
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
await new Promise((resolve) => setTimeout(resolve, 100));
appendFileSync(marker, "alive\n");
process.exit(0);
