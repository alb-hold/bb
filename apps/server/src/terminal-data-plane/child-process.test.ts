import { fork, spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  terminalDataPlaneChildMessageSchema,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneMainMessage,
} from "./ipc-contract.js";

const v = TERMINAL_DATA_PLANE_IPC_VERSION;
const childEntry = fileURLToPath(new URL("./child-main.ts", import.meta.url));
const listenProbe = pathToFileURL(
  fileURLToPath(new URL("./child-process.test-preload.mjs", import.meta.url)),
).href;
const STEP_TIMEOUT_MS = 30_000;

const session: TerminalSession = {
  id: "term_authorized",
  threadId: null,
  environmentId: null,
  hostId: "host_1",
  title: "shell",
  initialCwd: "/tmp",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
  lastUserInputAt: null,
};

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function isNetworkListenReport(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "type" in raw &&
    raw.type === "test.network-listen"
  );
}

interface RunningChild {
  exited: Promise<number | null>;
  messages: TerminalDataPlaneChildMessage[];
  networkListens: number;
  process: ChildProcess;
  send(message: TerminalDataPlaneMainMessage, handle?: Socket): void;
  waitFor<Type extends TerminalDataPlaneChildMessage["type"]>(
    type: Type,
  ): Promise<Extract<TerminalDataPlaneChildMessage, { type: Type }>>;
}

const cleanups: Array<() => void | Promise<void>> = [];

function startChild(): RunningChild {
  const child = fork(childEntry, [], {
    execArgv: ["--conditions=source", "--import", listenProbe, "--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const waiters: Array<() => void> = [];
  const running: RunningChild = {
    exited: new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
    }),
    messages: [],
    networkListens: 0,
    process: child,
    send: (message, handle) => {
      child.send(message, handle);
    },
    waitFor: (type) =>
      new Promise((resolve, reject) => {
        let seen = 0;
        const isType = (
          message: TerminalDataPlaneChildMessage,
        ): message is Extract<
          TerminalDataPlaneChildMessage,
          { type: typeof type }
        > => message.type === type;
        const timer = setTimeout(
          () => reject(new Error(`No ${type} message from the child`)),
          STEP_TIMEOUT_MS,
        );
        const check = (): void => {
          for (; seen < running.messages.length; seen += 1) {
            const message = running.messages[seen];
            if (message !== undefined && isType(message)) {
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(check), 1);
              seen += 1;
              resolve(message);
              return;
            }
          }
        };
        waiters.push(check);
        check();
      }),
  };
  child.on("message", (raw) => {
    if (isNetworkListenReport(raw)) {
      running.networkListens += 1;
      return;
    }
    running.messages.push(terminalDataPlaneChildMessageSchema.parse(raw));
    for (const check of [...waiters]) {
      check();
    }
  });
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  return running;
}

function rawHeaderPairs(request: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      pairs.push([name, value]);
    }
  }
  return pairs;
}

async function listenForUpgrades(
  onUpgrade: (request: IncomingMessage, socket: Socket, head: Buffer) => void,
): Promise<{ port: number; server: Server }> {
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    onUpgrade(request, socket as Socket, head);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, server };
}

function collectFrames(client: WebSocket): {
  frames: Array<Record<string, unknown>>;
  waitForCount(count: number): Promise<void>;
} {
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  client.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    for (const check of [...waiters]) {
      check();
    }
  });
  return {
    frames,
    waitForCount: (count) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Only ${frames.length} of ${count} frames arrived`)),
          STEP_TIMEOUT_MS,
        );
        const check = (): void => {
          if (frames.length >= count) {
            clearTimeout(timer);
            waiters.splice(waiters.indexOf(check), 1);
            resolve();
          }
        };
        waiters.push(check);
        check();
      }),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("terminal data plane child process", () => {
  it(
    "serves a browser over a socket handed across IPC and never listens on the network",
    async () => {
      const child = startChild();
      await child.waitFor("ready");
      const { port } = await listenForUpgrades((request, socket, head) => {
        child.send(
          {
            v,
            type: "browser.attach",
            attachId: "attach_1",
            terminalId: "term_authorized",
            daemonSessionId: "session_1",
            outputAcks: false,
            sinceSeq: 0,
            request: {
              url: request.url ?? "/",
              headers: rawHeaderPairs(request),
              headBase64: head.toString("base64"),
            },
          },
          socket,
        );
      });

      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/terminals/term_from_url`);
      cleanups.push(() => client.terminate());
      const received = collectFrames(client);
      await child.waitFor("browser.attached");

      child.send({
        v,
        type: "terminal.output",
        terminalId: "term_authorized",
        chunk: { seq: 1, dataBase64: base64("live-before-replay") },
      });
      child.send({
        v,
        type: "terminal.output",
        terminalId: "term_from_url",
        chunk: { seq: 0, dataBase64: base64("other-terminal") },
      });
      child.send({
        v,
        type: "browser.replay",
        attachId: "attach_1",
        terminalId: "term_authorized",
        session,
        replayStartSeq: 0,
        chunks: [{ seq: 0, dataBase64: base64("replayed") }],
        nextSeq: 1,
      });
      child.send({
        v,
        type: "terminal.output",
        terminalId: "term_authorized",
        chunk: { seq: 2, dataBase64: base64("live-after-replay") },
      });
      await received.waitForCount(4);

      expect(received.frames).toEqual([
        { type: "attached", session, replayStartSeq: 0, nextSeq: 1 },
        { type: "output", chunk: { seq: 0, dataBase64: base64("replayed") } },
        { type: "output", chunk: { seq: 1, dataBase64: base64("live-before-replay") } },
        { type: "output", chunk: { seq: 2, dataBase64: base64("live-after-replay") } },
      ]);

      client.send(JSON.stringify({ type: "input", dataBase64: base64("typed") }));
      expect(await child.waitFor("terminal.input")).toEqual({
        v,
        type: "terminal.input",
        terminalId: "term_authorized",
        dataBase64: base64("typed"),
      });

      client.send(JSON.stringify({ type: "ping" }));
      await received.waitForCount(5);
      expect(received.frames[4]).toEqual({ type: "pong" });

      client.close();
      expect(await child.waitFor("browser.detached")).toMatchObject({
        attachId: "attach_1",
        terminalId: "term_authorized",
      });
      expect(child.networkListens).toBe(0);
    },
    120_000,
  );

  it(
    "rejects a handed socket whose request is not a WebSocket handshake",
    async () => {
      const child = startChild();
      await child.waitFor("ready");
      const server = createTcpServer((socket) => {
        child.send(
          {
            v,
            type: "browser.attach",
            attachId: "attach_bad",
            terminalId: "term_authorized",
            daemonSessionId: "session_1",
            outputAcks: false,
            sinceSeq: 0,
            request: {
              url: "/ws/terminals/term_authorized",
              headers: [["Host", "127.0.0.1"]],
              headBase64: "",
            },
          },
          socket,
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      cleanups.push(() => {
        server.close();
      });
      const client = connect((server.address() as AddressInfo).port, "127.0.0.1");
      cleanups.push(() => client.destroy());
      const closed = new Promise<void>((resolve) => {
        client.once("close", () => resolve());
      });
      client.resume();

      expect(await child.waitFor("browser.rejected")).toMatchObject({
        attachId: "attach_bad",
        code: "upgrade_failed",
      });
      await closed;
      expect(child.messages.some((message) => message.type === "browser.attached")).toBe(
        false,
      );
    },
    120_000,
  );

  it(
    "exits and drops its sockets when main disconnects",
    async () => {
      const child = startChild();
      await child.waitFor("ready");
      const { port } = await listenForUpgrades((request, socket, head) => {
        child.send(
          {
            v,
            type: "browser.attach",
            attachId: "attach_1",
            terminalId: "term_authorized",
            daemonSessionId: "session_1",
            outputAcks: false,
            sinceSeq: 0,
            request: {
              url: request.url ?? "/",
              headers: rawHeaderPairs(request),
              headBase64: head.toString("base64"),
            },
          },
          socket,
        );
      });
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/terminals/term_authorized`);
      cleanups.push(() => client.terminate());
      const clientClosed = new Promise<void>((resolve) => {
        client.once("close", () => resolve());
      });
      await child.waitFor("browser.attached");

      child.process.disconnect();

      expect(await child.exited).toBe(0);
      await clientClosed;
    },
    120_000,
  );

  it(
    "has a listen probe that reports a network listener",
    async () => {
      const probe = spawn(
        process.execPath,
        [
          "--import",
          listenProbe,
          "-e",
          "require('node:net').createServer().listen(0, '127.0.0.1', () => process.send({ type: 'test.done' }, () => process.exit(0)))",
        ],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      cleanups.push(() => {
        probe.kill("SIGKILL");
      });
      const reports: unknown[] = [];
      probe.on("message", (raw) => reports.push(raw));
      await new Promise<void>((resolve) => {
        probe.once("exit", () => resolve());
      });

      expect(reports.filter(isNetworkListenReport)).toHaveLength(1);
    },
    120_000,
  );
});
