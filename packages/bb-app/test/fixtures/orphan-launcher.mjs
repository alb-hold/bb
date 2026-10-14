import { writeFileSync } from "node:fs";
import { startFullStackServerProcess } from "../../src/launcher.ts";

const port = Number(process.env.BB_SERVER_PORT);
const dataDir = process.env.BB_ORPHAN_DIR;
const context = {
  appDistDir: `${dataDir}/app/dist`,
  appVersion: "0.0.0-test",
  configFile: `${dataDir}/config.json`,
  daemonBundleDir: `${dataDir}/host-daemon/dist`,
  daemonEntry: `${dataDir}/host-daemon/dist/daemon-bundle.mjs`,
  daemonLockDir: `${dataDir}/daemon.lock.lock`,
  daemonLockFile: `${dataDir}/daemon.lock`,
  daemonPort: port + 1,
  dataDir,
  dbPath: `${dataDir}/bb.db`,
  envFile: `${dataDir}/env.json`,
  logDir: `${dataDir}/logs`,
  packageRoot: `${dataDir}/package`,
  serverEntry: process.env.BB_ORPHAN_SERVER_ENTRY,
  serverPort: port,
  serverUrl: `http://127.0.0.1:${port}`,
};
const processes = { daemonRun: null, serverRun: null };
const run = await startFullStackServerProcess({
  context,
  env: {
    BB_ORPHAN_MARKER: process.env.BB_ORPHAN_MARKER,
    BB_ORPHAN_PID_FILE: process.env.BB_ORPHAN_PID_FILE,
    BB_SERVER_PORT: String(port),
    PATH: process.env.PATH,
  },
  processes,
});
writeFileSync(
  process.env.BB_ORPHAN_LAUNCHER_READY,
  String(run.childProcess.pid),
);
await run.exit;
