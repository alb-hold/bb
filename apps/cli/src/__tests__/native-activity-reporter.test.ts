import { BbHttpError, BbRequestTimeoutError } from "@bb/sdk";
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

  describe("question closure and the non-confirming marker (INJECTED responses: the rejections below are hand-built; the wording against the real pre-change schema is pinned in apps/server/test/threads/native-activity-delivery.test.ts)", () => {
    const rejection = (fields: string = '"confirms"') =>
      new BbHttpError({
        body: null,
        code: "invalid_request",
        message: `Unrecognized key: ${fields}`,
        status: 400,
      });
    const unavailable = () =>
      new BbHttpError({
        body: null,
        code: "unavailable",
        message: "unavailable",
        status: 503,
      });
    const working = { prompt: null, state: "working" } as const;
    const marked = { confirms: false, prompt: null, state: "working" } as const;
    const asking = (...ids: string[]) =>
      ({
        prompt: null,
        questions: ids.map((id) => ({ id, prompt: `Question ${id}?` })),
        state: "waiting",
      }) as const;

    function closureSetup(answers: Array<() => Promise<unknown>>) {
      const calls: Array<{
        authorization: string | undefined;
        closes: string[] | undefined;
        confirms: boolean | undefined;
        prompt: string | undefined;
        state: string;
      }> = [];
      const logged: string[] = [];
      let credential = "c";
      const reporter = createNativeActivityReporter({
        currentCredential: () => credential,
        log: (event) => logged.push(event),
        send: async (args) => {
          calls.push({
            authorization: args.authorization,
            closes: args.closes,
            confirms: args.confirms,
            prompt: args.prompt,
            state: args.state,
          });
          credential = "rotated-after-an-attempt";
          const answer = answers[calls.length - 1];
          return answer === undefined ? { ok: true } : answer();
        },
        threadId: "thr_1",
      });
      return { calls, logged, reporter };
    }

    const closesOf = (calls: Array<{ closes: string[] | undefined }>) =>
      calls.map((call) => call.closes);

    it("sends the first report as it always did and names what each later report closes", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(asking("q1"));
      reporter.report(working);
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], []]);
    });

    it("lets an opening report replace the questions it does not list, and never names the ones it opens", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(asking("q1"));
      reporter.report(asking("q2"));
      reporter.report(asking("q2", "q3"));
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], []]);
    });

    it("carries a close whose delivery timed out in the next report, so a late delivery of the first one has nothing left to take", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw new BbRequestTimeoutError(75_000);
        },
      ]);
      reporter.report(asking("q1"));
      reporter.report(working);
      await reporter.settled();
      reporter.report(asking("q2"));
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"], ["q1"]]);
    });

    it("treats a question as possibly open from the moment its report is attempted", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw new BbRequestTimeoutError(75_000);
        },
      ]);
      reporter.report(working);
      reporter.report(asking("q1"));
      await reporter.settled();
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, [], ["q1"]]);
    });

    it("sends confirms false only on a report that carries the marker", async () => {
      const { calls, reporter } = closureSetup([]);
      reporter.report(working);
      reporter.report(marked);
      await reporter.settled();
      expect(calls.map((call) => call.confirms)).toEqual([undefined, false]);
    });

    it("never resends a report that closes a question to an older server, and stops sending the fields", async () => {
      const { calls, logged, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw rejection('"closes"');
        },
      ]);
      reporter.report(asking("q1"));
      reporter.report(working);
      await reporter.settled();
      expect(closesOf(calls)).toEqual([undefined, ["q1"]]);
      expect(logged).toEqual(["activity-closure-field-rejected"]);
      reporter.report(working);
      await reporter.settled();
      expect(calls).toHaveLength(3);
      expect(closesOf(calls)).toEqual([undefined, ["q1"], undefined]);
      expect(calls[2]?.confirms).toBeUndefined();
      expect(logged).toHaveLength(1);
    });

    it("resends a report that closes nothing without the fields when an older server rejects it, with the same credential and payload, at most once", async () => {
      const { calls, logged, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw rejection('"confirms", "closes"');
        },
        async () => {
          throw rejection('"confirms", "closes"');
        },
      ]);
      reporter.report(working);
      reporter.report({ confirms: false, prompt: "kept", state: "working" });
      await reporter.settled();
      expect(calls).toHaveLength(3);
      expect(closesOf(calls)).toEqual([undefined, [], undefined]);
      expect(calls[1]?.confirms).toBe(false);
      expect(calls[2]?.confirms).toBeUndefined();
      expect(calls[2]?.authorization).toBe(calls[1]?.authorization);
      expect(calls[1]?.authorization).toBe("Bearer rotated-after-an-attempt");
      expect(calls[2]?.prompt).toBe("kept");
      expect(logged).toEqual(["activity-closure-field-rejected"]);
    });

    it.each([
      [
        "a 400 that does not name the fields",
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
        "a 400 that names a field but is not a request validation error",
        () =>
          new BbHttpError({
            body: null,
            code: "native_terminal_question_refused",
            message: 'Unrecognized key: "closes"',
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
        "a refusal that names a field",
        () =>
          new BbHttpError({
            body: null,
            code: "invalid_request",
            message: 'Unrecognized key: "closes"',
            status: 409,
          }),
      ],
      ["a 5xx", unavailable],
      ["a transport failure", () => new TypeError("fetch failed")],
    ])("does not fall back on %s", async (_name, failure) => {
      const { calls, logged, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw failure();
        },
      ]);
      reporter.report(working);
      reporter.report(marked);
      await reporter.settled();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.confirms).toBe(false);
      expect(logged).toEqual([]);
    });

    it("keeps the report for a later resend when the fallback attempt fails for a transient reason", async () => {
      const { calls, reporter } = closureSetup([
        async () => ({ ok: true }),
        async () => {
          throw rejection('"confirms", "closes"');
        },
        async () => {
          throw unavailable();
        },
      ]);
      reporter.report(working);
      reporter.report(marked);
      await reporter.settled();
      expect(calls).toHaveLength(3);
      reporter.retry();
      await reporter.settled();
      expect(calls).toHaveLength(4);
      expect(closesOf(calls)).toEqual([undefined, [], undefined, undefined]);
    });
  });
});
