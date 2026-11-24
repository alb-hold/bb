import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BbHttpError } from "@bb/sdk";
import { NativeActivityReader } from "../native-activity-reader.js";
import { createNativeActivityPump } from "../native-activity-wiring.js";
import { createNativeSessionStartedReporter } from "../native-session-started.js";
import { publishHooks } from "./helpers/hook-spool.js";

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

const SESSION_ID = "019a1f3e-0000-7000-8000-000000000042";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function claudeDeclaration(): ProviderNativeTerminal {
  const host = createFakePluginHost({ pluginId: "provider-claude-code" });
  claudeCodePlugin(host.bb);
  const cli = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "claude-code",
  )?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Claude native declaration missing");
  return cli;
}

function readerFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-session-started-"));
  roots.push(root);
  const events = path.join(root, "events");
  const reader = new NativeActivityReader(
    claudeDeclaration(),
    { HOME: root },
    events,
    { kind: "start", id: SESSION_ID },
    () => undefined,
    () => undefined,
  );
  const hook = (records: object[]) =>
    publishHooks(
      events,
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
  return { reader, hook };
}

describe("Claude declares a started hook", () => {
  it("lists SessionStart so the holder can report that the CLI began", () => {
    expect(claudeDeclaration().activity?.hooks?.started).toEqual([
      "SessionStart",
    ]);
  });
});

describe("NativeActivityReader started signal", () => {
  it("reports the session on SessionStart without changing activity", () => {
    const { reader, hook } = readerFixture();
    expect(reader.takeSessionStarted()).toBeNull();
    hook([{ hook_event_name: "SessionStart", session_id: SESSION_ID }]);
    expect(reader.read()).toEqual([]);
    expect(reader.takeSessionStarted()).toBe(SESSION_ID);
    expect(reader.takeSessionStarted()).toBeNull();
  });

  it("ignores a SessionStart from a different session", () => {
    const { reader, hook } = readerFixture();
    hook([{ hook_event_name: "SessionStart", session_id: "someone-else" }]);
    reader.read();
    expect(reader.takeSessionStarted()).toBeNull();
  });
});

describe("createNativeActivityPump started signal", () => {
  it("hands a taken started session to the callback once", () => {
    const taken = [SESSION_ID, null];
    const sessionStarted = vi.fn();
    const pump = createNativeActivityPump({
      reader: () => ({
        read: () => [],
        takeSessionStarted: () => taken.shift() ?? null,
      }),
      report: () => undefined,
      sessionStarted,
    });
    pump();
    pump();
    expect(sessionStarted).toHaveBeenCalledTimes(1);
    expect(sessionStarted).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe("createNativeSessionStartedReporter", () => {
  function setup(
    recordSession: (args: {
      authorization: string;
      nativeSessionId: string;
    }) => Promise<unknown>,
    credential: string | null = "cred",
  ) {
    const log = vi.fn();
    const reporter = createNativeSessionStartedReporter({
      currentCredential: () => credential,
      log,
      recordSession,
    });
    return { log, reporter };
  }

  it("records the session with the credential and stops after success", async () => {
    const recordSession = vi.fn().mockResolvedValue({});
    const { reporter } = setup(recordSession);
    reporter.note(SESSION_ID);
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(recordSession).toHaveBeenCalledTimes(1);
    expect(recordSession).toHaveBeenCalledWith({
      authorization: "Bearer cred",
      nativeSessionId: SESSION_ID,
    });
  });

  it("retries after a transient failure", async () => {
    const recordSession = vi
      .fn()
      .mockRejectedValueOnce(
        new BbHttpError({
          status: 503,
          code: null,
          message: "unavailable",
          body: {},
        }),
      )
      .mockResolvedValue({});
    const { reporter } = setup(recordSession);
    reporter.note(SESSION_ID);
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(recordSession).toHaveBeenCalledTimes(2);
  });

  it("gives up on a permanent refusal and logs it", async () => {
    const recordSession = vi.fn().mockRejectedValue(
      new BbHttpError({
        status: 409,
        code: "native_session_claimed",
        message: "claimed",
        body: {},
      }),
    );
    const { log, reporter } = setup(recordSession);
    reporter.note(SESSION_ID);
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(recordSession).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "session-started-refused",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("waits for a credential before sending", async () => {
    const recordSession = vi.fn().mockResolvedValue({});
    const { reporter } = setup(recordSession, null);
    reporter.note(SESSION_ID);
    await reporter.settled();
    expect(recordSession).not.toHaveBeenCalled();
  });
});
