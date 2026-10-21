import { BbHttpError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { createNativeActivityReporter } from "../native-activity-reporter.js";

interface Sent {
  authorization: string | undefined;
  state: string;
}

function setup(initial: string | null) {
  let credential = initial;
  const sent: Sent[] = [];
  const reporter = createNativeActivityReporter({
    currentCredential: () => credential,
    send: async (args) => {
      sent.push({ authorization: args.authorization, state: args.state });
      return { ok: true };
    },
    threadId: "thr_1",
  });
  return {
    reporter,
    sent,
    setCredential: (next: string | null) => {
      credential = next;
    },
  };
}

describe("native activity reporter", () => {
  it("reads the holder's current credential when each report is sent", async () => {
    const { reporter, sent, setCredential } = setup("first");
    reporter.report({ state: "working", prompt: null });
    await reporter.settled();
    setCredential("second");
    reporter.report({ state: "working", prompt: null });
    await reporter.settled();
    expect(sent).toEqual([
      { authorization: "Bearer first", state: "working" },
      { authorization: "Bearer second", state: "working" },
    ]);
  });

  it("picks up a credential that changes while an earlier report is in flight", async () => {
    let credential: string | null = "first";
    const sent: Array<string | undefined> = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reporter = createNativeActivityReporter({
      currentCredential: () => credential,
      send: async (args) => {
        sent.push(args.authorization);
        if (sent.length === 1) await gate;
        return { ok: true };
      },
      threadId: "thr_1",
    });
    reporter.report({ state: "working", prompt: null });
    reporter.report({ state: "idle", prompt: null });
    await Promise.resolve();
    expect(sent).toEqual(["Bearer first"]);
    credential = "second";
    releaseFirst();
    await reporter.settled();
    expect(sent).toEqual(["Bearer first", "Bearer second"]);
  });

  it("sends no authorization when the holder has no credential", async () => {
    const { reporter, sent } = setup(null);
    reporter.report({ state: "working", prompt: null });
    await reporter.settled();
    expect(sent).toEqual([{ authorization: undefined, state: "working" }]);
  });

  it("does not send an empty report", async () => {
    const { reporter, sent } = setup("first");
    reporter.report(null);
    await reporter.settled();
    expect(sent).toEqual([]);
  });

  describe("a report the server rejects for its credential", () => {
    const rejection = () =>
      new BbHttpError({
        body: null,
        code: "native_terminal_credential_invalid",
        message: "invalid",
        status: 401,
      });

    function rejecting(rejectFirst: number) {
      const sent: Array<{ authorization: string | undefined; state: string }> =
        [];
      let credential: string | null = "old";
      const reporter = createNativeActivityReporter({
        currentCredential: () => credential,
        send: async (args) => {
          sent.push({ authorization: args.authorization, state: args.state });
          if (sent.length <= rejectFirst) throw rejection();
          return { ok: true };
        },
        threadId: "thr_1",
      });
      return {
        reporter,
        sent,
        setCredential: (next: string | null) => {
          credential = next;
        },
      };
    }

    it("is kept and resent once, with the credential current then, when the holder retries", async () => {
      const { reporter, sent, setCredential } = rejecting(1);
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([{ authorization: "Bearer old", state: "idle" }]);

      setCredential("new");
      reporter.retry();
      await reporter.settled();
      expect(sent).toEqual([
        { authorization: "Bearer old", state: "idle" },
        { authorization: "Bearer new", state: "idle" },
      ]);
      reporter.retry();
      await reporter.settled();
      expect(sent).toHaveLength(2);
    });

    it("keeps only the latest report: a newer one replaces the retained one", async () => {
      const { reporter, sent } = rejecting(2);
      reporter.report({ state: "idle", prompt: null });
      reporter.report({ state: "working", prompt: "next" });
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
      reporter.retry();
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual([
        "idle",
        "working",
        "working",
      ]);
    });

    it("drops the retained report when a newer report is accepted, so a stale state is never resent after it", async () => {
      const { reporter, sent } = rejecting(1);
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      reporter.report({ state: "working", prompt: "next" });
      await reporter.settled();
      reporter.retry();
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
    });

    it("does not keep a heartbeat", async () => {
      const { reporter, sent } = rejecting(1);
      reporter.report({ state: "working", prompt: null }, { transient: true });
      await reporter.settled();
      reporter.retry();
      await reporter.settled();
      expect(sent).toHaveLength(1);
    });

    it("keeps the report through repeated rejections until it is accepted", async () => {
      const { reporter, sent } = rejecting(3);
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        reporter.retry();
        await reporter.settled();
      }
      expect(sent).toHaveLength(4);
      reporter.retry();
      await reporter.settled();
      expect(sent).toHaveLength(4);
    });

    it("does not keep a report rejected for any other reason", async () => {
      const sent: string[] = [];
      const reporter = createNativeActivityReporter({
        currentCredential: () => "c",
        send: async (args) => {
          sent.push(args.state);
          throw new Error("down");
        },
        threadId: "thr_1",
      });
      reporter.report({ state: "idle", prompt: null });
      await reporter.settled();
      reporter.retry();
      await reporter.settled();
      expect(sent).toEqual(["idle"]);
    });
  });
});
