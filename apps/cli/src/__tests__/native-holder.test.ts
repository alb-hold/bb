import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { spawn as spawnPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import * as nativeHolder from "../native-holder.js";
import {
  NativeHolderFrame,
  NativeHolderFrameDecoder,
  encodeNativeHolderFrame,
  ignoreNativeHolderSignals,
  nativeHolderSocketPath,
  nativeTerminalClosedForGood,
  openNativeHolderConnection,
  pipeNativeHolderClient,
  runNativeHolder,
  waitForNativeHolder,
  type NativeHolderProcess,
} from "../native-holder.js";
import {
  NativeBbUnreachableError,
  checkNativeTerminalClosedForGood,
} from "../native-closed-for-good.js";

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

function writeHolderTestEvent(
  socketPath: string,
  event: string,
  fields: Record<string, number | string | null>,
): void {
  const logEvent = (
    nativeHolder as unknown as {
      logNativeHolderEvent?: (
        socketPath: string,
        event: string,
        fields: Record<string, number | string | null>,
      ) => void;
    }
  ).logNativeHolderEvent;
  expect(logEvent).toBeTypeOf("function");
  logEvent?.(socketPath, event, fields);
}

function oversizedHolderTestFields(): Record<string, number> {
  const fields: Record<string, number> = {};
  for (let index = 0; index < 30_000; index += 1) {
    fields[`field${index}`] = index;
  }
  return fields;
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
  it.each(["1", "0"])(
    "passes CLAUDE_CODE_FORCE_SYNC_OUTPUT=%s from the holder environment to its PTY",
    async (forceSyncOutput) => {
      const socketPath = socketIn();
      let receivedEnv: NodeJS.ProcessEnv | undefined;
      let ptyExit:
        | ((event: { exitCode: number; signal?: number }) => void)
        | undefined;
      const held = runNativeHolder({
        socketPath,
        cwd: os.tmpdir(),
        env: { CLAUDE_CODE_FORCE_SYNC_OUTPUT: forceSyncOutput },
        prepare: async () => ({ command: "fake", args: [] }),
        spawnPty: (_process, options) => {
          receivedEnv = options.env;
          return {
            pid: 654,
            onData: () => undefined,
            onExit: (listener) => {
              ptyExit = listener;
            },
            write: () => undefined,
            resize: () => undefined,
            kill: () => undefined,
          };
        },
      });
      let client: Client | null = null;
      try {
        client = await attach(socketPath);
        await expect.poll(() => receivedEnv).toBeDefined();
        expect(receivedEnv?.CLAUDE_CODE_FORCE_SYNC_OUTPUT).toBe(
          forceSyncOutput,
        );
      } finally {
        ptyExit?.({ exitCode: 0 });
        client?.socket.destroy();
        await held;
      }
    },
  );

  it("keeps the log at the size cap when an oversized record reaches the boundary", () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");
    const maxBytes = 256 * 1024;
    writeFileSync(logPath, Buffer.alloc(maxBytes - 4, 0x78));

    writeHolderTestEvent(
      socketPath,
      "boundary",
      oversizedHolderTestFields(),
    );

    expect(statSync(logPath).size).toBeLessThanOrEqual(maxBytes);
  });

  it("truncates a nearly full log before writing a fitting record", () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");
    const maxBytes = 256 * 1024;
    writeFileSync(logPath, Buffer.alloc(maxBytes - 10, 0x78));

    writeHolderTestEvent(socketPath, "bounded", {
      id: 1,
      detail: "x".repeat(40),
    });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "bounded" });
    expect(statSync(logPath).size).toBeLessThanOrEqual(maxBytes);
  });

  it("keeps a competing holder from writing to the socket owner's log", async () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");
    const firstPtyExit: {
      current?: (event: { exitCode: number; signal?: number }) => void;
    } = {};
    let firstOwnsSocket = false;
    const run = (
      onSocketReady?: () => void,
      onSocketClosed?: () => void,
    ): Promise<number> =>
      runNativeHolder(
        {
          socketPath,
          cwd: os.tmpdir(),
          env: {},
          onSocketReady,
          onSocketClosed,
          prepare: async () => ({ command: "fake", args: [] }),
          spawnPty: () => ({
            pid: 654,
            onData: () => undefined,
            onExit: (
              listener: (event: { exitCode: number; signal?: number }) => void,
            ) => {
              firstPtyExit.current = listener;
            },
            write: () => undefined,
            resize: () => undefined,
            kill: () => undefined,
          }),
        } as unknown as Parameters<typeof runNativeHolder>[0],
      );
    const first = run(() => {
      firstOwnsSocket = true;
    }, () => {
      firstOwnsSocket = false;
    });
    const firstSignalTarget = new EventEmitter() as unknown as NodeJS.Process;
    const holderModule = pathToFileURL(
      path.join(import.meta.dirname, "..", "native-holder.ts"),
    ).href;
    const ignoreSignals = ignoreNativeHolderSignals as unknown as (
      target: NodeJS.Process,
      path: string,
      ownsSocket: () => boolean,
    ) => () => void;
    const removeFirstSignals = ignoreSignals(
      firstSignalTarget,
      socketPath,
      () => firstOwnsSocket,
    );
    let client: Client | null = null;
    try {
      client = await attach(socketPath);
      await expect.poll(() => firstPtyExit.current).toBeDefined();
      firstOwnsSocket = true;
      const firstLog = readFileSync(logPath, "utf8");

      const second = spawnProcess(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--input-type=module",
          "-e",
          `const { ignoreNativeHolderSignals, runNativeHolder } = await import(${JSON.stringify(holderModule)});
let ownsSocket = false;
ignoreNativeHolderSignals(process, ${JSON.stringify(socketPath)}, () => ownsSocket);
process.emit("SIGTERM");
try {
  await runNativeHolder({
    socketPath: ${JSON.stringify(socketPath)},
    cwd: ${JSON.stringify(os.tmpdir())},
    env: {},
    onSocketReady: () => { ownsSocket = true; },
    onSocketClosed: () => { ownsSocket = false; },
    prepare: async () => ({ command: "fake", args: [] }),
    spawnPty: () => { throw new Error("must not start a PTY"); },
  });
  process.stdout.write("unexpected socket ownership\\n");
} catch (error) {
  console.error("competing holder startup failure");
  process.stdout.write(String(error.code) + "\\n");
}`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let secondOutput = "";
      const secondExit = new Promise<void>((resolve, reject) => {
        second.stdout.on("data", (chunk: Buffer) => {
          secondOutput += chunk.toString("utf8");
        });
        second.once("error", reject);
        second.once("exit", (code, signal) => {
          if (code === 0 && signal === null) resolve();
          else reject(new Error(`competing holder exited: ${code} ${signal}`));
        });
      });
      await secondExit;
      expect(secondOutput.trim()).toBe("EADDRINUSE");

      expect(readFileSync(logPath, "utf8")).toBe(firstLog);
      firstPtyExit.current?.({ exitCode: 0 });
      await first;
      const finishedLog = readFileSync(logPath, "utf8");
      firstSignalTarget.emit("SIGTERM");
      expect(readFileSync(logPath, "utf8")).toBe(finishedLog);
    } finally {
      removeFirstSignals();
      client?.socket.destroy();
      firstPtyExit.current?.({ exitCode: 0 });
      await first;
    }
  });

  it("truncates oversized exception names before writing the record", () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");

    writeHolderTestEvent(socketPath, "uncaught-exception", {
      name: "E".repeat(1_024),
    });

    const [line] = readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.name).toBe("E".repeat(200));
    expect(statSync(logPath).size).toBeLessThanOrEqual(256 * 1024);
  });

  it("drops a serialized event that is larger than the log cap", () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");
    writeHolderTestEvent(
      socketPath,
      "oversized-record",
      oversizedHolderTestFields(),
    );

    expect(statSync(logPath).size).toBeLessThanOrEqual(256 * 1024);
    expect(readFileSync(logPath, "utf8")).toBe("");
  });

  it("sets an existing holder log to mode 0600 before appending", () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");
    writeFileSync(logPath, "existing\n", { mode: 0o644 });
    chmodSync(logPath, 0o644);

    writeHolderTestEvent(socketPath, "permission-check", { value: 1 });

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("writes an adjacent log when the socket path has no suffix", () => {
    const socketPath = path.join(path.dirname(socketIn()), "holder");
    const logEvent = (
      nativeHolder as unknown as {
        logNativeHolderEvent?: (
          socketPath: string,
          event: string,
          fields: Record<string, number | string | null>,
        ) => void;
      }
    ).logNativeHolderEvent;

    expect(logEvent).toBeTypeOf("function");
    logEvent?.(socketPath, "probe", { value: 1 });

    const logPath = `${socketPath}.log`;
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    const [line] = readFileSync(logPath, "utf8").trim().split("\n");
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      event: "probe",
      value: 1,
    });
  });

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

  it("records ignored signals and fake PTY lifecycle events without terminal data", async () => {
    const socketPath = socketIn();
    const logPath = socketPath.replace(/\.sock$/u, ".log");
    const signalTarget = new EventEmitter() as unknown as NodeJS.Process;
    const ignoreSignals = ignoreNativeHolderSignals as unknown as (
      target: NodeJS.Process,
      socketPath: string,
    ) => () => void;
    const removeSignals = ignoreSignals(signalTarget, socketPath);
    signalTarget.emit("SIGTERM");
    const ptyExit: {
      current: ((event: { exitCode: number; signal?: number }) => void) | null;
    } = { current: null };
    const held = runNativeHolder({
      socketPath,
      holderPid: 321,
      holderPgid: 321,
      holderSid: 321,
      cwd: os.tmpdir(),
      env: {},
      prepare: async () => ({ command: "fake", args: [] }),
      spawnPty: () => ({
        pid: 654,
        onData: () => undefined,
        onExit: (listener) => {
          ptyExit.current = listener;
        },
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      }),
    });
    try {
      const client = await attach(socketPath);
      await expect.poll(() => ptyExit.current).not.toBeNull();
      ptyExit.current?.({ exitCode: 9 });
      await expect(held).resolves.toBe(9);
      const lines = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map(({ event }) => event)).toEqual([
        "ignored-signal",
        "holder-start",
        "pty-child-exit",
        "holder-finish",
      ]);
      expect(lines[0]).toMatchObject({ signal: "SIGTERM" });
      expect(lines[1]).toMatchObject({
        pid: 321,
        pgid: 321,
        sid: 321,
        cliPid: 654,
      });
      expect(lines[2]).toMatchObject({ exitCode: 9, signal: null });
      expect(lines[3]).toMatchObject({ reason: "child exited" });
      for (const line of lines) {
        expect(line.time).toMatch(/^\d{4}-\d\d-\d\dT/u);
      }
      expect(readFileSync(logPath, "utf8")).not.toContain("terminal content");
      client.socket.destroy();
    } finally {
      removeSignals();
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
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      }),
    );
  });

  async function bb(
    handler: (response: http.ServerResponse) => void,
  ): Promise<string> {
    const server = http.createServer((_request, response) => handler(response));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  const answering = (status: number, body: string) =>
    bb((response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  const stallingAfterHeaders = () =>
    bb((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
  const hungBeforeHeaders = () => bb(() => undefined);

  async function closedPort(): Promise<string> {
    const url = await answering(200, "{}");
    const server = servers.pop();
    await new Promise((resolve) => server?.close(resolve));
    return url;
  }

  const check = (baseUrl: string) =>
    checkNativeTerminalClosedForGood({
      baseUrl,
      threadId: "thr_x",
      timeoutMs: 200,
    });

  it("treats a missing thread as closed for good", async () => {
    await expect(
      check(
        await answering(404, '{"error":{"code":"not_found","message":"x"}}'),
      ),
    ).resolves.toBe(true);
  });

  it("counts a server error as bb answering and the terminal not closed", async () => {
    await expect(
      check(
        await answering(500, '{"error":{"code":"internal","message":"x"}}'),
      ),
    ).resolves.toBe(false);
  });

  it("counts a response the CLI could not read as bb answering", async () => {
    await expect(check(await answering(200, "not json"))).resolves.toBe(false);
  });

  it("counts a response whose body stalls past the timeout as bb answering", async () => {
    await expect(check(await stallingAfterHeaders())).resolves.toBe(false);
  });

  it.each([
    ["the connection is refused", closedPort],
    ["bb accepts the connection but never sends headers", hungBeforeHeaders],
  ] as const)("reports bb unreachable when %s", async (_name, start) => {
    await expect(check(await start())).rejects.toBeInstanceOf(
      NativeBbUnreachableError,
    );
  });

  it("keeps a detached CLI while bb never sends headers, and reaps it once bb answers", async () => {
    let hung = true;
    const baseUrl = await bb((response) => {
      if (hung) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"terminal":{"status":"running","closeReason":null}}');
    });
    const socketPath = socketIn();
    const held = startHolder(socketPath, ECHO_LOOP, 300, () => check(baseUrl));
    const first = await attach(socketPath);
    const pid = (await first.waitFor(/started:(\d+)/u))[1];
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const second = await attach(socketPath);
    second.type("still held\r");
    await second.waitFor(new RegExp(`got:still held:${pid}`, "u"));
    hung = false;
    second.socket.destroy();
    expect(await held).not.toBe(7);
  });

  it.each([
    ["answering with unreadable responses", () => answering(200, "not json")],
    ["stalling after headers", stallingAfterHeaders],
  ] as const)(
    "still reaps a detached CLI while bb keeps %s",
    async (_name, start) => {
      const baseUrl = await start();
      const socketPath = socketIn();
      const held = startHolder(socketPath, ECHO_LOOP, 300, () =>
        check(baseUrl),
      );
      const client = await attach(socketPath);
      await client.waitFor(/started:/u);
      client.socket.destroy();
      expect(await held).not.toBe(7);
    },
  );
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
