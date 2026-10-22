import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { readFile as readFilePromise } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import type { ProviderNativeTerminal } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeActivityHookSettings } from "../native-activity.js";
import { NativeActivityReader } from "../native-activity-reader.js";
import {
  createHookSpool,
  HookAppendReader,
  hookAppendCommand,
  HookSpoolReader,
  removeHookSpool,
  reserveSequence,
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
const children: ChildProcess[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  child: ChildProcessByStdio<Writable, null, null>;
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
        await runWhole(
          command,
          record("PermissionRequest", { tool_name: tool }),
        );
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

      await runWhole(
        command,
        record("PermissionRequest", { tool_name: "Fast" }),
      );
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

      await runWhole(
        command,
        record("PermissionRequest", { tool_name: "Next" }),
      );
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
      expect(reader.read(start + 3_000)).toEqual({
        records: [],
        unreadable: 0,
      });
      expect(reader.read(start + 8_000)).toEqual({
        records: [],
        unreadable: 0,
      });
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
      expect(reader.read(start + 3_000)).toEqual({
        records: [],
        unreadable: 0,
      });
      const skipped = reader.read(start + 11_000);
      expect(skipped.records.map(toolOf)).toEqual(["Three"]);
      expect(skipped.unreadable).toBe(1);
      expect(statSync(path.join(spool, "000000000002")).size).toBe(0);
      putRecord(spool, 4, "Four");
      expect(reader.read(start + 13_000)).toEqual({
        records: [
          {
            hook_event_name: "PermissionRequest",
            session_id: SESSION_ID,
            tool_name: "Four",
          },
        ],
        unreadable: 0,
      });
    });

    it("counts content that an external writer puts into a reserved number as lost evidence, once, and never applies it", () => {
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

    it("reserves a skipped number exclusively, so a publisher with a stale hint moves on to the next free number and its record is read in order", async () => {
      const { commandFor, spool } = fixture();
      const command = commandFor("PermissionRequest");
      await runWhole(
        command,
        record("PermissionRequest", { tool_name: "One" }),
      );
      putRecord(spool, 3, "Three");
      expect(readFileSync(path.join(spool, ".hint"), "utf8")).toBe("1");

      const reader = new HookSpoolReader(spool);
      const start = Date.now();
      expect(reader.read(start).records.map(toolOf)).toEqual(["One"]);
      expect(reader.read(start + 3_000).records).toEqual([]);
      const skipped = reader.read(start + 11_000);
      expect(skipped.records.map(toolOf)).toEqual(["Three"]);
      expect(skipped.unreadable).toBe(1);
      expect(statSync(path.join(spool, "000000000002")).size).toBe(0);

      await runWhole(
        command,
        record("PermissionRequest", { tool_name: "Four" }),
      );
      expect(published(spool)).toEqual([
        "000000000001",
        "000000000002",
        "000000000003",
        "000000000004",
      ]);
      expect(reader.read(start + 12_000)).toEqual({
        records: [
          {
            hook_event_name: "PermissionRequest",
            session_id: SESSION_ID,
            tool_name: "Four",
          },
        ],
        unreadable: 0,
      });
    });

    it("reserves with an exclusive create: a free number is taken, a published record is left intact, an unreachable directory is reported", () => {
      const { spool } = fixture();
      putRecord(spool, 5, "Five");
      const before = readFileSync(path.join(spool, "000000000005"), "utf8");
      expect(reserveSequence(spool, 5)).toBe("present");
      expect(readFileSync(path.join(spool, "000000000005"), "utf8")).toBe(
        before,
      );
      expect(reserveSequence(spool, 6)).toBe("reserved");
      expect(reserveSequence(spool, 6)).toBe("present");
      expect(reserveSequence(path.join(spool, "missing"), 7)).toBe("failed");
    });

    it("keeps Needs input alive behind a lost record, and an ordinary Working record after it does not erase the loss", async () => {
      const { commandFor, reader, spool, unconfirmed } = fixture();
      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => t0);
      await runWhole(
        commandFor("UserPromptSubmit"),
        record("UserPromptSubmit", { prompt: "go" }),
      );
      await runWhole(
        commandFor("PreToolUse"),
        record("PreToolUse", { tool_name: "Lost" }),
      );
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "Bash" }),
      );
      await runWhole(
        commandFor("PreToolUse"),
        record("PreToolUse", { tool_name: "Read" }),
      );
      rmSync(path.join(spool, "000000000002"));

      expect(reader.read()).toEqual([{ prompt: "go", state: "working" }]);
      clock.mockImplementation(() => t0 + 3_000);
      expect(reader.read()).toEqual([]);
      expect(unconfirmed).toEqual([]);

      clock.mockImplementation(() => t0 + 12_000);
      const reports = reader.read();
      expect(unconfirmed).toEqual([{ reason: "unreadable-record", total: 1 }]);
      expect(reports.some((report) => report.state === "working")).toBe(false);
      const last = reports.at(-1);
      expect(
        last?.state === "waiting"
          ? last.questions.map((question) => question.prompt)
          : [],
      ).toEqual(["Claude Code needs permission to use: Bash"]);
      expect(reader.heartbeat()).toBeNull();
    });

    it("does not truncate a regular file that replaced a consumed spool file between the read and the truncation, counts it once, and reads its record on the next step", () => {
      const { spool } = fixture();
      const reader = new HookSpoolReader(spool);
      const first = path.join(spool, "000000000001");
      writeFileSync(first, record("PermissionRequest", { tool_name: "First" }));
      const step = reader.readNext();
      if (step.kind !== "consumed") throw new Error("expected a record");
      expect(step.records.map(toolOf)).toEqual(["First"]);
      const replacement = path.join(spool, "replacement");
      writeFileSync(
        replacement,
        record("PermissionRequest", { tool_name: "Second" }),
      );
      renameSync(replacement, first);
      expect(step.settle()).toBe(1);
      expect(readFileSync(first, "utf8")).toBe(
        record("PermissionRequest", { tool_name: "Second" }),
      );
      const next = reader.readNext();
      if (next.kind !== "consumed") throw new Error("expected the replacement");
      expect(next.records.map(toolOf)).toEqual(["Second"]);
      expect(next.settle()).toBe(0);
      expect(statSync(first).size).toBe(0);
    });

    it("truncates a consumed spool file that the publishing hook still has a temp link to: the link count is not required in the spool", () => {
      const { spool } = fixture();
      const reader = new HookSpoolReader(spool);
      const first = path.join(spool, "000000000001");
      writeFileSync(first, record("PermissionRequest", { tool_name: "First" }));
      linkSync(first, path.join(spool, ".tmp.1.link"));
      const step = reader.readNext();
      if (step.kind !== "consumed") throw new Error("expected a record");
      expect(step.settle()).toBe(0);
      expect(statSync(first).size).toBe(0);
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

describe.skipIf(process.platform === "win32")(
  `the append fallback, used only when no candidate directory supports links ${platformNote}`,
  () => {
    function appendFixture() {
      const cli = claudeDeclaration();
      const hooks = cli.activity?.hooks;
      if (hooks === undefined) throw new Error("Claude hooks missing");
      const directory = createHookSpool(os.tmpdir(), "append-test");
      spools.push(directory);
      const file = path.join(directory, "hooks.jsonl");
      writeFileSync(file, "", { mode: 0o600 });
      const settings: {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      } = JSON.parse(nativeActivityHookSettings(hooks, { appendFile: file }));
      const commandFor = (event: string): string => {
        const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
        if (command === undefined)
          throw new Error(`no hook command for ${event}`);
        return command;
      };
      const unconfirmed: Array<{ reason: string; total: number }> = [];
      const reader = new NativeActivityReader(
        cli,
        { HOME: os.tmpdir() },
        { appendFile: file },
        { kind: "start", id: SESSION_ID },
        undefined,
        (reason, total) => unconfirmed.push({ reason, total }),
      );
      return {
        commandFor,
        directory,
        file,
        lock: path.join(directory, "hooks.lock"),
        reader,
        unconfirmed,
      };
    }

    const markers = (directory: string): string[] =>
      readdirSync(directory).filter((name) => name.startsWith(".tmp."));

    it("delivers Needs input through the append file: the opener reaches the reader as a waiting question", async () => {
      const { commandFor, reader } = appendFixture();
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", {
          permission_suggestions: [],
          tool_name: "Bash",
        }),
      );
      const last = reader.read().at(-1);
      expect(
        last?.state === "waiting"
          ? last.questions.map((question) => question.prompt)
          : [],
      ).toEqual(["Claude Code needs permission to use: Bash"]);
    });

    it("serializes concurrent appenders: 1 MiB records and the empty-array shape arrive whole and in file order, with no marker left behind", async () => {
      const { commandFor, directory, file } = appendFixture();
      const command = commandFor("PermissionRequest");
      const big = "z".repeat(1024 * 1024);
      const tools = Array.from({ length: 8 }, (_, index) => `Tool${index}`);
      await Promise.all(
        tools.map((tool, index) =>
          runWhole(
            command,
            record("PermissionRequest", {
              permission_suggestions: [],
              tool_input: { content: index % 2 === 0 ? big : "small" },
              tool_name: tool,
            }),
          ),
        ),
      );
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(tools.length);
      const read = new HookAppendReader(file).read();
      expect(read.unreadable).toBe(0);
      expect(read.records.map(toolOf)).toEqual(
        lines.map((line) => toolOf(JSON.parse(line))),
      );
      expect([...read.records.map(toolOf)].sort()).toEqual([...tools].sort());
      expect(markers(directory)).toEqual([]);
      expect(readdirSync(directory).includes("hooks.lock")).toBe(false);
    }, 30_000);

    const deadPid = async (): Promise<number> => {
      const child = spawn("sh", ["-c", "exit 0"]);
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      await exited;
      if (child.pid === undefined) throw new Error("no pid");
      return child.pid;
    };

    it("makes a hook wait for a lock held by a live process, and appends once it is released", async () => {
      const { commandFor, directory, file, lock } = appendFixture();
      symlinkSync(String(process.pid), lock);
      const waiting = startHook(commandFor("PermissionRequest"));
      waiting.child.stdin.end(
        record("PermissionRequest", { tool_name: "Held" }),
      );
      await until(() => markers(directory).length === 1, "the hook marker");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(statSync(file).size).toBe(0);
      rmSync(lock);
      await waiting.exited;
      expect(new HookAppendReader(file).read().records.map(toolOf)).toEqual([
        "Held",
      ]);
      expect(markers(directory)).toEqual([]);
    }, 30_000);

    it("does not give up on a slow live holder: a waiter that waits several seconds still appends its record", async () => {
      const { commandFor, directory, file, lock } = appendFixture();
      symlinkSync(String(process.pid), lock);
      const waiting = startHook(commandFor("PermissionRequest"));
      waiting.child.stdin.end(
        record("PermissionRequest", { tool_name: "Patient" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(statSync(file).size).toBe(0);
      expect(
        readdirSync(directory).some(
          (name) => name.startsWith(".lost.") || name.startsWith(".late."),
        ),
      ).toBe(false);
      rmSync(lock);
      await waiting.exited;
      expect(new HookAppendReader(file).read().records.map(toolOf)).toEqual([
        "Patient",
      ]);
    }, 30_000);

    it("leaves neither a lock nor a marker behind after a normal append", async () => {
      const { commandFor, directory, file } = appendFixture();
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "Once" }),
      );
      expect(readdirSync(directory)).toEqual(["hooks.jsonl"]);
      expect(new HookAppendReader(file).read().records.map(toolOf)).toEqual([
        "Once",
      ]);
    });

    it("holds the lock for the whole append, as a symlink naming its own pid, and releases it afterwards", async () => {
      const { commandFor, file, lock } = appendFixture();
      rmSync(file);
      spawnSync("mkfifo", [file]);
      const writer = startHook(commandFor("PermissionRequest"));
      const payload = record("PermissionRequest", { tool_name: "Fifo" });
      writer.child.stdin.end(payload);
      await until(() => {
        try {
          return lstatSync(lock).isSymbolicLink();
        } catch {
          return false;
        }
      }, "the lock");
      expect(readlinkSync(lock)).toBe(String(writer.child.pid));
      expect(await readFilePromise(file, "utf8")).toBe(`${payload}\n`);
      await writer.exited;
      expect(() => lstatSync(lock)).toThrow();
    }, 30_000);

    it("never breaks a lock whose holder is alive, however old, until the pid-reuse bound; then breaks it and counts it", () => {
      const { directory, file, lock } = appendFixture();
      symlinkSync(String(process.pid), lock);
      const reader = new HookAppendReader(file);
      const start = Date.now();
      expect(reader.read(start)).toEqual({ records: [], unreadable: 0 });
      expect(reader.read(start + 11_000).unreadable).toBe(0);
      expect(reader.read(start + 5 * 60_000).unreadable).toBe(0);
      expect(readdirSync(directory)).toContain("hooks.lock");
      expect(reader.read(start + 11 * 60_000).unreadable).toBe(1);
      expect(
        readdirSync(directory).filter((name) => name.startsWith("hooks.lock")),
      ).toEqual([]);
    });

    it("breaks the lock of a dead holder at once, counts it once, and lets the next hook append", async () => {
      const { commandFor, directory, file, lock } = appendFixture();
      symlinkSync(String(await deadPid()), lock);
      const reader = new HookAppendReader(file);
      const start = Date.now();
      expect(reader.read(start)).toEqual({ records: [], unreadable: 1 });
      expect(
        readdirSync(directory).filter((name) => name.startsWith("hooks.lock")),
      ).toEqual([]);
      expect(reader.read(start + 3_000).unreadable).toBe(0);
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "After" }),
      );
      expect(reader.read(start + 6_000).records.map(toolOf)).toEqual(["After"]);
    });

    it("handles the mkdir lock used where symlinks are unsupported: a dead pid inside is broken, a lock with no pid is live until the bound", async () => {
      const { directory, file, lock } = appendFixture();
      mkdirSync(lock);
      const reader = new HookAppendReader(file);
      const start = Date.now();
      expect(reader.read(start).unreadable).toBe(0);
      expect(reader.read(start + 11_000).unreadable).toBe(0);
      writeFileSync(path.join(lock, "pid"), String(await deadPid()));
      expect(reader.read(start + 14_000).unreadable).toBe(1);
      expect(
        readdirSync(directory).filter((name) => name.startsWith("hooks.lock")),
      ).toEqual([]);
      mkdirSync(lock);
      expect(reader.read(start + 17_000).unreadable).toBe(0);
      expect(reader.read(start + 11 * 60_000).unreadable).toBe(1);
    });

    it("waits behind a lock directory held by a live process: ln -s must not be taken for the lock when it only landed inside that directory", async () => {
      const { commandFor, directory, file, lock } = appendFixture();
      mkdirSync(lock);
      writeFileSync(path.join(lock, "pid"), String(process.pid));
      const waiting = startHook(commandFor("PermissionRequest"));
      waiting.child.stdin.end(
        record("PermissionRequest", { tool_name: "Dir" }),
      );
      await until(() => markers(directory).length === 1, "the hook marker");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statSync(file).size).toBe(0);
      expect(lstatSync(lock).isDirectory()).toBe(true);
      rmSync(lock, { force: true, maxRetries: 10, recursive: true });
      await waiting.exited;
      expect(new HookAppendReader(file).read().records.map(toolOf)).toEqual([
        "Dir",
      ]);
    }, 30_000);

    const forcedDeadline = async (
      file: string,
      payload: string,
      wrapper = "",
    ): Promise<void> => {
      const child = spawn(
        "sh",
        ["-c", `${wrapper}${hookAppendCommand(file, 1)}`],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      children.push(child);
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.stdin.end(payload);
      await exited;
    };

    const lateFiles = (directory: string): string[] =>
      readdirSync(directory).filter((name) => /^\.late\.\d+\.\d+$/u.test(name));

    it("at its wall-clock deadline publishes its in-memory record as .late.<pid>.<start> and removes its marker, instead of losing it", async () => {
      const { directory, file, lock } = appendFixture();
      symlinkSync(String(process.pid), lock);
      const began = Math.floor(Date.now() / 1000);
      await forcedDeadline(
        file,
        record("PermissionRequest", { tool_name: "Late" }),
      );
      expect(statSync(file).size).toBe(0);
      expect(markers(directory)).toEqual([]);
      expect(
        readdirSync(directory).filter((name) => name.startsWith(".lost.")),
      ).toEqual([]);
      const [late] = lateFiles(directory);
      expect(lateFiles(directory)).toHaveLength(1);
      expect(Number(late?.split(".").at(-1))).toBeGreaterThanOrEqual(began);
      const read = new HookAppendReader(file).read();
      expect(read.unreadable).toBe(1);
      expect(read.late?.map((entry) => toolOf(entry.record))).toEqual(["Late"]);
      expect(
        new HookAppendReader(file).read(Date.now() + 3_000).late,
      ).toBeUndefined();
    }, 30_000);

    it("keeps .lost only for a hook that cannot even write its late file, and the reader counts it at once", async () => {
      const { directory, file, lock } = appendFixture();
      symlinkSync(String(process.pid), lock);
      await forcedDeadline(
        file,
        record("PermissionRequest", { tool_name: "Nowhere" }),
        "trap '' XFSZ; ulimit -f 0; ",
      );
      expect(lateFiles(directory)).toEqual([]);
      expect(markers(directory)).toEqual([]);
      expect(
        readdirSync(directory).filter((name) => name.startsWith(".lost.")),
      ).toHaveLength(1);
      const reader = new HookAppendReader(file);
      expect(reader.read().unreadable).toBe(1);
      expect(reader.read(Date.now() + 3_000).unreadable).toBe(0);
    }, 30_000);

    it("delivers a late PermissionRequest as Needs input while still counting the loss, and refuses a late close or state change", async () => {
      const { commandFor, directory, file, lock, reader, unconfirmed } =
        appendFixture();
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "Bash" }),
      );
      expect(reader.read().at(-1)).toMatchObject({
        questions: [{ prompt: "Claude Code needs permission to use: Bash" }],
        state: "waiting",
      });
      symlinkSync(String(process.pid), lock);
      await forcedDeadline(file, record("PostToolUse", { tool_name: "Bash" }));
      await forcedDeadline(
        file,
        record("UserPromptSubmit", { prompt: "late prompt" }),
      );
      expect(lateFiles(directory)).toHaveLength(2);
      expect(reader.read()).toEqual([]);
      expect(unconfirmed).toEqual([{ reason: "unreadable-record", total: 2 }]);
      expect(reader.heartbeat()).toBeNull();

      await forcedDeadline(
        file,
        record("PermissionRequest", { tool_name: "Edit" }),
      );
      const reports = reader.read();
      expect(unconfirmed.at(-1)).toEqual({
        reason: "unreadable-record",
        total: 3,
      });
      expect(reports.some((report) => report.state === "working")).toBe(false);
      const last = reports.at(-1);
      expect(
        last?.state === "waiting"
          ? last.questions.map((question) => question.prompt).sort()
          : [],
      ).toEqual([
        "Claude Code needs permission to use: Bash",
        "Claude Code needs permission to use: Edit",
      ]);
      expect(reader.heartbeat()).toBeNull();
    }, 30_000);

    it("refuses a late opener whose close was already applied here", async () => {
      const { directory, file, lock, reader } = appendFixture();
      symlinkSync(String(process.pid), lock);
      const late = spawn("sh", ["-c", hookAppendCommand(file, 2)], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      children.push(late);
      const exited = new Promise<void>((resolve) => {
        late.once("exit", () => resolve());
      });
      late.stdin.end(record("PermissionRequest", { tool_name: "Bash" }));
      await until(() => markers(directory).length === 1, "the hook marker");
      appendFileSync(file, `${record("PostToolUse", { tool_name: "Bash" })}\n`);
      expect(reader.read()).toEqual([]);
      await exited;
      expect(lateFiles(directory)).toHaveLength(1);
      expect(reader.read()).toEqual([]);
    }, 30_000);

    it("does not take a lock that is a symlink naming something other than its own pid: ln -s lands inside the target, so the hook keeps waiting until the lock is released", async () => {
      const { commandFor, directory, file, lock } = appendFixture();
      const elsewhere = path.join(directory, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, lock);
      const waiting = startHook(commandFor("PermissionRequest"));
      waiting.child.stdin.end(
        record("PermissionRequest", { tool_name: "Foreign" }),
      );
      await until(() => markers(directory).length === 1, "the hook marker");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statSync(file).size).toBe(0);
      expect(readlinkSync(lock)).toBe(elsewhere);
      rmSync(lock);
      await waiting.exited;
      expect(new HookAppendReader(file).read().records.map(toolOf)).toEqual([
        "Foreign",
      ]);
    }, 30_000);

    it("evaluates a late opener before the same-tool close that follows it: the steps of a poll are separately callable, and main-file lines past the snapshot wait", () => {
      const { directory, file } = appendFixture();
      const reader = new HookAppendReader(file);
      const began = Math.floor(Date.now() / 1000);
      const now = Date.now();
      const snapshot = reader.takeSnapshot();
      appendFileSync(file, `${record("PostToolUse", { tool_name: "Bash" })}\n`);
      writeFileSync(
        path.join(directory, `.late.99999.${began}`),
        record("PermissionRequest", { tool_name: "Bash" }),
      );
      const late = reader.readLate();
      expect(late.lost).toBe(1);
      expect(
        late.records.map((entry) => [toolOf(entry.record), entry.startedAt]),
      ).toEqual([["Bash", began]]);
      expect(reader.readLines(now, snapshot)).toEqual({
        records: [],
        unreadable: 0,
      });
      expect(reader.readLines(now, reader.takeSnapshot()).records).toEqual([
        {
          hook_event_name: "PostToolUse",
          session_id: SESSION_ID,
          tool_name: "Bash",
        },
      ]);
    });

    it("does not take the lock of a hook that released in between: B's ln -s lands inside A's lock directory, A releases, Y takes a symlink lock, and B must not append while Y holds it", async () => {
      const { directory, file, lock } = appendFixture();
      const realLn = spawnSync("sh", ["-c", "command -v ln"])
        .stdout.toString()
        .trim();
      const shimDir = path.join(directory, "shim");
      const gate = path.join(directory, "gate-open");
      const blocked = path.join(directory, "gate-reached");
      const calls = path.join(directory, "ln-calls");
      const callCount = (): number =>
        existsSync(calls)
          ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length
          : 0;
      mkdirSync(shimDir);
      const shim = path.join(shimDir, "ln");
      writeFileSync(
        shim,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$PPID" >> '${calls}'`,
          `${realLn} "$@"`,
          "status=$?",
          `if [ ! -e '${blocked}' ]; then`,
          `  : > '${blocked}'`,
          "  i=0",
          `  while [ ! -e '${gate}' ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i+1)); done`,
          "fi",
          "exit $status",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      mkdirSync(lock);
      writeFileSync(path.join(lock, "pid"), String(process.pid));
      const command = hookAppendCommand(file);
      const hook = spawn("sh", ["-c", command], {
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
        stdio: ["pipe", "ignore", "ignore"],
      });
      children.push(hook);
      const killer = setTimeout(() => hook.kill("SIGKILL"), 20_000);
      const exited = new Promise<void>((resolve) => {
        hook.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
      hook.stdin.end(record("PermissionRequest", { tool_name: "Interleave" }));
      await until(() => existsSync(blocked), "the hook's ln -s to land");
      expect(callCount()).toBe(1);
      expect(readFileSync(calls, "utf8").trim()).toBe(String(hook.pid));
      expect(lstatSync(lock).isDirectory()).toBe(true);
      expect(readdirSync(lock)).toContain(String(hook.pid));

      rmSync(lock, { recursive: true });
      symlinkSync(String(process.pid), lock);
      writeFileSync(gate, "");
      await until(
        () => callCount() >= 2 || statSync(file).size > 0,
        "the hook's next state: another ln -s attempt or an append",
      );
      expect(statSync(file).size).toBe(0);
      expect(callCount()).toBeGreaterThanOrEqual(2);
      expect(readlinkSync(lock)).toBe(String(process.pid));

      rmSync(lock);
      await exited;
      expect(new HookAppendReader(file).read().records.map(toolOf)).toEqual([
        "Interleave",
      ]);
    }, 40_000);

    it("does not truncate a regular file that replaced a late file between the read and the truncation, and reads its record on the next poll", () => {
      const { directory, file } = appendFixture();
      const name = `.late.1.${Math.floor(Date.now() / 1000)}`;
      const late = path.join(directory, name);
      writeFileSync(late, record("PermissionRequest", { tool_name: "First" }));
      const reader = new HookAppendReader(file);
      const [entry] = reader.listLate();
      if (entry === undefined) throw new Error("no late file listed");
      const step = reader.readLateFile(entry);
      expect(toolOf(step.record?.record)).toBe("First");
      const replacement = path.join(directory, "replacement");
      writeFileSync(
        replacement,
        record("PermissionRequest", { tool_name: "Second" }),
      );
      renameSync(replacement, late);
      expect(step.settle()).toBe(0);
      expect(readFileSync(late, "utf8")).toBe(
        record("PermissionRequest", { tool_name: "Second" }),
      );
      const next = reader.readLate();
      expect(next.records.map((entry) => toolOf(entry.record))).toEqual([
        "Second",
      ]);
      expect(next.lost).toBe(1);
      expect(statSync(late).size).toBe(0);
    });

    it("does not truncate a late file that has another hard link, and counts it once", () => {
      const { directory, file } = appendFixture();
      const late = path.join(
        directory,
        `.late.1.${Math.floor(Date.now() / 1000)}`,
      );
      writeFileSync(late, record("PermissionRequest", { tool_name: "Linked" }));
      linkSync(late, path.join(directory, "elsewhere-link"));
      const reader = new HookAppendReader(file);
      const [entry] = reader.listLate();
      if (entry === undefined) throw new Error("no late file listed");
      const step = reader.readLateFile(entry);
      expect(toolOf(step.record?.record)).toBe("Linked");
      expect(step.settle()).toBe(1);
      expect(statSync(late).size).toBeGreaterThan(0);
    });

    it("truncates a late file that does not parse, after counting it", () => {
      const { directory, file } = appendFixture();
      const late = path.join(
        directory,
        `.late.1.${Math.floor(Date.now() / 1000)}`,
      );
      writeFileSync(late, "{not json");
      const read = new HookAppendReader(file).read();
      expect(read.unreadable).toBe(1);
      expect(read.late).toBeUndefined();
      expect(statSync(late).size).toBe(0);
    });

    it("counts each episode of a main file that is not a regular file, and reads the new regular file from its start", () => {
      const { file } = appendFixture();
      const reader = new HookAppendReader(file);
      const started = Date.now();
      writeFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Aaa" })}\n`,
      );
      expect(reader.read(started).records.map(toolOf)).toEqual(["Aaa"]);

      renameSync(file, `${file}.kept`);
      spawnSync("mkfifo", [file]);
      expect(reader.read(started + 1).unreadable).toBe(1);
      expect(reader.read(started + 2).unreadable).toBe(0);

      rmSync(file);
      writeFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Bbb" })}\n`,
      );
      const back = reader.read(started + 3);
      expect(back.records.map(toolOf)).toEqual(["Bbb"]);
      expect(back.unreadable).toBe(0);

      rmSync(file);
      spawnSync("mkfifo", [file]);
      expect(reader.read(started + 4).unreadable).toBe(1);
    });

    it.skipIf(process.getuid?.() === 0)(
      "does not replay the main file when it comes back after a transient open error: the error episode is counted, the original file is not re-read (skipped when running as root, which ignores file modes)",
      () => {
        const { file } = appendFixture();
        const reader = new HookAppendReader(file);
        const started = Date.now();
        writeFileSync(
          file,
          `${record("PermissionRequest", { tool_name: "Aaa" })}\n`,
        );
        expect(reader.read(started).records.map(toolOf)).toEqual(["Aaa"]);
        chmodSync(file, 0o000);
        expect(reader.read(started + 1).unreadable).toBe(1);
        expect(reader.read(started + 2).unreadable).toBe(0);
        chmodSync(file, 0o600);
        appendFileSync(
          file,
          `${record("PermissionRequest", { tool_name: "Bbb" })}\n`,
        );
        const back = reader.read(started + 3);
        expect(back.records.map(toolOf)).toEqual(["Bbb"]);
        expect(back.unreadable).toBe(0);
      },
    );

    it("does not replay the main file when the original comes back after a FIFO episode: the episode is counted, the original is not re-read", () => {
      const { file } = appendFixture();
      const reader = new HookAppendReader(file);
      const started = Date.now();
      writeFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Aaa" })}\n`,
      );
      expect(reader.read(started).records.map(toolOf)).toEqual(["Aaa"]);
      renameSync(file, `${file}.original`);
      spawnSync("mkfifo", [file]);
      expect(reader.read(started + 1).unreadable).toBe(1);
      expect(reader.read(started + 2).unreadable).toBe(0);
      rmSync(file);
      renameSync(`${file}.original`, file);
      appendFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Bbb" })}\n`,
      );
      const back = reader.read(started + 3);
      expect(back.records.map(toolOf)).toEqual(["Bbb"]);
      expect(back.unreadable).toBe(0);
    });

    it("detects a main file that was truncated below the read offset, restarts from 0 and counts it once", () => {
      const { file } = appendFixture();
      const reader = new HookAppendReader(file);
      const started = Date.now();
      writeFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Aaa" })}\n${record("PermissionRequest", { tool_name: "Bbb" })}\n`,
      );
      expect(reader.read(started).records.map(toolOf)).toEqual(["Aaa", "Bbb"]);
      truncateSync(file, 0);
      appendFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Ccc" })}\n`,
      );
      const shrunk = reader.read(started + 1);
      expect(shrunk.records.map(toolOf)).toEqual(["Ccc"]);
      expect(shrunk.unreadable).toBe(1);
      expect(reader.read(started + 2)).toEqual({ records: [], unreadable: 0 });
    });

    it("resets the offset and counts it when the main file is replaced by another regular file", () => {
      const { directory, file } = appendFixture();
      const reader = new HookAppendReader(file);
      const started = Date.now();
      writeFileSync(
        file,
        `${record("PermissionRequest", { tool_name: "Aaa" })}\n`,
      );
      expect(reader.read(started).records.map(toolOf)).toEqual(["Aaa"]);
      const replacement = path.join(directory, "replacement");
      writeFileSync(
        replacement,
        `${record("PermissionRequest", { tool_name: "Bbb" })}\n`,
      );
      renameSync(replacement, file);
      const replaced = reader.read(started + 1);
      expect(replaced.records.map(toolOf)).toEqual(["Bbb"]);
      expect(replaced.unreadable).toBe(1);
      expect(reader.read(started + 2)).toEqual({ records: [], unreadable: 0 });
    });

    it("takes the snapshot before it reads the late files: a same-tool close appended while the late files are read waits for the next poll", () => {
      const { directory, file } = appendFixture();
      const reader = new HookAppendReader(file);
      writeFileSync(
        path.join(directory, `.late.1.${Math.floor(Date.now() / 1000)}`),
        record("PermissionRequest", { tool_name: "Bash" }),
      );
      const closeRecord = record("PostToolUse", { tool_name: "Bash" });
      const original = reader.readLate.bind(reader);
      vi.spyOn(reader, "readLate").mockImplementation(() => {
        appendFileSync(file, `${closeRecord}\n`);
        return original();
      });
      const now = Date.now();
      const first = reader.read(now);
      expect(first.late?.map((entry) => toolOf(entry.record))).toEqual([
        "Bash",
      ]);
      expect(first.records).toEqual([]);
      expect(reader.read(now + 1).records).toEqual([JSON.parse(closeRecord)]);
    });

    it("counts a hook killed before it appended as lost evidence, and withholds Working until the next prompt", async () => {
      const { commandFor, directory, reader, unconfirmed } = appendFixture();
      const dying = startHook(commandFor("PermissionRequest"));
      dying.child.stdin.write(`{"hook_event_name":"PermissionRequest"`);
      await until(() => markers(directory).length === 1, "the hook marker");
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

    it("waits for the end of a line and reads records in order", async () => {
      const { commandFor, file } = appendFixture();
      const reader = new HookAppendReader(file);
      appendFileSync(file, `{"tool_name":"Half"`);
      expect(reader.read()).toEqual({ records: [], unreadable: 0 });
      appendFileSync(file, "}\n");
      expect(reader.read()).toEqual({
        records: [{ tool_name: "Half" }],
        unreadable: 0,
      });
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "A" }),
      );
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "B" }),
      );
      expect(reader.read().records.map(toolOf)).toEqual(["A", "B"]);
      expect(reader.read()).toEqual({ records: [], unreadable: 0 });
    });

    it("counts a line that stays incomplete past the threshold once, and still applies it if it completes later", () => {
      const { file } = appendFixture();
      const reader = new HookAppendReader(file);
      const start = Date.now();
      appendFileSync(file, `{"tool_name":"Slow"`);
      expect(reader.read(start)).toEqual({ records: [], unreadable: 0 });
      expect(reader.read(start + 5_000)).toEqual({
        records: [],
        unreadable: 0,
      });
      expect(reader.read(start + 11_000)).toEqual({
        records: [],
        unreadable: 1,
      });
      expect(reader.read(start + 13_000)).toEqual({
        records: [],
        unreadable: 0,
      });
      appendFileSync(file, "}\n");
      expect(reader.read(start + 14_000)).toEqual({
        records: [{ tool_name: "Slow" }],
        unreadable: 0,
      });
    });

    it("counts a dead writer's torn bytes joined by the next record as lost evidence and does not apply either", async () => {
      const { commandFor, file } = appendFixture();
      const reader = new HookAppendReader(file);
      appendFileSync(file, `{"hook_event_name":"PermissionRequest"`);
      await runWhole(
        commandFor("PermissionRequest"),
        record("PermissionRequest", { tool_name: "Joined" }),
      );
      const read = reader.read();
      expect(read.records).toEqual([]);
      expect(read.unreadable).toBe(1);
    });
  },
);
