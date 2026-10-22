import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import { BbHttpError } from "@bb/sdk";
import { afterEach, describe, expect, it } from "vitest";
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

function holder() {
  const cli = codexCli();
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
  const reader = new NativeActivityReader(cli, env, null, { kind: "discover" });
  const sentReports: string[] = [];
  const recorded: string[] = [];
  const logged: string[] = [];
  const reporter = createNativeActivityReporter({
    currentCredential: () => "current",
    send: async (args) => {
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
    logged,
    makeDiscoverer,
    readOnly,
    recorded,
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
});
