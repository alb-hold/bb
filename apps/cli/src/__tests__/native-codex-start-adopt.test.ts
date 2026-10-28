import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import {
  CODEX_NATIVE_ACTIVITY,
  CODEX_NATIVE_SESSION,
} from "bb-plugin-provider-codex/native-session";
import { afterEach, describe, expect, it } from "vitest";
import { findNativeSession, findNativeSessionFile } from "../native-harness.js";
import { NativeActivityReader } from "../native-activity-reader.js";
import { createSessionDiscoverer } from "../native-session-discovery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const CODEX: ProviderNativeTerminal = {
  executable: "codex",
  launchArgs: [],
  modelArgs: [],
  imageArgs: [],
  pastePlaceholders: [],
  sessionRoot: { env: "CODEX_HOME", home: ".codex" },
  session: CODEX_NATIVE_SESSION,
  activity: CODEX_NATIVE_ACTIVITY,
};

const CWD = "/work/never-prompted";
const TUI_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const FOREIGN_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const GUARDIAN_ID = "cccccccc-0000-4000-8000-000000000003";

function codexHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-codex-adopt-"));
  roots.push(root);
  return root;
}

type RolloutOrigin =
  | { originator: "codex-tui"; source: "cli" }
  | { originator: "bb"; source: "vscode" }
  | { originator: "bb"; source: { subagent: { other: "guardian" } } };

const TUI: RolloutOrigin = { originator: "codex-tui", source: "cli" };
const APP_SERVER: RolloutOrigin = { originator: "bb", source: "vscode" };
const GUARDIAN: RolloutOrigin = {
  originator: "bb",
  source: { subagent: { other: "guardian" } },
};

function seedRollout(args: {
  home: string;
  id: string;
  origin: RolloutOrigin;
  startedAt: Date;
  prompt?: string;
}): string {
  const day = args.startedAt;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const dir = path.join(
    args.home,
    "sessions",
    String(day.getFullYear()),
    pad(day.getMonth() + 1),
    pad(day.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-seed-${args.id}.jsonl`);
  const at = args.startedAt.toISOString();
  const records: unknown[] = [
    {
      timestamp: at,
      type: "session_meta",
      payload: {
        id: args.id,
        timestamp: at,
        cwd: CWD,
        cli_version: "0.0.0",
        ...args.origin,
      },
    },
    { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
  ];
  if (args.prompt !== undefined) {
    records.push({
      timestamp: at,
      type: "event_msg",
      payload: { type: "user_message", message: args.prompt },
    });
  }
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const seconds = args.startedAt.getTime() / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

function discovererFor(args: {
  env: { CODEX_HOME: string };
  launchedAtMs: number;
}) {
  const recorded: string[] = [];
  const followed: string[] = [];
  const discoverer = createSessionDiscoverer({
    currentCredential: () => "current",
    discardUnsentReports: () => undefined,
    find: () => {
      const match = findNativeSession({
        cli: CODEX,
        cwd: CWD,
        env: args.env,
        launchedAtMs: args.launchedAtMs,
        nowMs: args.launchedAtMs + 5_000,
      });
      return match.kind === "unique" ? match.sessionId : null;
    },
    log: () => undefined,
    reader: () => ({
      sessionDiscovered: (id: string) => {
        followed.push(id);
      },
      suspend: () => undefined,
    }),
    recordSession: async ({ nativeSessionId }) => {
      recorded.push(nativeSessionId);
    },
  });
  discoverer.arm(true);
  return { discoverer, followed, recorded };
}

describe("a Codex native thread that was never prompted", () => {
  it.each([
    ["an app-server session", FOREIGN_ID, APP_SERVER],
    ["a guardian subagent session", GUARDIAN_ID, GUARDIAN],
  ] as const)(
    "does not adopt %s that started in its cwd inside the launch window, so the thread is not bound to it and stays idle",
    async (_name, id, origin) => {
      const home = codexHome();
      const launchedAtMs = Date.now();
      seedRollout({
        home,
        id,
        origin,
        startedAt: new Date(launchedAtMs + 2_000),
      });
      const env = { CODEX_HOME: home };
      expect(
        findNativeSession({
          cli: CODEX,
          cwd: CWD,
          env,
          launchedAtMs,
          nowMs: launchedAtMs + 5_000,
        }),
      ).toEqual({ kind: "none" });

      const { discoverer, followed, recorded } = discovererFor({
        env,
        launchedAtMs,
      });
      await discoverer.discover();
      expect(recorded).toEqual([]);
      expect(followed).toEqual([]);

      const reader = new NativeActivityReader(CODEX, env, null, {
        kind: "discover",
      });
      expect(reader.read()).toEqual([]);
      expect(reader.heartbeat()).toBeNull();
    },
  );

  it("still discovers its own interactive session when a foreign session started in the same cwd and window", () => {
    const home = codexHome();
    const launchedAtMs = Date.now();
    seedRollout({
      home,
      id: FOREIGN_ID,
      origin: APP_SERVER,
      startedAt: new Date(launchedAtMs + 1_000),
    });
    seedRollout({
      home,
      id: TUI_ID,
      origin: TUI,
      startedAt: new Date(launchedAtMs + 2_000),
      prompt: "first prompt",
    });
    expect(
      findNativeSession({
        cli: CODEX,
        cwd: CWD,
        env: { CODEX_HOME: home },
        launchedAtMs,
        nowMs: launchedAtMs + 5_000,
      }),
    ).toEqual({ kind: "unique", sessionId: TUI_ID });
  });
});

describe("a prompted Codex native thread", () => {
  it("binds its new session and shows working on the real task_started and prompt", async () => {
    const home = codexHome();
    const launchedAtMs = Date.now();
    seedRollout({
      home,
      id: TUI_ID,
      origin: TUI,
      startedAt: new Date(launchedAtMs + 2_000),
      prompt: "build the thing",
    });
    const env = { CODEX_HOME: home };
    const { discoverer, recorded } = discovererFor({ env, launchedAtMs });
    const reader = new NativeActivityReader(CODEX, env, null, {
      kind: "discover",
    });
    await discoverer.discover();
    expect(recorded).toEqual([TUI_ID]);
    reader.sessionDiscovered(TUI_ID);
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "build the thing" },
    ]);
  });
});

describe("resuming a chat session in the terminal", () => {
  it("still finds the session a chat thread's app-server created, by its id", () => {
    const home = codexHome();
    const file = seedRollout({
      home,
      id: FOREIGN_ID,
      origin: APP_SERVER,
      startedAt: new Date(Date.now() - 3_600_000),
    });
    expect(findNativeSessionFile(CODEX, { CODEX_HOME: home }, FOREIGN_ID)).toBe(
      file,
    );
  });
});
