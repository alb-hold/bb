import { BbHttpError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { recordDiscoveredSession } from "../native-session-discovery.js";

const ID = "01a1246a-b896-7b71-9895-ce5345f5f623";

function refusal(status: number, code: string): BbHttpError {
  return new BbHttpError({ body: null, code, message: code, status });
}

function holder(answers: unknown[]) {
  const sent: Array<{ authorization: string; nativeSessionId: string }> = [];
  let stopped = false;
  let recorded = false;
  let credential: string | null = "current";
  const tick = async () => {
    if (recorded || stopped) return;
    const outcome = await recordDiscoveredSession({
      currentCredential: () => credential,
      nativeSessionId: ID,
      recordSession: async (args) => {
        sent.push(args);
        const answer = answers[sent.length - 1];
        if (answer instanceof Error) throw answer;
        return answer ?? {};
      },
    });
    recorded = outcome.kind === "recorded";
    stopped = outcome.kind === "refused";
    return outcome;
  };
  return {
    sent,
    setCredential: (next: string | null) => {
      credential = next;
    },
    tick,
  };
}

describe("recording a discovered native session", () => {
  it("sends the holder's current credential with the session id", async () => {
    const h = holder([]);
    expect(await h.tick()).toEqual({ kind: "recorded" });
    expect(h.sent).toEqual([
      { authorization: "Bearer current", nativeSessionId: ID },
    ]);
  });

  it("sends nothing and asks to retry while the holder has no credential yet", async () => {
    const h = holder([]);
    h.setCredential(null);
    expect(await h.tick()).toEqual({ kind: "retry" });
    expect(h.sent).toEqual([]);
  });

  it("retries a 401 (the credential hash not stored yet) and records on the next tick", async () => {
    const h = holder([refusal(401, "native_terminal_credential_invalid")]);
    expect(await h.tick()).toEqual({ kind: "retry" });
    expect(await h.tick()).toEqual({ kind: "recorded" });
    expect(h.sent).toHaveLength(2);
  });

  it.each([
    new TypeError("fetch failed"),
    refusal(503, "unavailable"),
    refusal(409, "native_terminal_not_live"),
  ])("keeps retrying a transient failure", async (failure) => {
    const h = holder([failure]);
    expect(await h.tick()).toEqual({ kind: "retry" });
    expect(await h.tick()).toEqual({ kind: "recorded" });
  });

  it("stops for good on a permanent refusal such as a session another thread holds", async () => {
    const h = holder([refusal(409, "native_session_claimed")]);
    expect(await h.tick()).toEqual({
      code: "native_session_claimed",
      kind: "refused",
    });
    await h.tick();
    await h.tick();
    expect(h.sent).toHaveLength(1);
  });

  it("stops on an unexpected failure that is not a transport error", async () => {
    const h = holder([new Error("boom")]);
    expect(await h.tick()).toEqual({
      code: "unexpected_error",
      kind: "refused",
    });
  });
});
