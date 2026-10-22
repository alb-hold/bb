import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { nativeActivityHookSettings } from "../native-activity.js";
import { NativeActivityReader } from "../native-activity-reader.js";

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
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
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
  const home = mkdtempSync(path.join(os.tmpdir(), "bb-hook-io-"));
  roots.push(home);
  const events = path.join(home, "hooks.jsonl");
  writeFileSync(events, "", { mode: 0o600 });
  const settings: {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  } = JSON.parse(nativeActivityHookSettings(hooks, events));
  const commandFor = (event: string): string => {
    const command = settings.hooks[event]?.[0]?.hooks[0]?.command;
    if (command === undefined) throw new Error(`no hook command for ${event}`);
    return command;
  };
  const unconfirmed: Array<{ reason: string; total: number }> = [];
  const reader = new NativeActivityReader(
    cli,
    { HOME: home },
    events,
    { kind: "start", id: SESSION_ID },
    undefined,
    (reason, total) => unconfirmed.push({ reason, total }),
  );
  return { commandFor, events, reader, unconfirmed };
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

async function waitForSize(file: string, size: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (statSync(file).size < size) {
    if (Date.now() > deadline) {
      throw new Error(`file never reached ${size} bytes`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runWhole(command: string, payload: string): Promise<void> {
  const { child, exited } = startHook(command);
  child.stdin.end(payload);
  await exited;
}

describe.skipIf(process.platform === "win32")(
  "the hook command and the reader, end to end on one file",
  () => {
    it("delivers every record of N concurrent PermissionRequest hooks, in order, even when their newlines all come last", async () => {
      const { commandFor, events, reader, unconfirmed } = fixture();
      const command = commandFor("PermissionRequest");
      const tools = Array.from({ length: 8 }, (_, index) => `Tool${index}`);
      const running = tools.map(() => startHook(command));
      let written = 0;
      for (const [index, tool] of tools.entries()) {
        const payload = record("PermissionRequest", { tool_name: tool });
        running[index]!.child.stdin.write(payload);
        written += Buffer.byteLength(payload);
        await waitForSize(events, written);
      }
      for (const { child } of running) child.stdin.end();
      await Promise.all(running.map(({ exited }) => exited));
      await runWhole(command, record("PermissionRequest", { tool_name: "Last" }));

      const reports = reader.read();
      const last = reports.at(-1);
      expect(last?.state).toBe("waiting");
      expect(
        last?.state === "waiting" ? last.questions.map((q) => q.prompt) : [],
      ).toEqual(
        [...tools, "Last"].map(
          (tool) => `Claude Code needs permission to use: ${tool}`,
        ),
      );
      expect(unconfirmed).toEqual([]);
    });

    it("detects a record torn by another hook, and neither reads it as 'nothing is pending' nor lets later tool activity show Working", async () => {
      const { commandFor, events, reader, unconfirmed } = fixture();
      const open = commandFor("PermissionRequest");
      const torn = record("PermissionRequest", { tool_name: "Bash" });
      const half = Math.floor(torn.length / 2);
      const first = startHook(open);
      first.child.stdin.write(torn.slice(0, half));
      await waitForSize(events, half);
      await runWhole(open, record("PermissionRequest", { tool_name: "Edit" }));
      first.child.stdin.end(torn.slice(half));
      await first.exited;

      expect(reader.read()).toEqual([]);
      expect(unconfirmed).toEqual([{ reason: "unreadable-record", total: 2 }]);
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

    it("control: the same tool activity without a damaged record shows Working", async () => {
      const { commandFor, reader, unconfirmed } = fixture();
      await runWhole(
        commandFor("PreToolUse"),
        record("PreToolUse", { tool_name: "Read" }),
      );
      expect(reader.read()).toEqual([{ prompt: null, state: "working" }]);
      expect(unconfirmed).toEqual([]);
    });
  },
);
