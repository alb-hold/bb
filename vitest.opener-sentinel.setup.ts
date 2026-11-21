import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

export const URL_OPENER_NAMES = [
  "open",
  "xdg-open",
  "sensible-browser",
] as const;
const SENTINEL_PREFIX = "bb-opener-sentinel-";

const directory = mkdtempSync(join(tmpdir(), SENTINEL_PREFIX));
const logPath = join(directory, "calls.log");
for (const name of URL_OPENER_NAMES) {
  const path = join(directory, name);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${logPath}'\nexit 99\n`,
  );
  chmodSync(path, 0o755);
}

const inherited = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((entry) => !entry.includes(SENTINEL_PREFIX));
process.env.PATH = [directory, ...inherited].join(delimiter);

afterAll(() => {
  let calls = "";
  try {
    calls = readFileSync(logPath, "utf8");
  } catch {
    calls = "";
  }
  rmSync(directory, { recursive: true, force: true });
  process.env.PATH = inherited.join(delimiter);
  if (calls !== "") {
    throw new Error(
      `A test reached a real URL opener (${URL_OPENER_NAMES.join(", ")}). Stub the opener in that test:\n${calls}`,
    );
  }
});
