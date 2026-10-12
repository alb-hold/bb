import { describe, expect, it, vi } from "vitest";
import { terminalServerMessageSchema } from "@bb/server-contract";
import type { TerminalServerMessage } from "@bb/server-contract";
import { withHarness, type IntegrationHarness } from "../../helpers/harness.js";

const SETTLE_MS = 2_500;
const WAIT_MS = 30_000;
const FLOW_PAUSE_BYTES = 1024 * 1024;
const FLOW_OVERSHOOT_BYTES = 512 * 1024;
const REPLAY_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;

type OutputChunk = Extract<TerminalServerMessage, { type: "output" }>["chunk"];

interface BrowserTerminal {
  attached: Extract<TerminalServerMessage, { type: "attached" }>;
  autoAck(enabled: boolean): void;
  bytes(): number;
  chunks: OutputChunk[];
  close(): void;
  send(message: object): void;
  text(): string;
  waitFor(predicate: (text: string) => boolean): Promise<void>;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTerminal(
  harness: IntegrationHarness,
  command: string,
): Promise<string> {
  const response = await fetch(`${harness.serverUrl}/api/v1/terminals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cols: 120,
      rows: 40,
      start: { mode: "command", command },
      target: { kind: "host_path", hostId: harness.hostId, cwd: "/tmp" },
    }),
  });
  const rawBody = await response.text();
  expect(response.status, rawBody).toBe(201);
  const body = JSON.parse(rawBody) as { id: string };
  return body.id;
}

async function readSession(
  harness: IntegrationHarness,
  terminalId: string,
): Promise<string> {
  const response = await fetch(
    `${harness.serverUrl}/api/v1/terminals/${terminalId}`,
  );
  return await response.text();
}

async function waitUntil(
  description: string,
  check: () => boolean | Promise<boolean>,
  describeState: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${description}. ${describeState()}`);
}

async function attachBrowser(
  harness: IntegrationHarness,
  terminalId: string,
  sinceSeq: number,
): Promise<BrowserTerminal> {
  const url = `${harness.serverUrl.replace(/^http/u, "ws")}/ws/terminals/${terminalId}?outputAcks=1&sinceSeq=${sinceSeq}`;
  const socket = new WebSocket(url);
  const chunks: OutputChunk[] = [];
  let byteCount = 0;
  let acking = false;
  const text = () =>
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    ).toString("utf8");
  let attached: BrowserTerminal["attached"] | null = null;
  socket.addEventListener("message", (event) => {
    const message = terminalServerMessageSchema.parse(
      JSON.parse(String(event.data)),
    );
    if (message.type === "attached") {
      attached = message;
    } else if (message.type === "output") {
      chunks.push(message.chunk);
      byteCount += Buffer.from(message.chunk.dataBase64, "base64").length;
      if (acking) {
        socket.send(
          JSON.stringify({ type: "ack", nextSeq: message.chunk.seq + 1 }),
        );
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error("terminal socket failed to open")),
    );
  });
  await waitUntil("the attached frame", () => attached !== null);
  if (attached === null) {
    throw new Error("terminal never attached");
  }
  return {
    attached,
    autoAck: (enabled) => {
      acking = enabled;
    },
    bytes: () => byteCount,
    chunks,
    close: () => socket.close(),
    send: (message) => socket.send(JSON.stringify(message)),
    text,
    waitFor: (predicate) =>
      waitUntil(
        "terminal output",
        () => predicate(text()),
        () =>
          `attached=${JSON.stringify({
            replayStartSeq: attached?.replayStartSeq,
            nextSeq: attached?.nextSeq,
            status: attached?.session.status,
          })} chunks=${chunks.length} bytes=${byteCount} tail=${JSON.stringify(text().slice(-300))}`,
      ),
  };
}

function numbers(from: number, to: number): string {
  const lines: string[] = [];
  for (let value = from; value <= to; value += 1) {
    lines.push(String(value));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function assertContiguous(chunks: OutputChunk[], firstSeq: number): void {
  chunks.forEach((chunk, index) => {
    expect(chunk.seq).toBe(firstSeq + index);
  });
}

function countTerminalSessionsSelects(harness: IntegrationHarness) {
  const sqlite = harness.db.$client;
  const prepare = sqlite.prepare.bind(sqlite);
  let selects = 0;
  const spy = vi.spyOn(sqlite, "prepare").mockImplementation(((
    source: string,
  ) => {
    if (/^\s*select[\s\S]*\bterminal_sessions\b/iu.test(source)) {
      selects += 1;
    }
    return prepare(source);
  }) as typeof sqlite.prepare);
  return {
    count: () => selects,
    stop: () => spy.mockRestore(),
  };
}

function inputBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function observePlateau(
  terminal: BrowserTerminal,
  baselineBytes: number,
): Promise<number> {
  let previous = -1;
  let stableSamples = 0;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await pause(150);
    const current = terminal.bytes();
    stableSamples =
      current === previous && current > baselineBytes ? stableSamples + 1 : 0;
    previous = current;
    if (stableSamples >= 3) {
      break;
    }
  }
  const plateau = terminal.bytes();
  await pause(600);
  expect(terminal.bytes(), "delivery must stay stalled while unacked").toBe(
    plateau,
  );
  const delivered = plateau - baselineBytes;
  expect(delivered).toBeGreaterThanOrEqual(FLOW_PAUSE_BYTES * 0.9);
  expect(delivered).toBeLessThanOrEqual(FLOW_PAUSE_BYTES + FLOW_OVERSHOOT_BYTES);
  return plateau;
}

describe.sequential("terminal output nobody is watching", () => {
  it("keeps the real daemon's output and replays it exactly through detach and reattach", () =>
    withHarness(async (harness) => {
      const daemonTerminalMessages: string[] = [];
      const manager = harness.daemonApp.terminalManager;
      const handleMessage = manager.handleMessage.bind(manager);
      vi.spyOn(manager, "handleMessage").mockImplementation((message) => {
        daemonTerminalMessages.push(message.type);
        return handleMessage(message);
      });
      const script = [
        "sleep 3",
        "seq 1 5000",
        "echo FIRST_DONE",
        "while read line; do",
        '  echo "got:$line"',
        '  if [ "$line" = flood ]; then seq 6001 300000; echo FLOOD_DONE; fi',
        '  if [ "$line" = flood2 ]; then seq 500001 800000; echo FLOOD2_DONE; fi',
        '  if [ "$line" = more ]; then seq 900001 905000; echo MORE_DONE; fi',
        "done",
      ].join("\n");
      const terminalId = await createTerminal(harness, script);
      expect(daemonTerminalMessages).toContain("terminal.open");
      console.info(
        `REAL_HOST_DAEMON hostId=${harness.hostId} terminalManager=${manager.constructor.name} nodePid=${process.pid} terminal=${terminalId} openReceivedByDaemon=${daemonTerminalMessages.includes("terminal.open")}`,
      );

      await pause(500);
      const startedSession = await readSession(harness, terminalId);
      expect(startedSession, startedSession).toContain('"status":"running"');
      const unwatched = countTerminalSessionsSelects(harness);
      await pause(SETTLE_MS + 3_000);
      const selectsForUnwatchedOutput = unwatched.count();
      unwatched.stop();
      expect(selectsForUnwatchedOutput).toBe(0);

      const first = await attachBrowser(harness, terminalId, 0);
      expect(first.attached.replayStartSeq).toBe(0);
      await first.waitFor((text) => text.includes("FIRST_DONE"));
      assertContiguous(first.chunks, 0);
      const expectedFirst = numbers(1, 5000);
      expect(first.text().startsWith(expectedFirst)).toBe(true);

      first.send({ type: "input", dataBase64: inputBase64("ping\n") });
      await first.waitFor((text) => text.includes("got:ping"));
      first.send({
        type: "ack",
        nextSeq: (first.chunks[first.chunks.length - 1]?.seq ?? 0) + 1,
      });

      const bytesBeforeFlood = first.bytes();
      first.send({ type: "input", dataBase64: inputBase64("flood\n") });
      await first.waitFor((text) => text.includes("got:flood"));
      const plateau = await observePlateau(first, bytesBeforeFlood);
      expect(first.text()).not.toContain("FLOOD_DONE");

      first.autoAck(true);
      first.send({
        type: "ack",
        nextSeq: (first.chunks[first.chunks.length - 1]?.seq ?? 0) + 1,
      });
      await waitUntil(
        "delivery to resume right after the ack",
        () => first.bytes() > plateau,
      );
      await first.waitFor((text) => text.includes("FLOOD_DONE"));
      assertContiguous(first.chunks, 0);
      expect(first.text()).toContain(`${numbers(6001, 300000)}FLOOD_DONE`);

      const bytesBeforeFlood2 = first.bytes();
      first.autoAck(false);
      first.send({ type: "input", dataBase64: inputBase64("flood2\n") });
      await first.waitFor((text) => text.includes("got:flood2"));
      await observePlateau(first, bytesBeforeFlood2);
      expect(first.text()).not.toContain("FLOOD2_DONE");

      first.close();
      await pause(500);
      const lastSeenBeforeDetach =
        first.chunks[first.chunks.length - 1]?.seq ?? 0;

      const afterDetach = countTerminalSessionsSelects(harness);
      await pause(SETTLE_MS + 2_000);
      const selectsAfterDetach = afterDetach.count();
      afterDetach.stop();
      expect(selectsAfterDetach).toBe(0);

      const cursor = lastSeenBeforeDetach + 1;
      const second = await attachBrowser(harness, terminalId, cursor);
      const { replayStartSeq, nextSeq } = second.attached;
      expect(replayStartSeq).toBeGreaterThanOrEqual(cursor);
      const replayChunkCount = nextSeq - replayStartSeq;
      await waitUntil(
        "the replayed chunks",
        () => second.chunks.length >= replayChunkCount,
      );
      assertContiguous(second.chunks, replayStartSeq);
      const replayBytes = second.chunks
        .slice(0, replayChunkCount)
        .reduce(
          (total, chunk) =>
            total + Buffer.from(chunk.dataBase64, "base64").length,
          0,
        );
      if (replayStartSeq === cursor) {
        expect(replayBytes).toBeLessThanOrEqual(
          REPLAY_TAIL_BYTES + MAX_CHUNK_BYTES,
        );
      } else {
        expect(replayBytes).toBeGreaterThanOrEqual(
          REPLAY_TAIL_BYTES - MAX_CHUNK_BYTES,
        );
        expect(replayBytes).toBeLessThanOrEqual(
          REPLAY_TAIL_BYTES + MAX_CHUNK_BYTES,
        );
      }
      await second.waitFor((text) => text.includes("FLOOD2_DONE"));
      assertContiguous(second.chunks, replayStartSeq);
      const expectedFlood2 = `${numbers(500001, 800000)}FLOOD2_DONE\r\n`;
      expect(expectedFlood2.endsWith(second.text())).toBe(true);

      second.autoAck(true);
      second.send({ type: "input", dataBase64: inputBase64("more\n") });
      await second.waitFor((text) => text.includes("MORE_DONE"));
      assertContiguous(second.chunks, replayStartSeq);
      expect(
        second.text().endsWith(`${numbers(900001, 905000)}MORE_DONE\r\n`),
      ).toBe(true);
      second.close();
    }));
});
