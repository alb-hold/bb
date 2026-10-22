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
  providerNativeTerminalActivitySchema,
  type ProviderNativeTerminal,
} from "@bb/domain";
import { BbHttpError } from "@bb/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeActivityReader } from "../native-activity-reader.js";
import { createNativeActivityReporter } from "../native-activity-reporter.js";
import {
  createNativeActivityPump,
  createNativeActivityWiring,
} from "../native-activity-wiring.js";
import { findNativeSession } from "../native-harness.js";
import { createSessionDiscoverer } from "../native-session-discovery.js";

interface CodexPluginTestHost {
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
  createFakePluginHost(options: { pluginId: string }): CodexPluginTestHost;
} = await import(
  new URL(
    "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.ts",
    import.meta.url,
  ).href
);
const { default: codexPlugin }: { default(bb: unknown): void } = await import(
  new URL("../../../../plugins/provider-codex/server.ts", import.meta.url).href
);

const SESSION_ID = "019a1f3e-0000-7000-8000-000000000001";
const CWD = "/work/a";
const LAUNCHED_AT_MS = Date.parse("2026-10-11T12:00:00Z");

const roots: string[] = [];
const releases: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function refusal(status: number, code: string): BbHttpError {
  return new BbHttpError({ body: null, code, message: code, status });
}

function jsonl(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function codexTurn(prompt: string): unknown[] {
  return [
    { type: "event_msg", payload: { type: "task_started" } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [{ type: "text", text: prompt }],
        },
      },
    },
  ];
}

function codexCli(): ProviderNativeTerminal {
  const host = createFakePluginHost({ pluginId: "provider-codex" });
  codexPlugin(host.bb);
  const cli = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "codex",
  )?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Codex native declaration missing");
  return cli;
}

function holdOpen<T>(): {
  reject(error: unknown): void;
  resolve(value: T): void;
  promise: Promise<T>;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  releases.push(() => resolve(undefined as T));
  return { promise, reject, resolve };
}

const HOOKS = {
  args: ["--settings", "{settings}"],
  idle: ["Stop"],
  permission: {
    close: ["PostToolUse"],
    idField: "tool_name",
    label: "needs permission to use",
    open: ["PermissionRequest"],
  },
  promptField: "prompt",
  working: ["UserPromptSubmit", "PreToolUse"],
};

function hookShape(withSessionIdField: boolean): ProviderNativeTerminal {
  return {
    ...codexCli(),
    activity: providerNativeTerminalActivitySchema.parse({
      hooks: withSessionIdField
        ? { ...HOOKS, sessionIdField: "session_id" }
        : HOOKS,
    }),
  };
}

function hooksAndTranscriptShape(): ProviderNativeTerminal {
  const codex = codexCli();
  return {
    ...codex,
    activity: providerNativeTerminalActivitySchema.parse({
      hooks: { ...HOOKS, sessionIdField: "session_id" },
      transcript: codex.activity?.transcript,
    }),
  };
}

function holder(
  cli: ProviderNativeTerminal = codexCli(),
  unconfirmed: string[] = [],
) {
  const home = mkdtempSync(path.join(os.tmpdir(), "bb-native-follow-"));
  roots.push(home);
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "11");
  mkdirSync(dir, { recursive: true });
  const rollout = path.join(dir, `rollout-x-${SESSION_ID}.jsonl`);
  writeFileSync(
    rollout,
    jsonl([
      {
        type: "session_meta",
        payload: {
          id: SESSION_ID,
          cwd: CWD,
          timestamp: "2026-10-11T12:00:01Z",
        },
      },
    ]),
  );
  const env = { HOME: home };
  const events = path.join(home, "hooks.jsonl");
  writeFileSync(events, "");
  const reader = new NativeActivityReader(
    cli,
    env,
    cli.activity?.hooks === undefined ? null : events,
    { kind: "discover" },
    undefined,
    (reason, total) => unconfirmed.push(`${reason}:${total}`),
  );
  const sentReports: string[] = [];
  const sentMarkers: Array<boolean | undefined> = [];
  const recorded: string[] = [];
  const logged: string[] = [];
  const reporter = createNativeActivityReporter({
    currentCredential: () => "current",
    send: async (args) => {
      sentMarkers.push(args.confirms);
      sentReports.push(
        args.prompt === undefined || args.prompt === null
          ? args.state
          : `${args.state}:${args.prompt}`,
      );
    },
    threadId: "thr_follow",
  });
  const wiring = createNativeActivityWiring({
    currentCredential: () => "current",
    log: () => undefined,
    reader: () => reader,
    recordSession: async () => ({}),
    report: reporter.report,
    retryReport: reporter.retry,
  });
  const readTick = createNativeActivityPump({
    reader: () => reader,
    report: reporter.report,
  });
  const makeDiscoverer = (
    recordSession: (args: {
      authorization: string;
      nativeSessionId: string;
    }) => Promise<unknown>,
  ) => {
    const discoverer = createSessionDiscoverer({
      currentCredential: () => "current",
      discardUnsentReports: () => reporter.discardRetained(),
      find: () => {
        const match = findNativeSession({
          cli,
          cwd: CWD,
          env,
          launchedAtMs: LAUNCHED_AT_MS,
          nowMs: LAUNCHED_AT_MS,
        });
        return match.kind === "unique" ? match.sessionId : null;
      },
      log: (event) => logged.push(event),
      reader: () => reader,
      recordSession: async (args) => {
        recorded.push(args.authorization);
        return recordSession(args);
      },
    });
    discoverer.arm(true);
    return discoverer;
  };
  const tick = async (): Promise<string[]> => {
    readTick();
    wiring.onHeartbeatTick();
    await reporter.settled();
    return [...sentReports];
  };
  const readOnly = async (): Promise<string[]> => {
    readTick();
    await reporter.settled();
    return [...sentReports];
  };
  return {
    append: (records: unknown[]) => appendFileSync(rollout, jsonl(records)),
    appendHooks: (records: unknown[]) => appendFileSync(events, jsonl(records)),
    logged,
    makeDiscoverer,
    readOnly,
    recorded,
    sentMarkers,
    sentReports,
    tick,
  };
}

describe("following a discovered session only after the server accepted it", () => {
  it("does not follow or report the candidate while the binding is pending, and never after a permanent refusal", async () => {
    const h = holder();
    h.append(codexTurn("first"));
    const binding = holdOpen<unknown>();
    const discoverer = h.makeDiscoverer(() => binding.promise);

    const discovering = discoverer.discover();
    try {
      expect(h.recorded).toEqual(["Bearer current"]);
      expect(await h.tick()).toEqual([]);
      h.append(codexTurn("second"));
      expect(await h.tick()).toEqual([]);

      binding.reject(refusal(409, "native_session_claimed"));
      await discovering;
      expect(h.logged).toEqual(["session-discovery-stopped"]);
      expect(await h.tick()).toEqual([]);
      h.append(codexTurn("third"));
      expect(await h.tick()).toEqual([]);
      await discoverer.discover();
      expect(h.recorded).toHaveLength(1);
    } finally {
      binding.resolve(undefined);
      await discovering;
    }
  });

  it.each([
    [
      "a 401 the credential hash has not reached yet",
      refusal(401, "native_terminal_credential_invalid"),
    ],
    ["a transport failure", new TypeError("fetch failed")],
  ])(
    "does not follow after %s, then follows exactly once after the binding succeeds and reports the evidence written before acceptance once",
    async (_name, failure) => {
      const h = holder();
      h.append(codexTurn("before acceptance"));
      const first = holdOpen<unknown>();
      const second = holdOpen<unknown>();
      const answers = [first, second];
      const discoverer = h.makeDiscoverer(() => {
        const answer = answers.shift();
        if (answer === undefined) return Promise.resolve({});
        return answer.promise;
      });

      const discovering = discoverer.discover();
      try {
        expect(await h.tick()).toEqual([]);
        first.reject(failure);
        await discovering;
        expect(h.logged).toEqual([]);
        expect(await h.tick()).toEqual([]);

        const retrying = discoverer.discover();
        try {
          h.append(codexTurn("while pending"));
          expect(await h.tick()).toEqual([]);
          second.resolve({});
          await retrying;
        } finally {
          second.resolve(undefined);
          await retrying;
        }
        expect(await h.readOnly()).toEqual([
          "working",
          "working:before acceptance",
          "working:while pending",
        ]);
        expect(await h.readOnly()).toHaveLength(3);
        await discoverer.discover();
        expect(h.recorded).toHaveLength(2);
        h.append(codexTurn("after"));
        expect((await h.readOnly()).slice(3)).toEqual(["working:after"]);
      } finally {
        first.resolve(undefined);
        await discovering;
      }
    },
  );

  it("binds with the credential and follows from the session's first record", async () => {
    const h = holder();
    h.append(codexTurn("hello"));
    const discoverer = h.makeDiscoverer(async () => ({}));
    expect(await h.tick()).toEqual([]);
    await discoverer.discover();
    expect(h.recorded).toEqual(["Bearer current"]);
    expect(await h.readOnly()).toEqual(["working", "working:hello"]);
  });

  describe.each([
    ["discovered + hooks with a session id field", true],
    ["discovered + hooks without a session id field", false],
  ])("%s", (_shape, withSessionIdField) => {
    const prompt = (text: string, session: string = SESSION_ID) => ({
      hook_event_name: "UserPromptSubmit",
      prompt: text,
      session_id: session,
    });
    const permission = {
      hook_event_name: "PermissionRequest",
      session_id: SESSION_ID,
      tool_name: "Bash",
    };

    it("stays silent while the binding is pending and reports the held hook records once after acceptance", async () => {
      const h = holder(hookShape(withSessionIdField));
      h.appendHooks([prompt("held one"), permission]);
      const binding = holdOpen<unknown>();
      const discoverer = h.makeDiscoverer(() => binding.promise);
      const discovering = discoverer.discover();
      try {
        expect(await h.tick()).toEqual([]);
        h.appendHooks([prompt("held two")]);
        expect(await h.tick()).toEqual([]);
        binding.resolve({});
        await discovering;
        const replayed = await h.readOnly();
        expect(replayed).toEqual([
          "working:held one",
          "waiting",
          "working:held two",
        ]);
        expect(await h.readOnly()).toEqual(replayed);
      } finally {
        binding.resolve(undefined);
        await discovering;
      }
    });

    it("drops the held hook records unreported after a permanent refusal", async () => {
      const h = holder(hookShape(withSessionIdField));
      h.appendHooks([prompt("held"), permission]);
      const binding = holdOpen<unknown>();
      const discoverer = h.makeDiscoverer(() => binding.promise);
      const discovering = discoverer.discover();
      try {
        expect(await h.tick()).toEqual([]);
        binding.reject(refusal(409, "native_session_claimed"));
        await discovering;
        h.appendHooks([prompt("later")]);
        expect(await h.tick()).toEqual([]);
        expect(await h.tick()).toEqual([]);
        expect(h.logged).toEqual(["session-discovery-stopped"]);
      } finally {
        binding.resolve(undefined);
        await discovering;
      }
    });

    it("shows activity as unconfirmed after the holding bound overflowed, and does not claim a complete replay", async () => {
      const unconfirmed: string[] = [];
      const h = holder(hookShape(withSessionIdField), unconfirmed);
      h.appendHooks([
        prompt("lost first"),
        ...Array.from({ length: 70 }, () => ({
          hook_event_name: "PreToolUse",
          session_id: SESSION_ID,
        })),
      ]);
      const discoverer = h.makeDiscoverer(async () => ({}));
      expect(await h.tick()).toEqual([]);
      await discoverer.discover();
      const replayed = await h.readOnly();
      expect(replayed).toEqual(["working"]);
      expect(unconfirmed).toEqual(["held-overflow:7"]);
      expect(await h.tick()).toEqual(replayed);
      h.appendHooks([prompt("fresh", SESSION_ID)]);
      expect((await h.tick()).slice(1)).toEqual(["working:fresh", "working"]);
    });

    it("heartbeats after acceptance when nothing was dropped", async () => {
      const unconfirmed: string[] = [];
      const h = holder(hookShape(withSessionIdField), unconfirmed);
      h.appendHooks([prompt("kept")]);
      const discoverer = h.makeDiscoverer(async () => ({}));
      await discoverer.discover();
      expect(await h.readOnly()).toEqual(["working:kept"]);
      expect(await h.tick()).toEqual(["working:kept", "working"]);
      expect(unconfirmed).toEqual([]);
    });
  });

  describe("discovered + hooks with a session id field + transcript", () => {
    const prompt = (text: string) => ({
      hook_event_name: "UserPromptSubmit",
      prompt: text,
      session_id: SESSION_ID,
    });

    it("reports the transcript written while the binding was pending once after acceptance when no hook was held", async () => {
      const h = holder(hooksAndTranscriptShape());
      h.append(codexTurn("pending transcript"));
      const binding = holdOpen<unknown>();
      const discoverer = h.makeDiscoverer(() => binding.promise);
      const discovering = discoverer.discover();
      try {
        expect(await h.tick()).toEqual([]);
        binding.resolve({});
        await discovering;
        const replayed = await h.readOnly();
        expect(replayed).toEqual(["working", "working:pending transcript"]);
        expect(await h.readOnly()).toEqual(replayed);
      } finally {
        binding.resolve(undefined);
        await discovering;
      }
    });

    it("reports both the held hook and the pending transcript exactly once", async () => {
      const h = holder(hooksAndTranscriptShape());
      h.append(codexTurn("pending transcript"));
      h.appendHooks([prompt("held hook")]);
      const binding = holdOpen<unknown>();
      const discoverer = h.makeDiscoverer(() => binding.promise);
      const discovering = discoverer.discover();
      try {
        expect(await h.tick()).toEqual([]);
        binding.resolve({});
        await discovering;
        const replayed = await h.readOnly();
        expect(replayed.filter((r) => r === "working:held hook")).toHaveLength(
          1,
        );
        expect(
          replayed.filter((r) => r === "working:pending transcript"),
        ).toHaveLength(1);
        expect(await h.readOnly()).toEqual(replayed);
      } finally {
        binding.resolve(undefined);
        await discovering;
      }
    });
  });

  describe.each([
    ["with a session id field", true],
    ["without a session id field", false],
  ])(
    "a question opened while pending, hooks %s",
    (_shape, withSessionIdField) => {
      it("is still reported after a binding outage longer than a minute, and a fresh unrelated hook does not mask it", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.parse("2026-10-11T12:05:00Z"));
        const h = holder(hookShape(withSessionIdField));
        h.appendHooks([
          {
            hook_event_name: "PermissionRequest",
            session_id: SESSION_ID,
            tool_name: "Bash",
          },
        ]);
        const binding = holdOpen<unknown>();
        const discoverer = h.makeDiscoverer(() => binding.promise);
        const discovering = discoverer.discover();
        try {
          expect(await h.tick()).toEqual([]);
          vi.setSystemTime(Date.parse("2026-10-11T12:08:00Z"));
          expect(await h.tick()).toEqual([]);
          binding.resolve({});
          await discovering;
          h.appendHooks([
            { hook_event_name: "PreToolUse", session_id: SESSION_ID },
          ]);
          const reported = await h.readOnly();
          expect(reported[0]).toBe("waiting");
        } finally {
          binding.resolve(undefined);
          await discovering;
        }
      });
    },
  );

  describe.each([
    ["with a session id field", true],
    ["without a session id field", false],
  ])(
    "an open question trimmed from the holding bound, hooks %s",
    (_shape, withSessionIdField) => {
      const tool = { hook_event_name: "PreToolUse", session_id: SESSION_ID };
      const startTrimmed = async () => {
        const unconfirmed: string[] = [];
        const h = holder(hookShape(withSessionIdField), unconfirmed);
        h.appendHooks([
          {
            hook_event_name: "PermissionRequest",
            session_id: SESSION_ID,
            tool_name: "Bash",
          },
          ...Array.from({ length: 70 }, () => tool),
        ]);
        const discoverer = h.makeDiscoverer(async () => ({}));
        expect(await h.tick()).toEqual([]);
        await discoverer.discover();
        return { h, unconfirmed };
      };

      it("is never replaced by Working: it stays unconfirmed through a fresh unrelated hook", async () => {
        const { h, unconfirmed } = await startTrimmed();
        expect(await h.readOnly()).toEqual([]);
        expect(unconfirmed).toEqual(["held-overflow:7"]);
        h.appendHooks([tool]);
        expect(await h.tick()).toEqual([]);
        expect(await h.tick()).toEqual([]);
      });

      const edit = (event: string) => ({
        hook_event_name: event,
        session_id: SESSION_ID,
        tool_name: "Edit",
      });

      it("still lets a fresh question open and its answer close, without a heartbeat afterwards", async () => {
        const { h } = await startTrimmed();
        expect(await h.readOnly()).toEqual([]);
        h.appendHooks([edit("PermissionRequest")]);
        expect(await h.readOnly()).toEqual(["waiting"]);
        h.appendHooks([edit("PostToolUse")]);
        expect(await h.readOnly()).toEqual(["waiting", "working"]);
        expect(await h.tick()).toEqual(["waiting", "working"]);
      });

      it("lets an open-then-close pair in the retained suffix resolve the question on the server", async () => {
        const h = holder(hookShape(withSessionIdField));
        h.appendHooks([
          {
            hook_event_name: "PermissionRequest",
            session_id: SESSION_ID,
            tool_name: "Bash",
          },
          ...Array.from({ length: 68 }, () => tool),
          edit("PermissionRequest"),
          edit("PostToolUse"),
        ]);
        const discoverer = h.makeDiscoverer(async () => ({}));
        expect(await h.tick()).toEqual([]);
        await discoverer.discover();
        expect(await h.readOnly()).toEqual(["waiting", "working"]);
        expect(await h.tick()).toEqual(["waiting", "working"]);
      });

      it("marks only the answer of a retained question with confirms false, and nothing else", async () => {
        const { h } = await startTrimmed();
        expect(await h.readOnly()).toEqual([]);
        h.appendHooks([edit("PermissionRequest")]);
        await h.readOnly();
        h.appendHooks([edit("PostToolUse")]);
        expect(await h.readOnly()).toEqual(["waiting", "working"]);
        expect(h.sentMarkers).toEqual([undefined, false]);
      });

      it("leaves a non-confirming answer unconfirmed: no report follows it, and a fresh prompt confirms again", async () => {
        const { h } = await startTrimmed();
        expect(await h.readOnly()).toEqual([]);
        h.appendHooks([edit("PermissionRequest"), edit("PostToolUse")]);
        expect(await h.readOnly()).toEqual(["waiting", "working"]);
        expect(await h.tick()).toEqual(["waiting", "working"]);
        expect(await h.tick()).toEqual(["waiting", "working"]);
        h.appendHooks([
          {
            hook_event_name: "UserPromptSubmit",
            prompt: "next",
            session_id: SESSION_ID,
          },
        ]);
        expect(await h.readOnly()).toEqual([
          "waiting",
          "working",
          "working:next",
        ]);
        expect(h.sentMarkers).toEqual([undefined, false, undefined]);
      });

      it("sets no marker when no open question was dropped", async () => {
        const h = holder(hookShape(withSessionIdField));
        h.appendHooks([edit("PermissionRequest"), edit("PostToolUse")]);
        const discoverer = h.makeDiscoverer(async () => ({}));
        expect(await h.tick()).toEqual([]);
        await discoverer.discover();
        expect(await h.readOnly()).toEqual(["waiting", "working"]);
        expect(h.sentMarkers).toEqual([undefined, undefined]);
      });

      it("is cleared by a fresh idle", async () => {
        const { h } = await startTrimmed();
        expect(await h.readOnly()).toEqual([]);
        h.appendHooks([{ hook_event_name: "Stop", session_id: SESSION_ID }]);
        expect(await h.readOnly()).toEqual(["idle"]);
        h.appendHooks([tool]);
        expect(await h.readOnly()).toEqual(["idle", "working"]);
      });

      it("is cleared by a fresh prompt, after which heartbeats resume", async () => {
        const { h } = await startTrimmed();
        expect(await h.readOnly()).toEqual([]);
        h.appendHooks([
          {
            hook_event_name: "UserPromptSubmit",
            prompt: "next",
            session_id: SESSION_ID,
          },
        ]);
        expect(await h.readOnly()).toEqual(["working:next"]);
        expect(await h.tick()).toEqual(["working:next", "working"]);
      });
    },
  );

  it("does not replay an old transcript prompt as Working while a trimmed question is unresolved (hooks + transcript)", async () => {
    const unconfirmed: string[] = [];
    const h = holder(hooksAndTranscriptShape(), unconfirmed);
    h.append(codexTurn("old prompt"));
    h.appendHooks([
      {
        hook_event_name: "PermissionRequest",
        session_id: SESSION_ID,
        tool_name: "Bash",
      },
      ...Array.from({ length: 70 }, () => ({
        hook_event_name: "PreToolUse",
        session_id: SESSION_ID,
      })),
    ]);
    const discoverer = h.makeDiscoverer(async () => ({}));
    expect(await h.tick()).toEqual([]);
    await discoverer.discover();
    expect(await h.readOnly()).toEqual([]);
    expect(unconfirmed).toEqual(["held-overflow:7"]);
    expect(await h.tick()).toEqual([]);
  });
});
