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

    it("does not retain an older report that fails after a newer one was already queued", async () => {
      const { reporter, sent } = rejecting(1);
      reporter.report({ state: "idle", prompt: null });
      reporter.report({ state: "working", prompt: "next" });
      await reporter.settled();
      expect(sent.map((entry) => entry.state)).toEqual(["idle", "working"]);
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

  describe("the non-confirming marker (INJECTED responses: the rejections below are hand-built; the wording against the real pre-change schema is pinned in apps/server/test/threads/native-activity-delivery.test.ts)", () => {
    const rejection = () =>
      new BbHttpError({
        body: null,
        code: "invalid_request",
        message: 'Unrecognized key: "confirms"',
        status: 400,
      });

    function markerSetup(answers: Array<() => Promise<unknown>>) {
      const sent: Array<boolean | undefined> = [];
      const calls: Array<{
        authorization: string | undefined;
        prompt: string | undefined;
        state: string;
      }> = [];
      const logged: string[] = [];
      let credential = "c";
      const reporter = createNativeActivityReporter({
        currentCredential: () => credential,
        log: (event) => logged.push(event),
        send: async (args) => {
          sent.push(args.confirms);
          calls.push({
            authorization: args.authorization,
            prompt: args.prompt,
            state: args.state,
          });
          credential = "rotated-after-first-attempt";
          const answer = answers[sent.length - 1];
          return answer === undefined ? { ok: true } : answer();
        },
        threadId: "thr_1",
      });
      return { calls, logged, reporter, sent };
    }

    it("sends confirms false only on a report that carries the marker", async () => {
      const { reporter, sent } = markerSetup([]);
      reporter.report({ state: "working", prompt: null });
      reporter.report({ confirms: false, state: "working", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([undefined, false]);
    });

    it("retries the one report without the field when an old server rejects it, logs it, and stops sending the field", async () => {
      const { logged, reporter, sent } = markerSetup([
        async () => {
          throw rejection();
        },
      ]);
      reporter.report({ confirms: false, state: "working", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([false, undefined]);
      expect(logged).toEqual(["activity-confirms-field-rejected"]);
      reporter.report({ confirms: false, state: "working", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([false, undefined, undefined]);
      expect(logged).toHaveLength(1);
    });

    it.each([
      [
        "a 400 that does not name the field",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: "Required",
            status: 400,
          }),
      ],
      [
        "an unrelated validation error",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: "Too big: expected string to have <=4000 characters",
            status: 400,
          }),
      ],
      [
        "a 400 that names the field but is not a request validation error",
        () =>
          new BbHttpError({
            body: null,
            code: "native_terminal_question_refused",
            message: 'Unrecognized key: "confirms"',
            status: 400,
          }),
      ],
      [
        "a credential refusal",
        () =>
          new BbHttpError({
            body: null,
            code: "native_terminal_credential_invalid",
            message: "A valid credential is required",
            status: 401,
          }),
      ],
      [
        "a refusal that names the field",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: 'Unrecognized key: "confirms"',
            status: 409,
          }),
      ],
      [
        "a 5xx",
        () =>
          new BbHttpError({
            body: null,
            code: "unavailable",
            message: "unavailable",
            status: 503,
          }),
      ],
      ["a transport failure", () => new TypeError("fetch failed")],
    ])("does not fall back on %s", async (_name, failure) => {
      const { logged, reporter, sent } = markerSetup([
        async () => {
          throw failure();
        },
      ]);
      reporter.report({ confirms: false, state: "working", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([false]);
      expect(logged).toEqual([]);
    });

    it("falls back at most once per report, with the same credential and payload", async () => {
      const { calls, logged, reporter, sent } = markerSetup([
        async () => {
          throw rejection();
        },
        async () => {
          throw rejection();
        },
      ]);
      reporter.report({ confirms: false, state: "working", prompt: "kept" });
      await reporter.settled();
      expect(sent).toEqual([false, undefined]);
      expect(calls).toEqual([
        { authorization: "Bearer c", prompt: "kept", state: "working" },
        { authorization: "Bearer c", prompt: "kept", state: "working" },
      ]);
      expect(logged).toEqual(["activity-confirms-field-rejected"]);
    });

    it("keeps the report for a later resend when the fallback attempt fails for a transient reason", async () => {
      const { reporter, sent } = markerSetup([
        async () => {
          throw rejection();
        },
        async () => {
          throw new BbHttpError({
            body: null,
            code: "unavailable",
            message: "unavailable",
            status: 503,
          });
        },
      ]);
      reporter.report({ confirms: false, state: "working", prompt: null });
      await reporter.settled();
      expect(sent).toEqual([false, undefined]);
      reporter.retry();
      await reporter.settled();
      expect(sent).toEqual([false, undefined, undefined]);
    });
  });
});

