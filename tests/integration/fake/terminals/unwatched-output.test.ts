import { describe, expect, it, vi } from "vitest";
import { terminalServerMessageSchema } from "@bb/server-contract";
import type { TerminalServerMessage } from "@bb/server-contract";
import { withHarness, type IntegrationHarness } from "../../helpers/harness.js";

const SETTLE_MS = 2_500;
const WAIT_MS = 30_000;

type OutputChunk = Extract<TerminalServerMessage, { type: "output" }>["chunk"];

interface BrowserTerminal {
  attached: Extract<TerminalServerMessage, { type: "attached" }>;
  close(): void;
  chunks: OutputChunk[];
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
          })} chunks=${chunks.length} tail=${JSON.stringify(text().slice(-300))}`,
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

describe.sequential("terminal output nobody is watching", () => {
  it("keeps the real daemon's output and replays it exactly through detach and reattach", () =>
    withHarness(async (harness) => {
      const script = [
        "sleep 3",
        "seq 1 5000",
        "echo FIRST_DONE",
        "while read line; do",
        '  echo "got:$line"',
        '  if [ "$line" = flood ]; then seq 6001 300000; echo FLOOD_DONE; fi',
        '  if [ "$line" = more ]; then seq 400001 405000; echo MORE_DONE; fi',
        "done",
      ].join("\n");
      const terminalId = await createTerminal(harness, script);

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
      const lastBeforeFlood = first.chunks[first.chunks.length - 1];
      expect(lastBeforeFlood).toBeDefined();
      first.send({ type: "ack", nextSeq: (lastBeforeFlood?.seq ?? 0) + 1 });

      first.send({ type: "input", dataBase64: inputBase64("flood\n") });
      await first.waitFor((text) => text.includes("got:flood"));
      await pause(SETTLE_MS);
      expect(first.text()).not.toContain("FLOOD_DONE");
      first.close();
      await pause(500);
      const lastSeenBeforeDetach = first.chunks[first.chunks.length - 1]?.seq ?? 0;

      const afterDetach = countTerminalSessionsSelects(harness);
      await pause(SETTLE_MS);
      const selectsAfterDetach = afterDetach.count();
      afterDetach.stop();
      expect(selectsAfterDetach).toBe(0);

      const second = await attachBrowser(
        harness,
        terminalId,
        lastSeenBeforeDetach + 1,
      );
      expect(second.attached.replayStartSeq).toBeGreaterThanOrEqual(
        lastSeenBeforeDetach + 1,
      );
      await second.waitFor((text) => text.includes("FLOOD_DONE"));
      assertContiguous(second.chunks, second.attached.replayStartSeq);
      const expectedFlood = `${numbers(6001, 300000)}FLOOD_DONE\r\n`;
      expect(expectedFlood.endsWith(second.text())).toBe(true);

      const replayedChunkCount = second.chunks.length;
      second.send({ type: "input", dataBase64: inputBase64("more\n") });
      await second.waitFor((text) => text.includes("MORE_DONE"));
      assertContiguous(second.chunks, second.attached.replayStartSeq);
      expect(second.chunks.length).toBeGreaterThan(replayedChunkCount);
      expect(second.text().endsWith(`${numbers(400001, 405000)}MORE_DONE\r\n`)).toBe(
        true,
      );
      second.send({
        type: "ack",
        nextSeq: (second.chunks[second.chunks.length - 1]?.seq ?? 0) + 1,
      });
      second.close();
    }));
});
