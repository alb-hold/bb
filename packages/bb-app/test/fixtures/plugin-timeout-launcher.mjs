import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--conditions=source", "--import", "tsx", process.env.BB_REAL_SERVER_ENTRY],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
let output = "";
const outputPath = process.env.BB_SERVER_CHILD_OUTPUT;
child.stdout?.on("data", (chunk) => {
  output += chunk.toString();
  appendFileSync(outputPath, chunk);
});
child.stderr?.on("data", (chunk) => {
  output += chunk.toString();
  appendFileSync(outputPath, chunk);
});
child.stdout?.on("error", () => {});
child.stderr?.on("error", () => {});
writeFileSync(outputPath, "");
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    writeFileSync(outputPath, output);
    resolve({ code, signal });
  });
});
