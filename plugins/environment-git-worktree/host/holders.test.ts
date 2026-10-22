import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeHolderScan, scanWorktreeHolders } from "./holders.js";

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];
const platform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-holders-"));
  roots.push(root);
  return realpath(root);
}

function hold(script: string, cwd: string, args: string[] = []) {
  const child = spawn(process.execPath, ["-e", script, ...args], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  children.push(child);
  return child;
}

describe("scanWorktreeHolders", () => {
  it("never reports an unused folder as held, and is clear only when every process could be inspected", async () => {
    const directory = await makeDirectory();
    const scan = await scanWorktreeHolders(directory);
    expect(["clear", "unknown"]).toContain(scan.status);
    if (process.platform !== "linux") expect(scan.status).toBe("unknown");
  });

  it("reports a program whose working folder is inside, without signalling it", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no holder scan on Windows");
    const directory = await makeDirectory();
    const child = hold("setTimeout(() => {}, 300_000)", directory);

    await expect
      .poll(async () => (await scanWorktreeHolders(directory)).status, {
        timeout: 10_000,
      })
      .toBe("held");
    const scan = await scanWorktreeHolders(directory);

    expect(scan).toMatchObject({
      status: "held",
      holders: [{ pid: child.pid, through: "working folder" }],
    });
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
  });

  it("reports a program that holds a file open inside the folder", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no holder scan on Windows");
    const directory = await makeDirectory();
    const elsewhere = await makeDirectory();
    const file = join(directory, "open.txt");
    await writeFile(file, "x");
    const child = hold(
      'require("node:fs").openSync(process.argv[1], "r+"); setTimeout(() => {}, 300_000)',
      elsewhere,
      [file],
    );

    await expect
      .poll(async () => (await scanWorktreeHolders(directory)).status, {
        timeout: 10_000,
      })
      .toBe("held");
    expect(await scanWorktreeHolders(directory)).toMatchObject({
      status: "held",
      holders: [{ pid: child.pid, through: "open file" }],
    });
  });

  it("is inconclusive, not clear, where the platform cannot be inspected", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const scan = await scanWorktreeHolders(await makeDirectory());
    expect(scan.status).toBe("unknown");
    expect(describeHolderScan(scan)).toContain("could not check");
  });

  it("words a held result with the program and how it holds the folder", () => {
    expect(
      describeHolderScan({
        status: "held",
        holders: [{ pid: 42, command: "node", through: "open file" }],
      }),
    ).toContain("node (pid 42, open file)");
    expect(describeHolderScan({ status: "clear" })).toBeNull();
  });
});
