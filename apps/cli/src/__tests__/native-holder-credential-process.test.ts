import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeHolderFrame,
  connectNativeHolder,
  encodeNativeHolderFrame,
} from "../native-holder.js";
import { readNativeToolCredentialFromSocket } from "../native-tool-credential.js";

const SECRET = "process-level-secret-ABC123xyz";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function credentialDirsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("bb-nc-"));
}

function filesHolding(dir: string, secret: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...filesHolding(full, secret));
    else if (entry.isFile() && readFileSync(full, "utf8").includes(secret)) {
      hits.push(full);
    }
  }
  return hits;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function argvOf(pid: number): string {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
}

async function until(
  check: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

interface RealHolder {
  child: ChildProcess;
  cliPid: number;
  dir: string;
  socket: string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

async function startRealHolder(
  reapAfterMs: number,
  startupDelayMs = 0,
): Promise<RealHolder> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bb-nc-proc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "thr_proc-1.sock");
  const holderModule = pathToFileURL(
    path.join(import.meta.dirname, "..", "native-holder.ts"),
  ).href;
  const script = `const { runNativeHolder, ignoreNativeHolderSignals } = await import(${JSON.stringify(holderModule)});
const nodePty = await import("node-pty");
ignoreNativeHolderSignals(process);
await new Promise((resolve) => setTimeout(resolve, ${startupDelayMs}));
const code = await runNativeHolder({
  socketPath: ${JSON.stringify(socket)},
  credentialRoot: ${JSON.stringify(dir)},
  reapAfterMs: ${reapAfterMs},
  onSocketReady: () => process.stdout.write("holder-ready\\n"),
  cwd: ${JSON.stringify(dir)},
  env: { PATH: process.env.PATH },
  prepare: async () => ({ command: "sh", args: ["-c", "sleep 300"] }),
  spawnPty: (child, options) => {
    const pty = nodePty.spawn(child.command, child.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    process.stdout.write("cli-pid:" + pty.pid + "\\n");
    return pty;
  },
});
process.stdout.write("holder-exit:" + code + "\\n");
process.exit(code);`;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: path.join(import.meta.dirname, "..", ".."),
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  let output = "";
  const outputWaiters: Array<{
    pattern: RegExp;
    resolve: (match: RegExpMatchArray) => void;
    reject: (error: Error) => void;
  }> = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    for (const waiter of [...outputWaiters]) {
      const match = output.match(waiter.pattern);
      if (match !== null) {
        outputWaiters.splice(outputWaiters.indexOf(waiter), 1);
        waiter.resolve(match);
      }
    }
  });
  const waitForOutput = (pattern: RegExp): Promise<RegExpMatchArray> => {
    const match = output.match(pattern);
    if (match !== null) return Promise.resolve(match);
    return new Promise((resolve, reject) => {
      outputWaiters.push({ pattern, resolve, reject });
    });
  };
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  child.once("exit", (code, signal) => {
    for (const waiter of outputWaiters.splice(0)) {
      waiter.reject(
        new Error(`holder exited before ${waiter.pattern}: ${code}/${signal}`),
      );
    }
  });
  await waitForOutput(/holder-ready/u);
  const client = await connectNativeHolder(socket);
  if (client === null)
    throw new Error(`holder did not accept connection: ${output}`);
  cleanups.push(() => client.destroy());
  client.write(
    encodeNativeHolderFrame(NativeHolderFrame.credential, Buffer.from(SECRET)),
  );
  client.write(
    encodeNativeHolderFrame(
      NativeHolderFrame.resize,
      Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
    ),
  );
  const match = await waitForOutput(/cli-pid:(\d+)/u);
  if (reapAfterMs < 1_000) client.destroy();
  return { child, cliPid: Number(match[1]), dir, socket, exited };
}

describe("native holder credential cleanup, real processes", () => {
  it("serves the credential, keeps it out of argv and temp files, and removes its directory when the CLI is hung up", async () => {
    const holder = await startRealHolder(600_000);
    const holderPid = holder.child.pid ?? 0;
    expect(await until(() => credentialDirsIn(holder.dir).length === 1)).toBe(
      true,
    );
    const [name] = credentialDirsIn(holder.dir);
    const credentialSocket = path.join(holder.dir, name ?? "", "s");
    expect(await until(() => existsSync(credentialSocket))).toBe(true);
    expect(await readNativeToolCredentialFromSocket(credentialSocket)).toBe(
      SECRET,
    );
    expect(argvOf(holderPid)).not.toContain(SECRET);
    expect(argvOf(holder.cliPid)).not.toContain(SECRET);
    expect(filesHolding(holder.dir, SECRET)).toEqual([]);

    process.kill(holderPid, "SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(holderPid)).toBe(true);
    expect(existsSync(credentialSocket)).toBe(true);

    process.kill(holder.cliPid, "SIGHUP");
    const result = await holder.exited;
    expect(result.signal).toBeNull();
    expect(result.code).not.toBeNull();
    expect(await until(() => credentialDirsIn(holder.dir).length === 0)).toBe(
      true,
    );
    expect(existsSync(credentialSocket)).toBe(false);
    expect(existsSync(holder.socket)).toBe(false);
    expect(filesHolding(holder.dir, SECRET)).toEqual([]);
  }, 30_000);

  it("removes its directory when the holder reaps a detached CLI with SIGHUP", async () => {
    const holder = await startRealHolder(300);
    const result = await holder.exited;
    expect(result.signal).toBeNull();
    expect(await until(() => credentialDirsIn(holder.dir).length === 0)).toBe(
      true,
    );
    expect(existsSync(holder.socket)).toBe(false);
    expect(alive(holder.cliPid)).toBe(false);
    expect(filesHolding(holder.dir, SECRET)).toEqual([]);
  }, 30_000);

  it("waits for the holder's ready signal when the holder starts late", async () => {
    const holder = await startRealHolder(300, 10_100);
    expect(existsSync(holder.socket)).toBe(true);
    expect(alive(holder.cliPid)).toBe(true);
  }, 30_000);
});
