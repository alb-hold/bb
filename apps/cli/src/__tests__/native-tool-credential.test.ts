import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeHolderFrame,
  nativeHolderCredentialSocketPath,
  encodeNativeHolderFrame,
  runNativeHolder,
  waitForNativeHolder,
  type NativeHolderPty,
} from "../native-holder.js";
import {
  readNativeToolCredentialFromSocket,
  takeNativeToolCredentialFromEnv,
  withSocketCredential,
} from "../native-tool-credential.js";

const SECRET = "secret-credential-value-XYZ";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workDir(): { dir: string; socket: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bb-nc-"));
  roots.push(dir);
  return { dir, socket: path.join(dir, "thr_abc-1.sock") };
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

function fakePty(): NativeHolderPty & { exit(code: number): void } {
  let exitListener: (event: { exitCode: number }) => void = () => undefined;
  return {
    pid: 1,
    onData: () => undefined,
    onExit: (listener) => {
      exitListener = listener;
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => exitListener({ exitCode: 129 }),
    exit: (code) => exitListener({ exitCode: code }),
  };
}

function resizeFrame(): Buffer {
  return encodeNativeHolderFrame(
    NativeHolderFrame.resize,
    Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
  );
}

async function readUntil(
  credentialSocket: string,
  expected: string,
): Promise<string> {
  let last = "";
  for (let i = 0; i < 50; i += 1) {
    last = await readNativeToolCredentialFromSocket(credentialSocket).catch(
      () => "",
    );
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

async function untilGone(file: string): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    try {
      statSync(file);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("native tool credential delivery", () => {
  it("keeps the secret in memory, serves it over a 0600 socket, rotates it and leaves nothing on disk", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    let prepared: string | null = null;
    const done = runNativeHolder({
      socketPath: socket,
      cwd: dir,
      env: {},
      prepare: async ({ credential }) => {
        prepared = credential;
        return { command: "x", args: [] };
      },
      spawnPty: () => pty,
    });
    const client = await waitForNativeHolder(socket, 5_000);
    if (client === null) throw new Error("holder did not start");
    client.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.credential,
        Buffer.from(SECRET),
      ),
    );
    client.write(resizeFrame());
    const credentialSocket = nativeHolderCredentialSocketPath(socket);
    expect(statSync(credentialSocket).mode & 0o777).toBe(0o600);
    expect(await readUntil(credentialSocket, SECRET)).toBe(SECRET);
    expect(prepared).toBe(SECRET);
    expect(filesHolding(dir, SECRET)).toEqual([]);

    client.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.credential,
        Buffer.from("rotated-value"),
      ),
    );
    expect(await readUntil(credentialSocket, "rotated-value")).toBe(
      "rotated-value",
    );

    pty.exit(0);
    expect(await done).toBe(0);
    expect(await untilGone(credentialSocket)).toBe(true);
    expect(filesHolding(dir, SECRET)).toEqual([]);
    expect(filesHolding(dir, "rotated-value")).toEqual([]);
    client.destroy();
  });

  it("removes the credential socket when preparing the CLI throws", async () => {
    const { dir, socket } = workDir();
    const done = runNativeHolder({
      socketPath: socket,
      cwd: dir,
      env: {},
      prepare: async () => {
        throw new Error("launch refused");
      },
      spawnPty: () => fakePty(),
    });
    const client = await waitForNativeHolder(socket, 5_000);
    if (client === null) throw new Error("holder did not start");
    client.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.credential,
        Buffer.from(SECRET),
      ),
    );
    client.write(resizeFrame());
    client.on("error", () => undefined);
    expect(await done).toBe(1);
    expect(await untilGone(nativeHolderCredentialSocketPath(socket))).toBe(
      true,
    );
    expect(filesHolding(dir, SECRET)).toEqual([]);
  });

  it("removes the credential socket when the holder stops the CLI with a hangup", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    const done = runNativeHolder({
      socketPath: socket,
      cwd: dir,
      env: {},
      reapAfterMs: 30,
      prepare: async () => ({ command: "x", args: [] }),
      spawnPty: () => pty,
    });
    const client = await waitForNativeHolder(socket, 5_000);
    if (client === null) throw new Error("holder did not start");
    client.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.credential,
        Buffer.from(SECRET),
      ),
    );
    client.write(resizeFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.destroy();
    expect(await done).toBe(129);
    expect(await untilGone(nativeHolderCredentialSocketPath(socket))).toBe(
      true,
    );
    expect(filesHolding(dir, SECRET)).toEqual([]);
  });

  it("refuses to serve before any credential arrived", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    const done = runNativeHolder({
      socketPath: socket,
      cwd: dir,
      env: {},
      prepare: async () => ({ command: "x", args: [] }),
      spawnPty: () => pty,
    });
    const client: net.Socket | null = await waitForNativeHolder(socket, 5_000);
    await expect(
      readNativeToolCredentialFromSocket(
        nativeHolderCredentialSocketPath(socket),
      ),
    ).rejects.toThrow();
    client?.write(resizeFrame());
    await new Promise((resolve) => setTimeout(resolve, 100));
    pty.exit(0);
    await done;
    client?.destroy();
  });

  it("takes the credential out of the environment so child processes never inherit it", () => {
    const env: NodeJS.ProcessEnv = {
      BB_NATIVE_TOOL_CREDENTIAL: "from-daemon",
      PATH: "/bin",
    };
    expect(takeNativeToolCredentialFromEnv(env)).toBe("from-daemon");
    expect(env.BB_NATIVE_TOOL_CREDENTIAL).toBeUndefined();
    expect(takeNativeToolCredentialFromEnv({ PATH: "/bin" })).toBeNull();
  });

  it("sends the holder's current credential as a bearer header on every request", async () => {
    const { dir } = workDir();
    const credentialSocket = path.join(dir, "c");
    let current = "first";
    const server = net.createServer((socket) => socket.end(current));
    await new Promise<void>((resolve) =>
      server.listen(credentialSocket, resolve),
    );
    const seen: string[] = [];
    const wrapped = withSocketCredential(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("{}");
      }) as typeof fetch,
      credentialSocket,
    );
    await wrapped("http://x/y", { headers: { "content-type": "text/plain" } });
    current = "rotated";
    await wrapped("http://x/y");
    server.close();
    expect(seen).toEqual(["Bearer first", "Bearer rotated"]);
  });
});
