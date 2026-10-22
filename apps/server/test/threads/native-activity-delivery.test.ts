import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNativeTerminalThread,
  createTerminalSession,
  getNativeTerminalThread,
  getThread,
  listPendingInteractionsByThread,
  setNativeTerminalThreadTerminal,
  setNativeTerminalToolCredential,
} from "@bb/db";
import type { ProviderNativeTerminal } from "@bb/domain";
import {
  publicApiRoutes,
  reportNativeTerminalActivityRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { NativeTerminalReportActivityArgs } from "@bb/sdk";
import { BbRequestTimeoutError } from "@bb/sdk";
import { createNodeBbSdk } from "@bb/sdk/node";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createServerErrorHandler } from "../../src/errors.js";
import { recordNativeTerminalActivity } from "../../src/services/threads/native-terminal-activity.js";
import * as lifecycleOutcome from "../../src/services/threads/lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "../../src/services/threads/thread-runtime-display.js";
import * as titleGeneration from "../../src/services/threads/title-generation.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface NativeReport {
  confirms?: false;
  prompt: string | null;
  state: "idle" | "waiting" | "working";
}

interface ReaderLike {
  heartbeat(): NativeReport | null;
  read(): NativeReport[];
  sessionDiscovered(sessionId: string): void;
  suspend(): void;
}

interface ReporterLike {
  report(next: NativeReport | null, options?: { transient?: boolean }): void;
  retry(): void;
  settled(): Promise<void>;
}

interface WiringLike {
  onCredentialChanged(): void;
  onHeartbeatTick(): void;
  settled(): Promise<void>;
}

interface CliModules {
  createNativeActivityReporter(options: {
    currentCredential(): string | null;
    log?(event: string, fields: Record<string, number | string | null>): void;
    send(args: NativeTerminalReportActivityArgs): Promise<unknown>;
    threadId: string;
  }): ReporterLike;
  createNativeActivityWiring(options: {
    currentCredential(): string | null;
    log(event: string, fields: Record<string, number | string | null>): void;
    reader(): ReaderLike | null;
    recordSession(args: {
      authorization: string;
      nativeSessionId: string;
      replacesNativeSessionId: string;
    }): Promise<unknown>;
    report(next: NativeReport | null, options?: { transient?: boolean }): void;
    retryReport(): void;
  }): WiringLike;
  NativeActivityReader: new (
    cli: ProviderNativeTerminal,
    env: { HOME: string },
    hookSource: HookSourceLike,
    start: { kind: "discover" } | { kind: "start"; id: string },
    onUnconfirmedIdentity?: (total: number) => void,
    onUnconfirmedHookIdentity?: (reason: string, total: number) => void,
  ) => ReaderLike;
}

type HookSourceLike =
  | string
  | { appendFile: string }
  | { unavailable: true }
  | null;

const cliUrl = (file: string) =>
  new URL(`../../../cli/src/${file}`, import.meta.url).href;
const reporterModule: Pick<CliModules, "createNativeActivityReporter"> =
  await import(cliUrl("native-activity-reporter.ts"));
const wiringModule: Pick<CliModules, "createNativeActivityWiring"> =
  await import(cliUrl("native-activity-wiring.ts"));
const readerModule: Pick<CliModules, "NativeActivityReader"> = await import(
  cliUrl("native-activity-reader.ts")
);

interface SpoolModules {
  createHookSpool(parent: string, label: string): string;
  nativeActivityHookSettings(
    hooks: unknown,
    capture: string | { appendFile: string },
  ): string;
  removeHookSpool(directory: string): void;
}

const spoolModule: Pick<SpoolModules, "createHookSpool" | "removeHookSpool"> =
  await import(cliUrl("native-hook-spool.ts"));
const settingsModule: Pick<SpoolModules, "nativeActivityHookSettings"> =
  await import(cliUrl("native-activity.ts"));

const SESSION_ID = "2e624c50-68af-4689-9410-06caa371eb8a";
const SECRET = "synthetic-delivery-test-credential";
const harnesses: TestAppHarness[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function nativeThread(options: { nativeSessionId?: string | null } = {}) {
  const harness = await createTestAppHarness();
  harnesses.push(harness);
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "claude-code",
  });
  seedThreadIdentity(harness.deps, {
    environmentId: environment.id,
    providerThreadId: SESSION_ID,
    threadId: thread.id,
  });
  createNativeTerminalThread(harness.db, {
    initialImages: [],
    initialPrompt: null,
    model: null,
    nativeSessionId:
      options.nativeSessionId === undefined
        ? SESSION_ID
        : options.nativeSessionId,
    providerId: "claude-code",
    threadId: thread.id,
  });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    daemonSessionId: session.id,
    environmentId: environment.id,
    hostId: host.id,
    initialCwd: "/tmp/native-delivery",
    rows: 24,
    status: "running",
    threadId: thread.id,
    title: "Claude Code",
  });
  setNativeTerminalThreadTerminal(harness.db, {
    terminalSessionId: terminal.id,
    threadId: thread.id,
  });
  setNativeTerminalToolCredential(harness.db, {
    credentialHash: createHash("sha256").update(SECRET).digest("hex"),
    terminalSessionId: terminal.id,
    threadId: thread.id,
  });
  const another = (secret: string) => {
    const other = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "claude-code",
    });
    createNativeTerminalThread(harness.db, {
      initialImages: [],
      initialPrompt: null,
      model: null,
      nativeSessionId: null,
      providerId: "claude-code",
      threadId: other.id,
    });
    const otherTerminal = createTerminalSession(harness.db, {
      cols: 80,
      daemonSessionId: session.id,
      environmentId: environment.id,
      hostId: host.id,
      initialCwd: "/tmp/native-delivery",
      rows: 24,
      status: "running",
      threadId: other.id,
      title: "Claude Code",
    });
    setNativeTerminalThreadTerminal(harness.db, {
      terminalSessionId: otherTerminal.id,
      threadId: other.id,
    });
    setNativeTerminalToolCredential(harness.db, {
      credentialHash: createHash("sha256").update(secret).digest("hex"),
      terminalSessionId: otherTerminal.id,
      threadId: other.id,
    });
    return other;
  };
  return { another, harness, thread };
}

function publishHookLines(directory: string, lines: string): void {
  mkdirSync(directory, { recursive: true });
  for (const line of lines.split("\n")) {
    if (line.trim().length === 0) continue;
    const numbers = readdirSync(directory)
      .filter((name) => /^\d{12}$/u.test(name))
      .map(Number);
    const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
    writeFileSync(path.join(directory, String(next).padStart(12, "0")), line, {
      flag: "wx",
    });
  }
}

const activityPath = (threadId: string) =>
  `/api/v1/threads/${threadId}/native-terminal/activity`;

describe("the request shape a pre-#277 holder sends", () => {
  async function post(
    harness: TestAppHarness,
    threadId: string,
    body: unknown,
    authorization?: string,
  ) {
    return harness.app.request(activityPath(threadId), {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      method: "POST",
    });
  }

  it("is rejected with 401, no lifecycle effect and no stamp, while the same report with the current credential has every effect", async () => {
    const { harness, thread } = await nativeThread();
    const title = vi
      .spyOn(titleGeneration, "generateAndApplyThreadTitle")
      .mockResolvedValue(undefined as never);
    const questions = [{ id: "q1", prompt: "Which layout?" }];
    const reports = [
      { state: "working", prompt: "Name this thread" },
      { state: "waiting", questions },
      { state: "idle" },
    ];

    for (const body of reports) {
      const legacy = await post(harness, thread.id, body);
      expect(legacy.status).toBe(401);
      expect(await legacy.json()).toMatchObject({
        code: "native_terminal_credential_invalid",
      });
    }
    expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(
      listPendingInteractionsByThread(harness.db, { threadId: thread.id }),
    ).toHaveLength(0);
    expect(title).not.toHaveBeenCalled();
    expect(getNativeTerminalThread(harness.db, thread.id)).toMatchObject({
      lastEvidenceAt: null,
      nativeSessionId: SESSION_ID,
    });

    const authorization = `Bearer ${SECRET}`;
    expect(
      (await post(harness, thread.id, reports[0], authorization)).status,
    ).toBe(200);
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
    expect(title).toHaveBeenCalledTimes(1);
    expect(
      getNativeTerminalThread(harness.db, thread.id)?.lastEvidenceAt,
    ).not.toBeNull();
    expect(
      (await post(harness, thread.id, reports[1], authorization)).status,
    ).toBe(200);
    expect(
      listPendingInteractionsByThread(harness.db, { threadId: thread.id }),
    ).toHaveLength(1);
    expect(
      (await post(harness, thread.id, reports[2], authorization)).status,
    ).toBe(200);
    expect(getThread(harness.db, thread.id)?.status).toBe("idle");
  });

  it("a legacy idle report sent while the thread is ACTIVE is rejected with 401 and leaves it active, while the credentialed idle settles it", async () => {
    const { harness, thread } = await nativeThread();
    lifecycleOutcome.applyLoggedThreadLifecycleEvent(harness.deps, {
      event: { type: "run.started" },
      threadId: thread.id,
    });
    expect(getThread(harness.db, thread.id)?.status).toBe("active");

    const legacy = await post(harness, thread.id, { state: "idle" });
    expect(legacy.status).toBe(401);
    expect(getThread(harness.db, thread.id)?.status).toBe("active");

    const current = await post(
      harness,
      thread.id,
      { state: "idle" },
      `Bearer ${SECRET}`,
    );
    expect(current.status).toBe(200);
    expect(getThread(harness.db, thread.id)?.status).toBe("idle");
  });
});

describe("recording a native session needs the current holder credential", () => {
  const NEW_ID = "7d0ffee0-1111-4222-8333-444455556666";
  const sessionPath = (threadId: string) =>
    `/api/v1/threads/${threadId}/native-terminal/session`;
  const record = (
    harness: TestAppHarness,
    threadId: string,
    nativeSessionId: string,
    authorization?: string,
  ) =>
    harness.app.request(sessionPath(threadId), {
      body: JSON.stringify({ nativeSessionId }),
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      method: "POST",
    });
  const bound = (harness: TestAppHarness, threadId: string) =>
    getNativeTerminalThread(harness.db, threadId)?.nativeSessionId;

  it("rejects an unauthenticated first bind and leaves the binding empty", async () => {
    const { harness, thread } = await nativeThread({ nativeSessionId: null });
    const response = await record(harness, thread.id, NEW_ID);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "native_terminal_credential_invalid",
    });
    expect(bound(harness, thread.id)).toBeNull();
  });

  it("rejects an unauthenticated request that repeats the bound id", async () => {
    const { harness, thread } = await nativeThread();
    const response = await record(harness, thread.id, SESSION_ID);
    expect(response.status).toBe(401);
    expect(bound(harness, thread.id)).toBe(SESSION_ID);
  });

  it("rejects a stale credential and another thread's credential, and changes nothing", async () => {
    const { another, harness, thread } = await nativeThread({
      nativeSessionId: null,
    });
    const otherSecret = "synthetic-other-thread-credential";
    another(otherSecret);
    for (const authorization of [
      "Bearer not-the-credential",
      `Bearer ${otherSecret}`,
    ]) {
      const response = await record(harness, thread.id, NEW_ID, authorization);
      expect(response.status).toBe(401);
      expect(bound(harness, thread.id)).toBeNull();
    }
  });

  it("lets the current credential bind the first session", async () => {
    const { harness, thread } = await nativeThread({ nativeSessionId: null });
    const response = await record(
      harness,
      thread.id,
      NEW_ID,
      `Bearer ${SECRET}`,
    );
    expect(response.status).toBe(200);
    expect(bound(harness, thread.id)).toBe(NEW_ID);
  });
});

describe("a lost idle report through the real reader, reporter, wiring and SDK client (the 401 in these cases comes from the fault-injecting fetch, not from the real gate; the real gate is covered by the request-shape tests above)", () => {
  function holderHome() {
    const home = mkdtempSync(path.join(os.tmpdir(), "bb-delivery-"));
    roots.push(home);
    const dir = path.join(home, ".claude", "projects", "work");
    mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
    const events = path.join(home, "hooks.jsonl");
    let clock = Date.parse("2026-10-11T10:00:00Z");
    const line = (record: Record<string, unknown>) =>
      `${JSON.stringify({ timestamp: new Date(++clock).toISOString(), ...record })}\n`;
    writeFileSync(
      transcript,
      line({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        promptId: "turn-1",
        origin: { kind: "human" },
        message: { content: "first prompt" },
      }) +
        line({
          type: "assistant",
          isSidechain: false,
          uuid: "answer-1",
          parentUuid: "user-1",
          message: { id: "message-1", content: [{ type: "text", text: "ok" }] },
        }),
    );
    const hook = (record: Record<string, unknown>) =>
      publishHookLines(
        events,
        `${JSON.stringify({ session_id: SESSION_ID, ...record })}\n`,
      );
    hook({
      hook_event_name: "UserPromptSubmit",
      prompt_id: "turn-1",
      prompt: "first prompt",
    });
    return {
      finishTurn() {
        hook({
          hook_event_name: "Stop",
          prompt_id: "turn-1",
          stop_hook_active: false,
        });
        appendFileSync(
          transcript,
          line({
            type: "system",
            subtype: "stop_hook_summary",
            isSidechain: false,
            hasOutput: false,
            uuid: "end-1",
            parentUuid: "answer-1",
          }),
        );
      },
      home,
      events,
    };
  }

  type FaultStep = "401" | "refused" | "pass";

  function holder(
    harness: TestAppHarness,
    threadId: string,
    plan: FaultStep[],
  ) {
    const cli =
      harness.deps.providerRegistry.get("claude-code")?.nativeTerminal;
    if (cli === undefined || cli === null)
      throw new Error("claude-code declaration missing");
    const files = holderHome();
    const reader = new readerModule.NativeActivityReader(
      cli,
      { HOME: files.home },
      files.events,
      { kind: "start", id: SESSION_ID },
    );
    const idleRequests: FaultStep[] = [];
    const faultyFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      const body: unknown =
        request.method === "POST"
          ? JSON.parse(await request.clone().text())
          : null;
      const isIdle =
        request.url.endsWith("/native-terminal/activity") &&
        typeof body === "object" &&
        body !== null &&
        "state" in body &&
        body.state === "idle";
      if (isIdle) {
        const step = plan[idleRequests.length] ?? "pass";
        idleRequests.push(step);
        if (step === "401") {
          return new Response(
            JSON.stringify({
              code: "native_terminal_credential_invalid",
              message: "A valid credential is required",
            }),
            { headers: { "content-type": "application/json" }, status: 401 },
          );
        }
        if (step === "refused") {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          });
        }
      }
      return harness.app.fetch(request);
    };
    const sdk = createNodeBbSdk({
      baseUrl: "http://127.0.0.1:3000",
      fetch: faultyFetch,
    });
    const reporter = reporterModule.createNativeActivityReporter({
      currentCredential: () => SECRET,
      send: (args) => sdk.nativeTerminals.reportActivity(args),
      threadId,
    });
    const wiring = wiringModule.createNativeActivityWiring({
      currentCredential: () => SECRET,
      log: () => undefined,
      reader: () => reader,
      recordSession: async () => ({}),
      report: reporter.report,
      retryReport: reporter.retry,
    });
    const forward = () => {
      for (const next of reader.read()) reporter.report(next);
    };
    return { files, forward, idleRequests, reader, reporter, wiring };
  }

  async function tick(
    h: ReturnType<typeof holder>,
    times: number,
  ): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      await h.reporter.settled();
    }
  }

  it.each<[string, FaultStep[], number]>([
    [
      "a 401, then a refused connection, then the server",
      ["401", "refused"],
      2,
    ],
    ["a refused connection, then the server", ["refused"], 1],
    ["a 401, then the server", ["401"], 1],
  ])(
    "settles the thread to idle exactly once within the heartbeat ticks after %s",
    async (_name, plan, ticksNeeded) => {
      const { harness, thread } = await nativeThread();
      const settles = vi.spyOn(
        lifecycleOutcome,
        "applyLoggedThreadLifecycleEvent",
      );
      vi.useFakeTimers({ toFake: ["clearInterval", "setInterval"] });
      const h = holder(harness, thread.id, plan);
      const interval = setInterval(h.wiring.onHeartbeatTick, 30_000);
      try {
        h.forward();
        await h.reporter.settled();
        expect(getThread(harness.db, thread.id)?.status).toBe("active");

        h.files.finishTurn();
        h.forward();
        await h.reporter.settled();
        expect(getThread(harness.db, thread.id)?.status).toBe("active");

        await tick(h, ticksNeeded);
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        const succeeded = () =>
          settles.mock.calls.filter(
            ([, args]) => args.event.type === "run.succeeded",
          ).length;
        expect(succeeded()).toBe(1);

        await tick(h, 2);
        expect(h.idleRequests).toEqual(
          [...plan, "pass"].slice(0, plan.length + 1),
        );

        h.reporter.report({ state: "idle", prompt: null });
        await h.reporter.settled();
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(succeeded()).toBe(1);
      } finally {
        clearInterval(interval);
      }
    },
  );

  it("control: with no fault the idle report settles the thread at once", async () => {
    const { harness, thread } = await nativeThread();
    const h = holder(harness, thread.id, []);
    h.forward();
    await h.reporter.settled();
    h.files.finishTurn();
    h.forward();
    await h.reporter.settled();
    expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(h.idleRequests).toEqual(["pass"]);
  });
});

describe("overflow, answer, then no resumed activity through the real reader, reporter, SDK client and server", () => {
  const tool = { hook_event_name: "PreToolUse" };
  const permission = (name: string) => ({
    hook_event_name: "PermissionRequest",
    tool_name: name,
  });

  interface HeldRequest {
    body: string;
    headers: Record<string, string>;
    url: string;
  }

  function discoveredHolder(
    harness: TestAppHarness,
    threadId: string,
    options: { holdFirstClose?: boolean } = {},
  ) {
    const cli =
      harness.deps.providerRegistry.get("claude-code")?.nativeTerminal;
    if (cli === undefined || cli === null)
      throw new Error("claude-code declaration missing");
    const home = mkdtempSync(path.join(os.tmpdir(), "bb-overflow-"));
    roots.push(home);
    const events = path.join(home, "hooks.jsonl");
    mkdirSync(events, { recursive: true });
    const hook = (records: Record<string, unknown>[]) =>
      publishHookLines(
        events,
        records
          .map((record) =>
            JSON.stringify({ session_id: SESSION_ID, ...record }),
          )
          .join("\n") + "\n",
      );
    const reader = new readerModule.NativeActivityReader(
      cli,
      { HOME: home },
      events,
      { kind: "discover" },
    );
    let held: HeldRequest | null = null;
    const sdk = createNodeBbSdk({
      baseUrl: "http://127.0.0.1:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (options.holdFirstClose === true && held === null) {
          const body = await request.clone().text();
          if (body.includes('"confirms":false')) {
            held = {
              body,
              headers: Object.fromEntries(request.headers.entries()),
              url: request.url,
            };
            throw new BbRequestTimeoutError(75_000);
          }
        }
        return harness.app.fetch(request);
      },
    });
    const reporter = reporterModule.createNativeActivityReporter({
      currentCredential: () => SECRET,
      send: (args) => sdk.nativeTerminals.reportActivity(args),
      threadId,
    });
    const wiring = wiringModule.createNativeActivityWiring({
      currentCredential: () => SECRET,
      log: () => undefined,
      reader: () => reader,
      recordSession: async () => ({}),
      report: reporter.report,
      retryReport: reporter.retry,
    });
    const forward = async () => {
      for (const next of reader.read()) reporter.report(next);
      await reporter.settled();
    };
    const heartbeat = async () => {
      wiring.onHeartbeatTick();
      await reporter.settled();
    };
    const deliverHeld = (headers: Record<string, string> = {}) => {
      if (held === null) throw new Error("no close was held");
      return harness.app.fetch(
        new Request(held.url, {
          body: held.body,
          headers: { ...held.headers, ...headers },
          method: "POST",
        }),
      );
    };
    return { deliverHeld, forward, heartbeat, hook, reader };
  }

  const displayOf = (harness: TestAppHarness, threadId: string) => {
    const thread = getThread(harness.db, threadId);
    if (thread === null) throw new Error("thread missing");
    return buildThreadStatusChangeMetadata(harness.deps, thread).statusChange
      ?.runtime.nativeActivity;
  };

  async function overflowedAndAsked(
    options: { holdFirstClose?: boolean } = {},
  ) {
    const { harness, thread } = await nativeThread();
    const h = discoveredHolder(harness, thread.id, options);
    h.hook([
      permission("Bash"),
      ...Array.from({ length: 70 }, () => tool),
      permission("Edit"),
    ]);
    expect(h.reader.read()).toEqual([]);
    h.reader.sessionDiscovered(SESSION_ID);
    await h.forward();
    return { h, harness, thread };
  }

  it("publishes the retained question as Needs input and keeps the dropped one out of the display", async () => {
    const { harness, thread } = await overflowedAndAsked();
    expect(
      listPendingInteractionsByThread(harness.db, { threadId: thread.id }),
    ).toHaveLength(1);
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
    expect(displayOf(harness, thread.id)).toMatchObject({
      confirmation: "confirmed",
    });
  });

  it("closes the answered question and shows Activity not reported at once, with no heartbeat after it", async () => {
    const { h, harness, thread } = await overflowedAndAsked();
    h.hook([{ hook_event_name: "PostToolUse", tool_name: "Edit" }]);
    await h.forward();
    expect(
      listPendingInteractionsByThread(harness.db, { threadId: thread.id }),
    ).toHaveLength(0);
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
    expect(getNativeTerminalThread(harness.db, thread.id)).toMatchObject({
      lastEvidenceAt: null,
    });
    expect(displayOf(harness, thread.id)).toMatchObject({
      confirmation: "unconfirmed",
      lastEvidenceAt: null,
    });
    await h.heartbeat();
    await h.heartbeat();
    expect(displayOf(harness, thread.id)).toMatchObject({
      confirmation: "unconfirmed",
      lastEvidenceAt: null,
    });
  });

  it("stays unconfirmed for a pre-tool record, an unrelated completed tool and a parallel completion of the dropped opener's own tool name", async () => {
    const { h, harness, thread } = await overflowedAndAsked();
    h.hook([{ hook_event_name: "PostToolUse", tool_name: "Edit" }]);
    await h.forward();
    h.hook([tool]);
    await h.forward();
    h.hook([{ hook_event_name: "PostToolUse", tool_name: "Write" }]);
    await h.forward();
    h.hook([{ hook_event_name: "PostToolUse", tool_name: "Bash" }]);
    await h.forward();
    expect(displayOf(harness, thread.id)).toMatchObject({
      confirmation: "unconfirmed",
      lastEvidenceAt: null,
    });
  });

  it("shows later real work as confirmed after the unconfirmed answer", async () => {
    const { h, harness, thread } = await overflowedAndAsked();
    h.hook([{ hook_event_name: "PostToolUse", tool_name: "Edit" }]);
    await h.forward();
    expect(displayOf(harness, thread.id)).toMatchObject({
      confirmation: "unconfirmed",
    });
    h.hook([{ hook_event_name: "UserPromptSubmit", prompt: "next task" }]);
    await h.forward();
    expect(displayOf(harness, thread.id)).toMatchObject({
      confirmation: "confirmed",
    });
  });

  describe("a close that times out on the client and is delivered after a newer question", () => {
    async function lateClose() {
      const { h, harness, thread } = await overflowedAndAsked({
        holdFirstClose: true,
      });
      h.hook([{ hook_event_name: "PostToolUse", tool_name: "Edit" }]);
      await h.forward();
      expect(
        listPendingInteractionsByThread(harness.db, { threadId: thread.id }),
      ).toHaveLength(1);
      h.hook([permission("Write")]);
      await h.forward();
      const evidenceAfterB = getNativeTerminalThread(
        harness.db,
        thread.id,
      )?.lastEvidenceAt;
      return { evidenceAfterB, h, harness, thread };
    }

    const pending = (harness: TestAppHarness, threadId: string) =>
      listPendingInteractionsByThread(harness.db, { threadId }).map(
        (interaction) => interaction.providerRequestId,
      );

    it("cannot end the newer question or clear its evidence, and repeating it is a no-op", async () => {
      const { evidenceAfterB, h, harness, thread } = await lateClose();
      expect(pending(harness, thread.id)).toEqual([
        expect.stringContaining("permission:Write"),
      ]);
      expect(evidenceAfterB).not.toBeNull();
      expect((await h.deliverHeld()).status).toBe(200);
      expect((await h.deliverHeld()).status).toBe(200);
      expect(pending(harness, thread.id)).toEqual([
        expect.stringContaining("permission:Write"),
      ]);
      expect(
        getNativeTerminalThread(harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(evidenceAfterB);
      expect(displayOf(harness, thread.id)).toMatchObject({
        confirmation: "confirmed",
      });
    });

    it("is refused without the current credential and changes nothing", async () => {
      const { evidenceAfterB, h, harness, thread } = await lateClose();
      const refused = await h.deliverHeld({ authorization: "Bearer stale" });
      expect(refused.status).toBe(401);
      expect(pending(harness, thread.id)).toHaveLength(1);
      expect(
        getNativeTerminalThread(harness.db, thread.id)?.lastEvidenceAt,
      ).toBe(evidenceAfterB);
    });
  });
});

describe("an older server that does not know the closure fields (INJECTED-SERVER evidence: the 400 comes from the pre-change strict schema through the real typedRoutes validation and error handler, and the accepted report goes through the real service and database; no old server build was run, and old-server late-close protection is NOT FIXED and its execution NOT RUN)", () => {
  const routes = publicApiRoutes.nativeTerminalThreads;
  const fields = reportNativeTerminalActivityRequestSchema.shape;
  const preChangeSchema = z
    .object({
      prompt: fields.prompt,
      questions: fields.questions,
      state: fields.state,
    })
    .strict();
  const asking = (id: string, prompt: string) => ({
    prompt: null,
    questions: [{ id, prompt }],
    state: "waiting" as const,
  });

  async function oldServerOnTheRealStore() {
    const { harness, thread } = await nativeThread();
    const app = new Hono();
    app.onError(
      createServerErrorHandler({
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      }),
    );
    const { post } = typedRoutes<PublicApiSchema>(app, {
      onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
    });
    post(
      {
        ...routes.reportActivity,
        request: { ...routes.reportActivity.request, schema: preChangeSchema },
      } as typeof routes.reportActivity,
      (context, payload) => {
        recordNativeTerminalActivity(harness.deps, {
          authorization: context.req.header("authorization"),
          threadId: context.req.param("id"),
          ...payload,
          confirms: true,
        });
        return context.json({ ok: true as const });
      },
    );
    const writesAtRejection: Array<{
      evidence: number | null | undefined;
      pending: number;
      status: string | undefined;
    }> = [];
    const rejectedBodies: string[] = [];
    let target: { fetch(request: Request): Response | Promise<Response> } = app;
    const sdk = createNodeBbSdk({
      baseUrl: "http://127.0.0.1:3000",
      fetch: async (input, init) => {
        const response = await target.fetch(new Request(input, init));
        if (response.status === 400) {
          rejectedBodies.push(await response.clone().text());
          writesAtRejection.push({
            evidence: getNativeTerminalThread(harness.db, thread.id)
              ?.lastEvidenceAt,
            pending: listPendingInteractionsByThread(harness.db, {
              threadId: thread.id,
            }).length,
            status: getThread(harness.db, thread.id)?.status,
          });
        }
        return response;
      },
    });
    const logged: string[] = [];
    const reporter = reporterModule.createNativeActivityReporter({
      currentCredential: () => SECRET,
      log: (event) => logged.push(event),
      send: (args) => sdk.nativeTerminals.reportActivity(args),
      threadId: thread.id,
    });
    return {
      harness,
      logged,
      rejectedBodies,
      reporter,
      thread,
      upgrade: () => {
        target = harness.app;
      },
      writesAtRejection,
    };
  }

  const pendingOf = (harness: TestAppHarness, threadId: string) =>
    listPendingInteractionsByThread(harness.db, { threadId }).map(
      (interaction) => interaction.payload,
    );

  it("rejects the initial request with zero writes and zod's own wording, then settles an answered question as before", async () => {
    const h = await oldServerOnTheRealStore();
    h.reporter.report(asking("permission:Bash#1", "Allow Bash?"));
    h.reporter.report({ prompt: null, state: "working" });
    await h.reporter.settled();
    expect(h.rejectedBodies).toHaveLength(2);
    expect(h.rejectedBodies[0]).toMatch(/Unrecognized key: .*closes/u);
    expect(h.writesAtRejection[0]).toEqual({
      evidence: null,
      pending: 0,
      status: "idle",
    });
    expect(
      listPendingInteractionsByThread(h.harness.db, {
        threadId: h.thread.id,
      }),
    ).toHaveLength(0);
    expect(getThread(h.harness.db, h.thread.id)?.status).toBe("active");
  });

  it("registers Y with its original payload when a report closes X and opens Y, and ends X as the old contract does", async () => {
    const h = await oldServerOnTheRealStore();
    h.reporter.report(asking("permission:Bash#1", "Allow Bash?"));
    await h.reporter.settled();
    expect(pendingOf(h.harness, h.thread.id)).toHaveLength(1);
    h.reporter.report(asking("permission:Edit#1", "Allow Edit?"));
    await h.reporter.settled();
    const open = listPendingInteractionsByThread(h.harness.db, {
      threadId: h.thread.id,
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.providerRequestId).toContain("permission:Edit#1");
    expect(JSON.stringify(open[0]?.payload)).toContain("Allow Edit?");
    expect(h.rejectedBodies).toHaveLength(2);
  });

  it("goes out with the fields again after a rejection: nothing is remembered about the server", async () => {
    const h = await oldServerOnTheRealStore();
    h.reporter.report({ prompt: null, state: "working" });
    h.reporter.report({ prompt: null, state: "working" });
    h.reporter.report({ prompt: null, state: "working" });
    await h.reporter.settled();
    expect(h.rejectedBodies).toHaveLength(3);
  });

  it("sends the next normal report with targeted closure once the server has been upgraded", async () => {
    const h = await oldServerOnTheRealStore();
    h.reporter.report(asking("permission:Bash#1", "Allow Bash?"));
    await h.reporter.settled();
    h.upgrade();
    h.reporter.report(asking("permission:Edit#1", "Allow Edit?"));
    await h.reporter.settled();
    expect(h.rejectedBodies).toHaveLength(1);
    const open = listPendingInteractionsByThread(h.harness.db, {
      threadId: h.thread.id,
    });
    expect(open.map((interaction) => interaction.providerRequestId)).toEqual([
      expect.stringContaining("permission:Edit#1"),
    ]);
  });

  it("OPEN FINDING (characterisation, not a pass): a report that was already stripped for an old server and reaches an upgraded server late still closes every question it does not list", async () => {
    const h = await oldServerOnTheRealStore();
    h.upgrade();
    const key = `/api/v1/threads/${h.thread.id}/native-terminal/activity`;
    const send = (body: unknown) =>
      h.harness.app.request(key, {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
    expect(
      (
        await send({
          closes: [],
          questions: [{ id: "permission:Edit#2", prompt: "Allow Edit?" }],
          state: "waiting",
        })
      ).status,
    ).toBe(200);
    expect((await send({ state: "working" })).status).toBe(200);
    expect(
      listPendingInteractionsByThread(h.harness.db, { threadId: h.thread.id }),
    ).toHaveLength(0);
  });
});

describe.skipIf(process.platform === "win32")(
  `Needs input from concurrent hooks, through the generated hook command, the real reader, reporter, SDK client and server ${process.platform === "win32" ? "(NOT EXERCISED on native Windows: the hook command needs a POSIX shell and native-terminal mode cannot start there today)" : ""}`,
  () => {
    async function prepared(mode: "spool" | "append" = "spool") {
      const { harness, thread } = await nativeThread();
      const cli =
        harness.deps.providerRegistry.get("claude-code")?.nativeTerminal;
      const hooks = cli?.activity?.hooks;
      if (cli === undefined || cli === null || hooks === undefined) {
        throw new Error("claude-code hooks missing");
      }
      const spool = spoolModule.createHookSpool(os.tmpdir(), "delivery-test");
      roots.push(spool);
      const capture =
        mode === "spool"
          ? spool
          : { appendFile: path.join(spool, "hooks.jsonl") };
      if (typeof capture !== "string") writeFileSync(capture.appendFile, "");
      const settings: {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      } = JSON.parse(settingsModule.nativeActivityHookSettings(hooks, capture));
      const command = settings.hooks.PermissionRequest?.[0]?.hooks[0]?.command;
      if (command === undefined) throw new Error("no PermissionRequest hook");
      const runHook = (tool: string, index: number, size: string) =>
        new Promise<void>((resolve) => {
          const child = spawn("sh", ["-c", command], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.once("exit", () => resolve());
          child.stdin.end(
            JSON.stringify({
              hook_event_name: "PermissionRequest",
              permission_suggestions: [],
              session_id: SESSION_ID,
              tool_input: { content: index % 2 === 0 ? size : "small" },
              tool_name: tool,
            }),
          );
        });
      const unconfirmed: Array<{ reason: string; total: number }> = [];
      const reader = new readerModule.NativeActivityReader(
        cli,
        { HOME: os.tmpdir() },
        capture,
        { kind: "start", id: SESSION_ID },
        undefined,
        (reason: string, total: number) => unconfirmed.push({ reason, total }),
      );
      const sdk = createNodeBbSdk({
        baseUrl: "http://127.0.0.1:3000",
        fetch: async (input, init) =>
          harness.app.fetch(new Request(input, init)),
      });
      const reporter = reporterModule.createNativeActivityReporter({
        currentCredential: () => SECRET,
        send: (args) => sdk.nativeTerminals.reportActivity(args),
        threadId: thread.id,
      });
      const deliver = async (): Promise<void> => {
        for (const next of reader.read()) reporter.report(next);
        await reporter.settled();
      };
      return { deliver, harness, reader, runHook, spool, thread, unconfirmed };
    }

    async function openers(count: number) {
      const { deliver, harness, runHook, thread } = await prepared();
      const big = "z".repeat(512 * 1024);
      const tools = Array.from({ length: count }, (_, index) => `Tool${index}`);
      await Promise.all(tools.map((tool, index) => runHook(tool, index, big)));
      await deliver();
      return { harness, thread, tools };
    }

    it("registers every concurrent opener as a pending question and shows Needs input", async () => {
      const { harness, thread, tools } = await openers(6);
      const pending = listPendingInteractionsByThread(harness.db, {
        threadId: thread.id,
      });
      expect(pending).toHaveLength(tools.length);
      for (const tool of tools) {
        expect(JSON.stringify(pending.map((row) => row.payload))).toContain(
          `Claude Code needs permission to use: ${tool}`,
        );
      }
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    });

    it("registers Needs input through the append fallback when no candidate supports links", async () => {
      const { deliver, harness, runHook, thread } = await prepared("append");
      for (const [index, tool] of ["Alpha", "Beta", "Gamma"].entries()) {
        await runHook(tool, index, "small");
      }
      await deliver();
      const pending = JSON.stringify(
        listPendingInteractionsByThread(harness.db, {
          threadId: thread.id,
        }).map((row) => row.payload),
      );
      for (const tool of ["Alpha", "Beta", "Gamma"]) {
        expect(pending).toContain(`use: ${tool}`);
      }
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    });

    it("keeps Needs input alive behind a lost record: waits for the gap, then, past the threshold, delivers the later question and reports lost evidence", async () => {
      const { deliver, harness, reader, runHook, spool, thread, unconfirmed } =
        await prepared();
      for (const [index, tool] of ["Tool0", "Tool1", "Tool2"].entries()) {
        await runHook(tool, index, "small");
      }
      rmSync(path.join(spool, "000000000002"));
      const pendingTools = (): string =>
        JSON.stringify(
          listPendingInteractionsByThread(harness.db, {
            threadId: thread.id,
          }).map((row) => row.payload),
        );
      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => t0);
      try {
        await deliver();
        expect(pendingTools()).toContain("use: Tool0");
        expect(pendingTools()).not.toContain("use: Tool2");

        clock.mockImplementation(() => t0 + 3_000);
        await deliver();
        expect(pendingTools()).not.toContain("use: Tool2");
        expect(unconfirmed).toEqual([]);

        clock.mockImplementation(() => t0 + 12_000);
        await deliver();
      } finally {
        clock.mockRestore();
      }
      expect(pendingTools()).toContain("use: Tool0");
      expect(pendingTools()).toContain("use: Tool2");
      expect(unconfirmed).toEqual([{ reason: "unreadable-record", total: 1 }]);
      expect(reader.heartbeat()).toBeNull();
    });
  },
);
