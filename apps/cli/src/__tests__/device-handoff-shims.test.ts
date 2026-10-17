import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  copyFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const shimSource = new URL("../../bin/", import.meta.url);

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createFixture(): Promise<{
  directory: string;
  shimBin: string;
  realBin: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bb-device-handoff-"));
  fixtures.push(directory);
  const shimBin = join(directory, "shim-bin");
  const realBin = join(directory, "real-bin");
  await mkdir(shimBin);
  await mkdir(realBin);
  for (const name of [
    "bb-device-handoff-shim",
    "pbcopy",
    "open",
    "xdg-open",
    "bb-browser",
  ]) {
    await copyFile(new URL(name, shimSource), join(shimBin, name));
    await chmod(join(shimBin, name), 0o755);
  }
  await writeFile(join(shimBin, "bb"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { directory, shimBin, realBin };
}

describe("device handoff command shims", () => {
  it("tees pbcopy input to the real tool and preserves its status when bb is unreachable", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const copiedPath = join(directory, "real-pbcopy-input");
    const realPbcopy = join(realBin, "pbcopy");
    await writeFile(realPbcopy, `#!/bin/sh\ncat > '${copiedPath}'\nexit 23\n`, {
      mode: 0o755,
    });
    await chmod(realPbcopy, 0o755);
    const result = spawnSync(join(shimBin, "pbcopy"), [], {
      env: { ...process.env, PATH: `${shimBin}:${realBin}:/usr/bin:/bin` },
      input: "clipboard fixture",
    });

    expect(result.status).toBe(23);
    expect(await readFile(copiedPath, "utf8")).toBe("clipboard fixture");
  });
});
