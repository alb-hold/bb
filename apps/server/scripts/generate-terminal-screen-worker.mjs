import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/services/terminals/terminal-screen-worker.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  write: false,
});
const directory = new URL("../src/generated/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("terminal-screen-worker.ts", directory),
  `export const terminalScreenWorkerSource = ${JSON.stringify(result.outputFiles[0].text)};\n`,
);
