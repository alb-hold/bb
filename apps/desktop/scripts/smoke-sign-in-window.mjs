import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertElectronRuntime } from "./assert-electron-runtime.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const workDir = await mkdtemp(join(tmpdir(), "bb-sign-in-smoke-"));
try {
  const fixture = join(workDir, "fixture.cjs");
  await build({
    entryPoints: [join(packageRoot, "test/fixtures/sign-in-window-smoke.ts")],
    outfile: fixture,
    bundle: true,
    platform: "node",
    format: "cjs",
    conditions: ["source"],
    external: ["electron"],
    legalComments: "none",
  });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const electron = require("electron");
  assertElectronRuntime(electron);
  const resultPath = join(workDir, "result.json");
  const child = spawn(
    electron,
    [`--user-data-dir=${join(workDir, "user-data")}`, fixture, resultPath],
    { cwd: workDir, env: environment, stdio: "inherit" },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0)
    throw new Error(`Electron smoke failed with exit ${exitCode}`);
  console.log(await readFile(resultPath, "utf8"));
} finally {
  await rm(workDir, { recursive: true, force: true });
}
