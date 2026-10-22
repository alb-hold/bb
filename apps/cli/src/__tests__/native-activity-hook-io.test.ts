import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { nativeActivityHookSettings } from "../native-activity.js";
import { NativeActivityReader } from "../native-activity-reader.js";
import {
  createHookSpool,
  HookSpoolReader,
  removeHookSpool,
} from "../native-hook-spool.js";

interface ClaudePluginTestHost {
  bb: unknown;
  harness: {
    registrations: {
      providerRegistrations: {
        id: string;
        experimental_nativeTerminal?: ProviderNativeTerminal;
      }[];
    };
  };
}

const {
  createFakePluginHost,
}: {
  createFakePluginHost(options: { pluginId: string }): ClaudePluginTestHost;
} = await import(
  new URL(
    "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.ts",
    import.meta.url,
  ).href
);
const { default: claudeCodePlugin }: { default(bb: unknown): void } =
  await import(
    new URL(
      "../../../../plugins/provider-claude-code/server.ts",
      import.meta.url,
    ).href
  );

const SESSION_ID = "2e624c50-68af-4689-9410-06caa371eb8a";
const spools: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const spool of spools.splice(0)) removeHookSpool(spool);
});

function claudeDeclaration(): ProviderNativeTerminal {
  const host = createFakePluginHost({ pluginId: "provider-claude-code" });
  claudeCodePlugin(host.bb);
  const cli = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "claude-code",
  )?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Claude declaration missing");
  return cli;
}

function fixture() {
  const cli = claudeDeclaration();
  const hooks = cli.activity?.hooks;
  if (hooks === undefined) throw new Error("Claude hooks missing");
  const spool = createHookSpool(os.tmpdir(), "hook-io-test");
  spools.push(spool);
  const settings: {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  } = JSON.parse(nativeActivityHookSettings(hooks, spool));
  const commandFor = (event: string): string => {
    const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
    if (command === undefined) throw new Error(`no hook command for ${event}`);
    return command;
  };
  const unconfirmed: Array<{ reason: string; total: number }> = [];
  const reader = new NativeActivityReader(
    cli,
    { HOME: os.tmpdir() },
    spool,
    { kind: "start", id: SESSION_ID },
    undefined,
    (reason, total) => unconfirmed.push({ reason, total }),
  );
  return { commandFor, reader, spool, unconfirmed };
}

function record(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: SESSION_ID,
    ...extra,
  });
}

function startHook(command: string): {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
} {
  const child = spawn("sh", ["-c", command], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  children.push(child);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return { child, exited };
}

async function runWhole(command: string, payload: string): Promise<void> {
  const { child, exited } = startHook(command);
  child.stdin.end(payload);
  await exited;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const published = (spool: string): string[] =>
  readdirSync(spool)
    .filter((name) => /^\d{12}$/u.test(name))
    .sort();

const leftovers = (spool: string): string[] =>
  readdirSync(spool).filter((name) => name.startsWith(".tmp."));

const toolOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "tool_name" in value
    ? String(value.tool_name)
    : "";

const platformNote =
  process.platform === "win32"
    ? "NOT EXERCISED on native Windows: the hook command needs a POSIX shell with mktemp, cat, ln, mv and rm, and native-terminal mode cannot start there today (docs/debugging-and-qa.md)"
    : "";

describe.skipIf(process.platform === "win32")(
  `the generated hook command and the reader, end to end on one spool ${platformNote}`,
  () => {
    it("publishes concurrent records whole and in sequence order, including 1 MiB records and an empty permission_suggestions array", async () => {
      const { commandFor, spool } = fixture();
      const command = commandFor("PermissionRequest");
      const big = "x".repeat(1024 * 1024);
      const tools = Array.from({ length: 10 }, (_, index) => `Tool${index}`);
      const payloads = tools.map((tool, index) =>
        record("PermissionRequest", {
          permission_suggestions: [],
          tool_input: { content: index % 2 === 0 ? big : "small" },
          tool_name: tool,
        }),
      );
      const running = payloads.map(() => startHook(command));
      for (const [index, { child }] of running.entries()) {
        child.stdin.end(payloads[index]);
      }
      await Promise.all(running.map(({ exited }) => exited));

      const names = published(spool);
      expect(names).toEqual(
        tools.map((_, index) => String(index + 1).padStart(12, "0")),
      );
      expect(leftovers(spool)).toEqual([]);
      const read = new HookSpoolReader(spool).read();
      expect(read.unreadable).toBe(0);
      expect(read.records.map(toolOf).sort()).toEqual([...tools].sort());
      for (const entry of read.records) {
        expect(entry).toMatchObject({
          hook_event_name: "PermissionRequest",
          permission_suggestions: [],
          session_id: SESSION_ID,
        });
      }
    });

    it("publishes sequential records in the order they were written", async () => {
      const { commandFor, spool } = fixture();
      const command = commandFor("PermissionRequest");
      for (const tool of ["A", "B", "C", "D"]) {
        await runWhole(command, record("PermissionRequest", { tool_name: tool }));
      }
      expect(new HookSpoolReader(spool).read().records.map(toolOf)).toEqual([
        "A",
        "B",
        "C",
        "D",
      ]);
    });

    it("never reads a record that is still being written, and delivers it whole once it is published, behind the records published meanwhile", async () => {
      const { commandFor, spool } = fixture();
      const command = commandFor("PermissionRequest");
      const reader = new HookSpoolReader(spool);
      const slow = record("PermissionRequest", {
        tool_input: { content: "y".repeat(200_000) },
        tool_name: "Slow",
      });
      const first = startHook(command);
      first.child.stdin.write(slow.slice(0, 1000));
      await until(() => leftovers(spool).length === 1, "the first temp file");

      await runWhole(command, record("PermissionRequest", { tool_name: "Fast" }));
      expect(reader.read()).toEqual({
        records: [expect.objectContaining({ tool_name: "Fast" })],
        unreadable: 0,
      });

      first.child.stdin.end(slow.slice(1000));
      await first.exited;
      const later = reader.read(Date.now() + 5_000);
      expect(later.unreadable).toBe(0);
      expect(later.records.map(toolOf)).toEqual(["Slow"]);
      expect(later.records[0]).toMatchObject({
        tool_input: { content: "y".repeat(200_000) },
      });
      expect(reader.read(Date.now() + 10_000)).toEqual({
        records: [],
        unreadable: 0,
      });
    });

    it("detects a hook killed mid-write once, never publishes it, and keeps delivering the others", async () => {
      const { commandFor, spool } = fixture();
      const command = commandFor("PermissionRequest");
      const reader = new HookSpoolReader(spool);
      const dying = startHook(command);
      dying.child.stdin.write(`{"hook_event_name":"PermissionRequest","tool_`);
      await until(() => leftovers(spool).length === 1, "the temp file");
      dying.child.kill("SIGKILL");
      await dying.exited;

      await runWhole(command, record("PermissionRequest", { tool_name: "Next" }));
      const first = reader.read(Date.now() + 5_000);
      expect(first.records.map(toolOf)).toEqual(["Next"]);
      expect(first.unreadable).toBe(1);
      expect(published(spool)).toHaveLength(1);
      expect(reader.read(Date.now() + 20_000)).toEqual({
        records: [],
        unreadable: 0,
      });
    });

    it("detects an abandoned temp file that no process owns", async () => {
      const { spool } = fixture();
      const finished = startHook("exit 0");
      await finished.exited;
      writeFileSync(path.join(spool, `.tmp.${finished.child.pid}.abc123`), "{");
      const reader = new HookSpoolReader(spool);
      expect(reader.read()).toEqual({ records: [], unreadable: 1 });
      expect(reader.read(Date.now() + 10_000)).toEqual({
        records: [],
        unreadable: 0,
      });
    });

    const putRecord = (spool: string, sequence: number, tool: string) =>
      writeFileSync(
        path.join(spool, String(sequence).padStart(12, "0")),
        record("PermissionRequest", { tool_name: tool }),
      );

    it("waits for a gap in the sequence and delivers in order once it is filled before the threshold", () => {
      const { spool } = fixture();
      const reader = new HookSpoolReader(spool);
      const start = Date.now();
      putRecord(spool, 1, "One");
      putRecord(spool, 3, "Three");
      expect(reader.read(start).records.map(toolOf)).toEqual(["One"]);
      expect(reader.read(start + 3_000)).toEqual({ records: [], unreadable: 0 });
      expect(reader.read(start + 8_000)).toEqual({ records: [], unreadable: 0 });
      putRecord(spool, 2, "Two");
      expect(reader.read(start + 9_000).records.map(toolOf)).toEqual([
        "Two",
        "Three",
      ]);
    });

    it("skips a gap that persisted past the threshold, reports it once as lost evidence, and keeps reading", () => {
      const { spool } = fixture();
      const reader = new HookSpoolReader(spool);
      const start = Date.now();
      putRecord(spool, 1, "One");
      putRecord(spool, 3, "Three");
      expect(reader.read(start).records.map(toolOf)).toEqual(["One"]);
      expect(reader.read(start + 3_000)).toEqual({ records: [], unreadable: 0 });
      const skipped = reader.read(start + 11_000);
      expect(skipped.records.map(toolOf)).toEqual(["Three"]);
      expect(skipped.unreadable).toBe(1);
      putRecord(spool, 4, "Four");
      expect(reader.read(start + 13_000)).toEqual({
        records: [{ hook_event_name: "PermissionRequest", session_id: SESSION_ID, tool_name: "Four" }],
        unreadable: 0,
      });
    });

    it("counts a record that appears in a skipped number as late or lost, once, and never applies it out of order", () => {
      const { spool } = fixture();
      const reader = new HookSpoolReader(spool);
      const start = Date.now();
      putRecord(spool, 1, "One");
      putRecord(spool, 3, "Three");
      reader.read(start);
      reader.read(start + 3_000);
      reader.read(start + 11_000);
      putRecord(spool, 2, "Two");
      const late = reader.read(start + 14_000);
      expect(late).toEqual({ records: [], unreadable: 1 });
      expect(statSync(path.join(spool, "000000000002")).size).toBe(0);
      expect(reader.read(start + 17_000)).toEqual({
        records: [],
        unreadable: 0,
      });
    });

    it("does not deliver a record twice when it is read repeatedly", async () => {
      const { commandFor, spool } = fixture();
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "Once" }),
      );
      const reader = new HookSpoolReader(spool);
      expect(reader.read().records.map(toolOf)).toEqual(["Once"]);
      expect(reader.read()).toEqual({ records: [], unreadable: 0 });
      expect(reader.read()).toEqual({ records: [], unreadable: 0 });
    });

    it("truncates consumed records instead of deleting them, so a number is never reused", async () => {
      const { commandFor, spool } = fixture();
      const command = commandFor("PermissionRequest");
      await runWhole(command, record("PermissionRequest", { tool_name: "A" }));
      new HookSpoolReader(spool).read();
      await runWhole(command, record("PermissionRequest", { tool_name: "B" }));
      expect(published(spool)).toEqual(["000000000001", "000000000002"]);
    });

    it("lets the reader treat a killed hook as lost evidence: no Working, no heartbeat, until the next prompt", async () => {
      const { commandFor, reader, spool, unconfirmed } = fixture();
      const dying = startHook(commandFor("PermissionRequest"));
      dying.child.stdin.write(`{"hook_event_name":"PermissionRequest"`);
      await until(() => leftovers(spool).length === 1, "the temp file");
      dying.child.kill("SIGKILL");
      await dying.exited;

      expect(reader.read()).toEqual([]);
      expect(unconfirmed).toEqual([{ reason: "unreadable-record", total: 1 }]);
      expect(reader.heartbeat()).toBeNull();

      await runWhole(
        commandFor("PreToolUse"),
        record("PreToolUse", { tool_name: "Read" }),
      );
      expect(reader.read()).toEqual([]);
      expect(reader.heartbeat()).toBeNull();

      await runWhole(
        commandFor("UserPromptSubmit"),
        record("UserPromptSubmit", { prompt: "next" }),
      );
      expect(reader.read()).toEqual([{ prompt: "next", state: "working" }]);
      expect(reader.heartbeat()).toEqual({ prompt: null, state: "working" });
    });

    it("control: the same tool activity without a lost record shows Working", async () => {
      const { commandFor, reader, unconfirmed } = fixture();
      await runWhole(
        commandFor("PreToolUse"),
        record("PreToolUse", { tool_name: "Read" }),
      );
      expect(reader.read()).toEqual([{ prompt: null, state: "working" }]);
      expect(unconfirmed).toEqual([]);
    });

    it("control: concurrent openers reach the reader as questions in order", async () => {
      const { commandFor, reader } = fixture();
      const command = commandFor("PermissionRequest");
      for (const tool of ["Alpha", "Beta", "Gamma"]) {
        await runWhole(
          command,
          record("PermissionRequest", {
            permission_suggestions: [],
            tool_name: tool,
          }),
        );
      }
      const last = reader.read().at(-1);
      expect(
        last?.state === "waiting" ? last.questions.map((q) => q.prompt) : [],
      ).toEqual(
        ["Alpha", "Beta", "Gamma"].map(
          (tool) => `Claude Code needs permission to use: ${tool}`,
        ),
      );
    });
  },
);
