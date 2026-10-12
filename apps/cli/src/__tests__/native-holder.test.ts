import { spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { spawn as spawnPty } from "node-pty";
import { BbHttpError } from "@bb/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeHolderFrame,
  NativeHolderFrameDecoder,
  encodeNativeHolderFrame,
  nativeHolderSocketPath,
  nativeTerminalClosedForGood,
  openNativeHolderConnection,
  pipeNativeHolderClient,
  runNativeHolder,
  waitForNativeHolder,
  type NativeHolderProcess,
} from "../native-holder.js";
import { checkNativeTerminalClosedForGood } from "../native-closed-for-good.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function socketIn(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bb-holder-"));
  tempDirs.push(dir);
  return path.join(dir, "thread.sock");
}

function startHolder(
  socketPath: string,
  child: NativeHolderProcess,
  reapAfterMs?: number,
  terminalClosedForGood?: () => Promise<boolean>,
): Promise<number> {
  return runNativeHolder({
    socketPath,
    cwd: os.tmpdir(),
    env: { ...process.env, PS1: "" },
    ...(reapAfterMs === undefined ? {} : { reapAfterMs }),
    ...(terminalClosedForGood === undefined
      ? {}
      : { terminalClosedForGood, detachedCheckIntervalMs: 20 }),
    prepare: async () => child,
    spawnPty: (process, options) =>
      spawnPty(process.command, process.args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      }),
  });
}

class Client {
  private readonly decoder = new NativeHolderFrameDecoder();
  output = "";
  exitCode: number | null = null;

  constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        if (message.type === NativeHolderFrame.output) {
          this.output += message.payload.toString("utf8");
        } else if (message.type === NativeHolderFrame.exit) {
          this.exitCode = JSON.parse(message.payload.toString("utf8")).code;
        }
      }
    });
    socket.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.resize,
        Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
      ),
    );
  }

  type(text: string): void {
    this.socket.write(
      encodeNativeHolderFrame(NativeHolderFrame.input, Buffer.from(text)),
    );
  }

  async waitFor(pattern: RegExp): Promise<RegExpMatchArray> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const match = this.output.match(pattern);
      if (match !== null) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `timed out waiting for ${pattern}; saw ${JSON.stringify(this.output)}`,
    );
  }
}

async function attach(socketPath: string): Promise<Client> {
  const socket = await waitForNativeHolder(socketPath, 5_000);
  if (socket === null) throw new Error("holder did not listen");
  return new Client(socket);
}

const ECHO_LOOP: NativeHolderProcess = {
  command: "/bin/sh",
  args: [
    "-c",
    'echo "started:$$"; while IFS= read -r line; do echo "got:$line:$$"; done; exit 7',
  ],
};

describe("native terminal holder", () => {
  it("keeps the CLI running when its terminal goes away and reattaches to the same process", async () => {
    const socketPath = socketIn();
    const held = startHolder(socketPath, ECHO_LOOP);
    const first = await attach(socketPath);
    const pid = (await first.waitFor(/started:(\d+)/u))[1];

    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = await attach(socketPath);
    second.type("after restart\r");
    await second.waitFor(new RegExp(`got:after restart:${pid}`, "u"));
    expect(second.output).not.toMatch(/started:/u);

    second.type("\u0004");
    await expect(held).resolves.toBe(7);
    await expect.poll(() => second.exitCode).toBe(7);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("stops the CLI when no terminal reattaches within the reap window", async () => {
    const socketPath = socketIn();
    const held = startHolder(socketPath, ECHO_LOOP, 300);
    const client = await attach(socketPath);
    await client.waitFor(/started:/u);
    client.socket.destroy();
    const code = await held;
    expect(code).not.toBe(7);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("stops the CLI as soon as bb reports its terminal closed for good, but never while a terminal is attached", async () => {
    const socketPath = socketIn();
    let checks = 0;
    const held = startHolder(socketPath, ECHO_LOOP, undefined, async () => {
      checks += 1;
      return true;
    });
    const client = await attach(socketPath);
    const pid = (await client.waitFor(/started:(\d+)/u))[1];
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(checks).toBe(0);
    client.type("still here\r");
    await client.waitFor(new RegExp(`got:still here:${pid}`, "u"));
    client.socket.destroy();
    const code = await held;
    expect(code).not.toBe(7);
    expect(checks).toBeGreaterThan(0);
  });

  it("keeps the CLI when bb cannot be reached or the terminal was lost with the daemon", async () => {
    const socketPath = socketIn();
    let checks = 0;
    const held = startHolder(socketPath, ECHO_LOOP, undefined, async () => {
      checks += 1;
      if (checks % 2 === 0) throw new Error("fetch failed");
      return false;
    });
    const first = await attach(socketPath);
    const pid = (await first.waitFor(/started:(\d+)/u))[1];
    first.socket.destroy();
    await expect.poll(() => checks).toBeGreaterThan(4);
    const second = await attach(socketPath);
    second.type("back\r");
    await second.waitFor(new RegExp(`got:back:${pid}`, "u"));
    second.type("\u0004");
    await expect(held).resolves.toBe(7);
  });

  it("still reaps a detached CLI when bb answers with errors", async () => {
    const socketPath = socketIn();
    const held = startHolder(socketPath, ECHO_LOOP, 300, () =>
      checkNativeTerminalClosedForGood(() =>
        Promise.reject(
          new BbHttpError({
            body: null,
            code: null,
            message: "x",
            status: 500,
          }),
        ),
      ),
    );
    const client = await attach(socketPath);
    await client.waitFor(/started:/u);
    client.socket.destroy();
    const code = await held;
    expect(code).not.toBe(7);
  });

  it("never reaps the CLI while bb is unreachable, and reaps it once bb answers and nothing reattaches", async () => {
    const socketPath = socketIn();
    let reachable = false;
    const held = startHolder(socketPath, ECHO_LOOP, 300, async () => {
      if (!reachable) throw new Error("fetch failed");
      return false;
    });
    const first = await attach(socketPath);
    const pid = (await first.waitFor(/started:(\d+)/u))[1];
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const second = await attach(socketPath);
    second.type("after outage\r");
    await second.waitFor(new RegExp(`got:after outage:${pid}`, "u"));
    reachable = true;
    second.socket.destroy();
    const code = await held;
    expect(code).not.toBe(7);
  });

  it("gives up when no terminal ever attaches", async () => {
    const socketPath = socketIn();
    const code = await runNativeHolder({
      socketPath,
      cwd: os.tmpdir(),
      env: process.env,
      firstClientTimeoutMs: 100,
      prepare: async () => ECHO_LOOP,
      spawnPty: () => {
        throw new Error("must not spawn without a terminal");
      },
    });
    expect(code).toBe(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("shows why the CLI could not be prepared and exits", async () => {
    const socketPath = socketIn();
    const held = runNativeHolder({
      socketPath,
      cwd: os.tmpdir(),
      env: process.env,
      prepare: async () => {
        throw new Error("thread is archived");
      },
      spawnPty: () => {
        throw new Error("must not spawn");
      },
    });
    const client = await attach(socketPath);
    await expect(held).resolves.toBe(1);
    await client.waitFor(/thread is archived/u);
  });

  it("pipes a terminal through the holder and returns the CLI's exit code", async () => {
    const socketPath = socketIn();
    const held = startHolder(socketPath, {
      command: "/bin/sh",
      args: ["-c", 'IFS= read -r line; echo "got:$line"; exit 3'],
    });
    const socket = await waitForNativeHolder(socketPath, 5_000);
    if (socket === null) throw new Error("holder did not listen");
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, rows: 30 });
    let shown = "";
    output.on("data", (chunk: Buffer) => {
      shown += chunk.toString("utf8");
    });
    const piped = pipeNativeHolderClient(socket, {
      input,
      output,
      fallbackSize: { cols: 120, rows: 40 },
    });
    input.write("hi\r");
    await expect(piped).resolves.toBe(3);
    await expect(held).resolves.toBe(3);
    expect(shown).toContain("got:hi");
  });
});

describe("opening a native holder connection", () => {
  it("starts nothing when a reattach finds the CLI already ended while bb was away", async () => {
    const socketPath = socketIn();
    const held = startHolder(socketPath, ECHO_LOOP);
    const client = await attach(socketPath);
    await client.waitFor(/started:/u);
    client.type("\u0004");
    await expect(held).resolves.toBe(7);
    client.socket.destroy();

    let starts = 0;
    const connection = await openNativeHolderConnection({
      socketPath,
      reattachOnly: true,
      startHolder: () => {
        starts += 1;
      },
      startTimeoutMs: 1_000,
    });
    expect(connection.kind).toBe("ended");
    expect(starts).toBe(0);
  });

  it("reattaches to a CLI that is still held", async () => {
    const socketPath = socketIn();
    const held = startHolder(socketPath, ECHO_LOOP);
    const first = await attach(socketPath);
    const pid = (await first.waitFor(/started:(\d+)/u))[1];
    first.socket.destroy();

    const connection = await openNativeHolderConnection({
      socketPath,
      reattachOnly: true,
      startHolder: () => {
        throw new Error("must not start a second holder");
      },
      startTimeoutMs: 1_000,
    });
    if (connection.kind !== "attached") throw new Error(connection.kind);
    const second = new Client(connection.socket);
    second.type("again\r");
    await second.waitFor(new RegExp(`got:again:${pid}`, "u"));
    second.type("\u0004");
    await expect(held).resolves.toBe(7);
  });

  it("starts a holder for an ordinary open and reports one that never listens", async () => {
    const socketPath = socketIn();
    let held: Promise<number> | null = null;
    const connection = await openNativeHolderConnection({
      socketPath,
      reattachOnly: false,
      startHolder: () => {
        held = startHolder(socketPath, ECHO_LOOP);
      },
      startTimeoutMs: 5_000,
    });
    if (connection.kind !== "attached") throw new Error(connection.kind);
    const client = new Client(connection.socket);
    await client.waitFor(/started:/u);
    client.type("\u0004");
    await expect(held).resolves.toBe(7);

    const silent = await openNativeHolderConnection({
      socketPath: socketIn(),
      reattachOnly: false,
      startHolder: () => undefined,
      startTimeoutMs: 200,
    });
    expect(silent.kind).toBe("did-not-start");
  });
});

describe("native holder signals", () => {
  it("survives the termination signals a bb quit or a process manager sends, so its CLI keeps running", async () => {
    const holderModule = pathToFileURL(
      path.join(import.meta.dirname, "..", "native-holder.ts"),
    ).href;
    const child = spawnProcess(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "-e",
        `const { ignoreNativeHolderSignals } = await import(${JSON.stringify(holderModule)});
ignoreNativeHolderSignals(process);
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) resolve();
        });
        child.once("exit", (code, signal) =>
          reject(new Error(`holder exited early: ${code} ${signal}`)),
        );
      });
      for (const signal of [
        "SIGTERM",
        "SIGHUP",
        "SIGINT",
        "SIGQUIT",
      ] as const) {
        child.kill(signal);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect({
          signal,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        }).toEqual({
          signal,
          exitCode: null,
          signalCode: null,
        });
      }
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("native terminal closed for good", () => {
  const exited = (closeReason: string | null) => ({
    terminal: { status: "exited", closeReason },
  });

  it.each([
    ["the thread is gone", null, true],
    ["no terminal is recorded", { terminal: null }, false],
    [
      "the terminal is running",
      { terminal: { status: "running", closeReason: null } },
      false,
    ],
    [
      "the daemon connection dropped",
      { terminal: { status: "disconnected", closeReason: null } },
      false,
    ],
    ["the daemon went away", exited("daemon-disconnect"), false],
    ["the terminal process exited", exited("process-exit"), false],
    ["the terminal never opened", exited("open-timeout"), false],
    ["the user closed the terminal", exited("user"), true],
    ["the thread was archived", exited("thread-archived"), true],
    ["the thread was deleted", exited("thread-deleted"), true],
    ["the workspace was destroyed", exited("environment-destroyed"), true],
  ] as const)("when %s", (_name, view, closed) => {
    expect(nativeTerminalClosedForGood(view)).toBe(closed);
  });
});

describe("checking whether bb closed a native terminal for good", () => {
  const httpError = (status: number) =>
    new BbHttpError({ body: null, code: null, message: "x", status });

  it("treats a missing thread as closed for good", async () => {
    await expect(
      checkNativeTerminalClosedForGood(() => Promise.reject(httpError(404))),
    ).resolves.toBe(true);
  });

  it("counts a server error as bb reachable and the terminal not closed", async () => {
    await expect(
      checkNativeTerminalClosedForGood(() => Promise.reject(httpError(500))),
    ).resolves.toBe(false);
  });

  it("reports bb unreachable when the request never gets an answer", async () => {
    const refused = new Error(
      "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.",
    );
    await expect(
      checkNativeTerminalClosedForGood(() => Promise.reject(refused)),
    ).rejects.toBe(refused);
  });
});

describe("native holder frames", () => {
  it("decodes frames split across chunks and several frames in one chunk", () => {
    const one = encodeNativeHolderFrame(
      NativeHolderFrame.output,
      Buffer.from("héllo"),
    );
    const two = encodeNativeHolderFrame(
      NativeHolderFrame.exit,
      Buffer.from('{"code":0}'),
    );
    const joined = Buffer.concat([one, two]);
    const decoder = new NativeHolderFrameDecoder();
    expect(decoder.push(joined.subarray(0, 3))).toEqual([]);
    const messages = decoder.push(joined.subarray(3));
    expect(messages.map((message) => message.type)).toEqual([
      NativeHolderFrame.output,
      NativeHolderFrame.exit,
    ]);
    expect(messages[0]?.payload.toString("utf8")).toBe("héllo");
  });
});

describe("native holder socket path", () => {
  it("scopes the socket to the bb server so a dev server never attaches to another server's CLI", () => {
    const base = { home: "/Users/a", threadId: "thr_abc", tmpDir: "/tmp" };
    const live = nativeHolderSocketPath({
      ...base,
      baseUrl: "http://127.0.0.1:38886",
    });
    const dev = nativeHolderSocketPath({
      ...base,
      baseUrl: "http://127.0.0.1:38999",
    });
    expect(live).not.toBe(dev);
    expect(live.startsWith("/Users/a/.bb/native-terminals/thr_abc-")).toBe(
      true,
    );
  });

  it("falls back to the temp dir when the home path is too long for a unix socket", () => {
    const socketPath = nativeHolderSocketPath({
      home: `/Users/${"x".repeat(120)}`,
      threadId: "thr_abc",
      tmpDir: "/tmp",
      baseUrl: "http://127.0.0.1:38886",
    });
    expect(socketPath.startsWith("/tmp/bb-native-terminals/thr_abc-")).toBe(
      true,
    );
  });
});
