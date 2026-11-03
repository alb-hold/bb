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
  const dir = mkdtempSync(path.join(os.tmpdir(), "bb-nc-t-"));
  roots.push(dir);
  return { dir, socket: path.join(dir, "thr_abc-1.sock") };
}

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

function credentialFrame(value: string): Buffer {
  return encodeNativeHolderFrame(
    NativeHolderFrame.credential,
    Buffer.from(value),
  );
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    await pause(20);
  }
  return last;
}

async function noCredentialDirs(dir: string): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (credentialDirsIn(dir).length === 0) return true;
    await pause(20);
  }
  return false;
}

interface PrepareContext {
  credential: string | null;
  credentialSocket: string;
}

function startHolder(
  dir: string,
  socket: string,
  pty: NativeHolderPty,
  extra: {
    prepare?: (
      context: PrepareContext,
    ) => Promise<{ command: string; args: string[] }>;
    reapAfterMs?: number;
  } = {},
): Promise<number> {
  return runNativeHolder({
    socketPath: socket,
    credentialRoot: dir,
    cwd: dir,
    env: {},
    ...(extra.reapAfterMs === undefined
      ? {}
      : { reapAfterMs: extra.reapAfterMs }),
    prepare: extra.prepare ?? (async () => ({ command: "x", args: [] })),
    spawnPty: () => pty,
  });
}

describe("native tool credential delivery", () => {
  it("keeps the secret in memory, serves it over a 0600 socket in a private directory, rotates it and leaves nothing on disk", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    let prepared: string | null = null;
    let credentialSocket = "";
    const done = startHolder(dir, socket, pty, {
      prepare: async (context) => {
        prepared = context.credential;
        credentialSocket = context.credentialSocket;
        return { command: "x", args: [] };
      },
    });
    const client = await waitForNativeHolder(socket, 5_000);
    if (client === null) throw new Error("holder did not start");
    client.write(credentialFrame(SECRET));
    client.write(resizeFrame());
    const guessed = path.join(dir, credentialDirsIn(dir)[0] ?? "", "s");
    expect(await readUntil(guessed, SECRET)).toBe(SECRET);
    expect(credentialSocket).toBe(guessed);
    expect(statSync(credentialSocket).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(credentialSocket)).mode & 0o777).toBe(0o700);
    expect(prepared).toBe(SECRET);
    expect(filesHolding(dir, SECRET)).toEqual([]);

    client.write(credentialFrame("rotated-value"));
    expect(await readUntil(credentialSocket, "rotated-value")).toBe(
      "rotated-value",
    );

    pty.exit(0);
    expect(await done).toBe(0);
    expect(await noCredentialDirs(dir)).toBe(true);
    expect(filesHolding(dir, SECRET)).toEqual([]);
    expect(filesHolding(dir, "rotated-value")).toEqual([]);
    client.destroy();
  });

  it("never exposes the socket to group or other users, even under umask 000", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    const previous = process.umask(0o000);
    const observations: string[] = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        for (const name of credentialDirsIn(dir)) {
          const credentialDir = path.join(dir, name);
          try {
            const dirMode = statSync(credentialDir).mode & 0o777;
            if (dirMode & 0o077) {
              observations.push(`dir ${dirMode.toString(8)}`);
            }
            const socketMode = statSync(path.join(credentialDir, "s")).mode;
            if (socketMode & 0o077) {
              observations.push(`socket ${(socketMode & 0o777).toString(8)}`);
            }
          } catch {
            continue;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      const done = startHolder(dir, socket, pty);
      const client = await waitForNativeHolder(socket, 5_000);
      if (client === null) throw new Error("holder did not start");
      client.write(credentialFrame(SECRET));
      client.write(resizeFrame());
      await pause(100);
      const [name] = credentialDirsIn(dir);
      expect(name).toBeDefined();
      expect(statSync(path.join(dir, name ?? "")).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, name ?? "", "s")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      pty.exit(0);
      await done;
      client.destroy();
    } finally {
      watching = false;
      process.umask(previous);
    }
    await watcher;
    expect(observations).toEqual([]);
    expect(await noCredentialDirs(dir)).toBe(true);
  });

  it("removes the credential directory when preparing the CLI throws", async () => {
    const { dir, socket } = workDir();
    const done = startHolder(dir, socket, fakePty(), {
      prepare: async () => {
        throw new Error("launch refused");
      },
    });
    const client = await waitForNativeHolder(socket, 5_000);
    if (client === null) throw new Error("holder did not start");
    client.on("error", () => undefined);
    client.write(credentialFrame(SECRET));
    client.write(resizeFrame());
    expect(await done).toBe(1);
    expect(await noCredentialDirs(dir)).toBe(true);
    expect(filesHolding(dir, SECRET)).toEqual([]);
  });

  it("removes the credential directory when the holder stops the CLI with a hangup", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    const done = startHolder(dir, socket, pty, { reapAfterMs: 30 });
    const client = await waitForNativeHolder(socket, 5_000);
    if (client === null) throw new Error("holder did not start");
    client.write(credentialFrame(SECRET));
    client.write(resizeFrame());
    await pause(20);
    client.destroy();
    expect(await done).toBe(129);
    expect(await noCredentialDirs(dir)).toBe(true);
    expect(filesHolding(dir, SECRET)).toEqual([]);
  });

  it("refuses to serve before any credential arrived", async () => {
    const { dir, socket } = workDir();
    const pty = fakePty();
    const done = startHolder(dir, socket, pty);
    const client: net.Socket | null = await waitForNativeHolder(socket, 5_000);
    const [name] = credentialDirsIn(dir);
    await expect(
      readNativeToolCredentialFromSocket(path.join(dir, name ?? "", "s")),
    ).rejects.toThrow();
    client?.write(resizeFrame());
    await pause(100);
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
