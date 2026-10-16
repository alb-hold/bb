import { appendFileSync } from "node:fs";
appendFileSync(process.env.BB_HOLDER_READY, String(process.pid) + "\n");
setInterval(() => undefined, 1000);
