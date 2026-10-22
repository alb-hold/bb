import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
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
import type { NativeTerminalReportActivityArgs } from "@bb/sdk";
import { createNodeBbSdk } from "@bb/sdk/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lifecycleOutcome from "../../src/services/threads/lifecycle-outcome.js";
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
  prompt: string | null;
  state: "idle" | "waiting" | "working";
}

interface ReaderLike {
  heartbeat(): NativeReport | null;
  read(): NativeReport[];
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
    eventsFile: string | null,
    start: { kind: "start"; id: string },
  ) => ReaderLike;
}

const cliUrl = (file: string) =>
  new URL(`../../../cli/src/${file}`, import.meta.url).href;
const reporterModule: Pick<CliModules, "createNativeActivityReporter"> =
  await import(cliUrl("native-activity-reporter.ts"));
const wiringModule: Pick<CliModules, "createNativeActivityWiring"> =
  await import(cliUrl("native-activity-wiring.ts"));
const readerModule: Pick<CliModules, "NativeActivityReader"> = await import(
  cliUrl("native-activity-reader.ts")
);

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

async function nativeThread() {
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
    nativeSessionId: SESSION_ID,
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
  return { harness, thread };
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
      appendFileSync(
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
