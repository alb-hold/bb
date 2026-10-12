import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import type { NativeTerminalLaunchSpec } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  findNativeSession,
  findNativeSessionFile,
  resolveNativeHarnessLaunch,
} from "../native-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-harness-"));
  roots.push(root);
  return root;
}

const ASSIGNED_CLI: ProviderNativeTerminal = {
  executable: "claude",
  launchArgs: [],
  modelArgs: ["--model", "{model}"],
  imageArgs: [],
  pastePlaceholders: [],
  sessionRoot: { env: "CLAUDE_CONFIG_DIR", home: ".claude" },
  session: {
    kind: "assigned",
    startArgs: ["--session-id", "{sessionId}"],
    resumeArgs: ["--resume", "{sessionId}"],
    transcript: "projects/*/{sessionId}.jsonl",
  },
};

const DISCOVERED_CLI: ProviderNativeTerminal = {
  executable: "codex",
  launchArgs: ["--no-daemon"],
  modelArgs: ["-c", 'model="{model}"'],
  imageArgs: ["--image", "{image}"],
  pastePlaceholders: [],
  sessionRoot: { env: "CODEX_HOME", home: ".codex" },
  session: {
    kind: "discovered",
    resumeArgs: ["resume", "{sessionId}"],
    transcripts: "sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl",
    header: {
      match: { type: "session_meta" },
      id: "payload.id",
      cwd: "payload.cwd",
      startedAt: "payload.timestamp",
    },
  },
};

function spec(
  overrides: Partial<NativeTerminalLaunchSpec>,
): NativeTerminalLaunchSpec {
  return {
    threadId: "thr_native",
    cli: ASSIGNED_CLI,
    nativeSessionId: "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
    initialPrompt: null,
    initialImages: [],
    model: null,
    ...overrides,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function writeRollout(args: {
  home: string;
  id: string;
  cwd: string;
  timestamp: Date;
}): string {
  const day = args.timestamp;
  const dir = path.join(
    args.home,
    ".codex",
    "sessions",
    String(day.getFullYear()),
    pad(day.getMonth() + 1),
    pad(day.getDate()),
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${args.id}.jsonl`);
  const meta = {
    timestamp: args.timestamp.toISOString(),
    type: "session_meta",
    payload: {
      id: args.id,
      cwd: args.cwd,
      timestamp: args.timestamp.toISOString(),
      base_instructions: { text: "x".repeat(200_000) },
    },
  };
  writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
  const seconds = args.timestamp.getTime() / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

describe("resolveNativeHarnessLaunch", () => {
  it("starts a fresh claude session with the preassigned id and first prompt", () => {
    const home = tempHome();
    expect(
      resolveNativeHarnessLaunch(
        spec({ initialPrompt: "fix the build", model: "opus" }),
        { HOME: home },
      ),
    ).toEqual({
      command: "claude",
      args: [
        "--model",
        "opus",
        "--session-id",
        "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
        "fix the build",
      ],
      session: {
        kind: "start",
        id: "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
      },
    });
  });

  it("resumes a claude session once its transcript exists in any project dir", () => {
    const home = tempHome();
    const project = path.join(home, ".claude", "projects", "-tmp-worktree");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b.jsonl"),
      "{}\n",
    );
    expect(resolveNativeHarnessLaunch(spec({}), { HOME: home })).toEqual({
      command: "claude",
      args: ["--resume", "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b"],
      session: { kind: "resume", id: "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b" },
    });
  });

  it("attaches launch images after the first prompt of a new session only", () => {
    expect(
      resolveNativeHarnessLaunch(
        spec({
          cli: DISCOVERED_CLI,
          nativeSessionId: null,
          initialPrompt: "What is this?",
          initialImages: ["/tmp/a.png", "/tmp/b.png"],
        }),
        { HOME: tempHome() },
      ).args.slice(-5),
    ).toEqual([
      "What is this?",
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.png",
    ]);
    expect(
      resolveNativeHarnessLaunch(
        spec({
          cli: DISCOVERED_CLI,
          nativeSessionId: "019a0000-0000-7000-8000-000000000000",
          initialImages: ["/tmp/a.png"],
        }),
        { HOME: tempHome() },
      ).args,
    ).not.toContain("--image");
  });

  it("puts launch argv before the model and session argv of an assigned session", () => {
    const cli = { ...ASSIGNED_CLI, launchArgs: ["--quiet"] };
    expect(
      resolveNativeHarnessLaunch(
        spec({ cli, model: "opus", initialPrompt: "hi" }),
        { HOME: tempHome() },
      ).args,
    ).toEqual([
      "--quiet",
      "--model",
      "opus",
      "--session-id",
      "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
      "hi",
    ]);
  });

  it("honours CLAUDE_CONFIG_DIR when looking for the transcript", () => {
    const home = tempHome();
    const config = path.join(home, "pooled-claude");
    mkdirSync(path.join(config, "projects", "p"), { recursive: true });
    writeFileSync(
      path.join(
        config,
        "projects",
        "p",
        "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b.jsonl",
      ),
      "{}\n",
    );
    expect(
      resolveNativeHarnessLaunch(spec({}), {
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
      }).args[0],
    ).toBe("--resume");
  });

  it("launches codex fresh and asks for session discovery until an id is known, launch argv first", () => {
    expect(
      resolveNativeHarnessLaunch(
        spec({
          cli: DISCOVERED_CLI,
          nativeSessionId: null,
          initialPrompt: "go",
        }),
        { HOME: tempHome() },
      ),
    ).toEqual({
      command: "codex",
      args: ["--no-daemon", "go"],
      session: { kind: "discover" },
    });
    expect(
      resolveNativeHarnessLaunch(
        spec({
          cli: DISCOVERED_CLI,
          nativeSessionId: "abc-123",
          model: "gpt-6",
        }),
        { HOME: tempHome() },
      ),
    ).toEqual({
      command: "codex",
      args: ["--no-daemon", "-c", 'model="gpt-6"', "resume", "abc-123"],
      session: { kind: "resume", id: "abc-123" },
    });
  });

  it("keeps the permission-bypass launch argv on fresh starts and resumes", () => {
    const claude = {
      ...ASSIGNED_CLI,
      launchArgs: ["--dangerously-skip-permissions"],
    };
    const home = tempHome();
    const fresh = resolveNativeHarnessLaunch(
      spec({ cli: claude, initialPrompt: "go" }),
      { HOME: home },
    );
    expect(fresh.session.kind).toBe("start");
    expect(fresh.args[0]).toBe("--dangerously-skip-permissions");
    const project = path.join(home, ".claude", "projects", "p");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b.jsonl"),
      "{}\n",
    );
    const resumed = resolveNativeHarnessLaunch(spec({ cli: claude }), {
      HOME: home,
    });
    expect(resumed.session.kind).toBe("resume");
    expect(resumed.args[0]).toBe("--dangerously-skip-permissions");

    const codex = {
      ...DISCOVERED_CLI,
      launchArgs: ["--no-daemon", "--dangerously-bypass-approvals-and-sandbox"],
    };
    for (const nativeSessionId of [null, "abc-123"]) {
      expect(
        resolveNativeHarnessLaunch(spec({ cli: codex, nativeSessionId }), {
          HOME: tempHome(),
        }).args.slice(0, 2),
      ).toEqual(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox"]);
    }
  });
});

describe("native session activity wiring", () => {
  it("passes activity args after the model and before the session args", () => {
    expect(
      resolveNativeHarnessLaunch(
        spec({ initialPrompt: "fix the build", model: "opus" }),
        { HOME: tempHome() },
        ["--settings", "{}"],
      ).args,
    ).toEqual([
      "--model",
      "opus",
      "--settings",
      "{}",
      "--session-id",
      "6f1c2a8e-7d1b-4a55-9f0e-1c2d3e4f5a6b",
      "fix the build",
    ]);
  });

  it("finds a resumed codex rollout from an earlier day by its header id", () => {
    const home = tempHome();
    const id = "019a1f3e-0000-7000-8000-000000000001";
    const older = writeRollout({
      home,
      id,
      cwd: "/work/a",
      timestamp: new Date("2026-01-03T10:00:00Z"),
    });
    writeRollout({
      home,
      id: "019a1f3e-0000-7000-8000-000000000002",
      cwd: "/work/a",
      timestamp: new Date("2026-02-04T10:00:00Z"),
    });
    expect(findNativeSessionFile(DISCOVERED_CLI, { HOME: home }, id)).toBe(
      older,
    );
    expect(
      findNativeSessionFile(
        DISCOVERED_CLI,
        { HOME: home },
        "019a1f3e-0000-7000-8000-000000000009",
      ),
    ).toBeNull();
  });
});

describe("findNativeSession", () => {
  it("finds the rollout started in this worktree after launch", () => {
    const home = tempHome();
    const launchedAtMs = Date.now();
    writeRollout({
      home,
      id: "11111111-aaaa-bbbb-cccc-000000000001",
      cwd: "/work/thread-a",
      timestamp: new Date(launchedAtMs + 1_000),
    });
    writeRollout({
      home,
      id: "11111111-aaaa-bbbb-cccc-000000000002",
      cwd: "/work/thread-b",
      timestamp: new Date(launchedAtMs + 1_000),
    });
    writeRollout({
      home,
      id: "11111111-aaaa-bbbb-cccc-000000000003",
      cwd: "/work/thread-a",
      timestamp: new Date(launchedAtMs - 60_000),
    });
    expect(
      findNativeSession({
        cli: DISCOVERED_CLI,
        cwd: "/work/thread-a/",
        env: { HOME: home },
        launchedAtMs,
        nowMs: launchedAtMs + 2_000,
      }),
    ).toEqual({
      kind: "unique",
      sessionId: "11111111-aaaa-bbbb-cccc-000000000001",
    });
  });

  it("refuses to guess between two sessions started in the same worktree", () => {
    const home = tempHome();
    const launchedAtMs = Date.now();
    for (const suffix of ["1", "2"]) {
      writeRollout({
        home,
        id: `22222222-aaaa-bbbb-cccc-00000000000${suffix}`,
        cwd: "/work/shared",
        timestamp: new Date(launchedAtMs + 500),
      });
    }
    expect(
      findNativeSession({
        cli: DISCOVERED_CLI,
        cwd: "/work/shared",
        env: { HOME: home },
        launchedAtMs,
        nowMs: launchedAtMs + 1_000,
      }).kind,
    ).toBe("ambiguous");
  });

  it("skips a rollout it cannot open instead of throwing", () => {
    const home = tempHome();
    const launchedAtMs = Date.now();
    const locked = writeRollout({
      home,
      id: "33333333-aaaa-bbbb-cccc-000000000001",
      cwd: "/work/locked",
      timestamp: new Date(launchedAtMs + 500),
    });
    chmodSync(locked, 0o000);
    writeRollout({
      home,
      id: "33333333-aaaa-bbbb-cccc-000000000002",
      cwd: "/work/locked",
      timestamp: new Date(launchedAtMs + 500),
    });
    try {
      expect(
        findNativeSession({
          cli: DISCOVERED_CLI,
          cwd: "/work/locked",
          env: { HOME: home },
          launchedAtMs,
          nowMs: launchedAtMs + 1_000,
        }),
      ).toEqual({
        kind: "unique",
        sessionId: "33333333-aaaa-bbbb-cccc-000000000002",
      });
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it("ignores session files whose header does not match the declaration", () => {
    const home = tempHome();
    const launchedAtMs = Date.now();
    const file = writeRollout({
      home,
      id: "44444444-aaaa-bbbb-cccc-000000000001",
      cwd: "/work/mismatch",
      timestamp: new Date(launchedAtMs + 500),
    });
    const original = readFileSync(file, "utf8");
    writeFileSync(
      file,
      original.replace('"type":"session_meta"', '"type":"turn_context"'),
    );
    expect(
      findNativeSession({
        cli: DISCOVERED_CLI,
        cwd: "/work/mismatch",
        env: { HOME: home },
        launchedAtMs,
        nowMs: launchedAtMs + 1_000,
      }),
    ).toEqual({ kind: "none" });
  });

  it("reports none when codex has not written a rollout yet", () => {
    expect(
      findNativeSession({
        cli: DISCOVERED_CLI,
        cwd: "/work/none",
        env: { HOME: tempHome() },
        launchedAtMs: Date.now(),
        nowMs: Date.now(),
      }),
    ).toEqual({ kind: "none" });
  });
});
