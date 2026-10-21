import { BbHttpError } from "@bb/sdk";
import { describe, expect, it } from "vitest";
import { createNativeSessionRebinder } from "../native-session-rebinder.js";

const A = "aaaaaaaa-1111-4222-8333-444455556666";
const B = "bbbbbbbb-1111-4222-8333-444455556666";
const C = "cccccccc-1111-4222-8333-444455556666";

function refusal(status: number, code: string): BbHttpError {
  return new BbHttpError({ body: null, code, message: code, status });
}

interface Attempt {
  authorization: string;
  nativeSessionId: string;
  replacesNativeSessionId: string;
}

function setup(
  initial: string | null,
  answer: (attempt: Attempt, index: number) => unknown = () => ({}),
) {
  let credential = initial;
  const attempts: Attempt[] = [];
  const refused: Array<{ code: string; sessionId: string }> = [];
  const rebinder = createNativeSessionRebinder({
    currentCredential: () => credential,
    onRefused: (move, code) =>
      refused.push({ code, sessionId: move.sessionId }),
    recordSession: async (attempt) => {
      attempts.push(attempt);
      const outcome = answer(attempt, attempts.length - 1);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return {
    attempts,
    rebinder,
    refused,
    setCredential: (next: string | null) => {
      credential = next;
    },
  };
}

describe("native session rebinder", () => {
  it("sends the move with the holder's current credential", async () => {
    const { attempts, rebinder } = setup("first");
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(attempts).toEqual([
      {
        authorization: "Bearer first",
        nativeSessionId: B,
        replacesNativeSessionId: A,
      },
    ]);
    expect(rebinder.pending()).toBe(0);
  });

  it("keeps the move while the server cannot accept it yet and retries it with the refreshed credential", async () => {
    const { attempts, rebinder, refused, setCredential } = setup(
      "old",
      (attempt) =>
        attempt.authorization === "Bearer old"
          ? refusal(409, "native_terminal_not_live")
          : {},
    );
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(rebinder.pending()).toBe(1);
    rebinder.retry();
    await rebinder.settled();
    expect(attempts).toHaveLength(2);
    expect(rebinder.pending()).toBe(1);

    setCredential("new");
    rebinder.retry();
    await rebinder.settled();
    expect(attempts.at(-1)?.authorization).toBe("Bearer new");
    expect(rebinder.pending()).toBe(0);
    expect(refused).toEqual([]);
  });

  it("treats an invalid credential, a server error and a network failure as retryable", async () => {
    const failures = [
      refusal(401, "native_terminal_credential_invalid"),
      refusal(503, "unavailable"),
      new TypeError("fetch failed"),
    ];
    for (const failure of failures) {
      const { rebinder, refused } = setup("c", (_attempt, index) =>
        index === 0 ? failure : {},
      );
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      await rebinder.settled();
      expect(rebinder.pending()).toBe(1);
      rebinder.retry();
      await rebinder.settled();
      expect(rebinder.pending()).toBe(0);
      expect(refused).toEqual([]);
    }
  });

  it("does not try while it holds no credential", async () => {
    const { attempts, rebinder, setCredential } = setup(null);
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    await rebinder.settled();
    expect(attempts).toEqual([]);
    expect(rebinder.pending()).toBe(1);
    setCredential("c");
    rebinder.retry();
    await rebinder.settled();
    expect(attempts).toHaveLength(1);
  });

  it("applies chained moves in order and never sends a later one before the earlier is accepted", async () => {
    const { attempts, rebinder } = setup("c", (attempt, index) =>
      index === 0 ? refusal(409, "native_terminal_not_live") : {},
    );
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    rebinder.enqueue({ previousSessionId: B, sessionId: C });
    await rebinder.settled();
    expect(attempts.map((attempt) => attempt.nativeSessionId)).toEqual([B]);
    rebinder.retry();
    await rebinder.settled();
    expect(attempts.map((attempt) => attempt.nativeSessionId)).toEqual([
      B,
      B,
      C,
    ]);
    expect(rebinder.pending()).toBe(0);
  });

  it.each([
    "native_session_claimed",
    "native_session_rebind_stale",
    "native_session_already_bound",
  ])(
    "gives up for good on a permanent refusal (%s) and reports it once",
    async (code) => {
      const { attempts, rebinder, refused } = setup("c", () =>
        refusal(409, code),
      );
      rebinder.enqueue({ previousSessionId: A, sessionId: B });
      rebinder.enqueue({ previousSessionId: B, sessionId: C });
      await rebinder.settled();
      expect(refused).toEqual([{ code, sessionId: B }]);
      expect(rebinder.pending()).toBe(0);
      rebinder.retry();
      await rebinder.settled();
      expect(attempts).toHaveLength(1);
      expect(refused).toHaveLength(1);
    },
  );

  it("sends one request at a time", async () => {
    let release: (() => void) | undefined;
    let inFlight = 0;
    let highest = 0;
    const rebinder = createNativeSessionRebinder({
      currentCredential: () => "c",
      onRefused: () => undefined,
      recordSession: async () => {
        inFlight += 1;
        highest = Math.max(highest, inFlight);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        inFlight -= 1;
        return {};
      },
    });
    rebinder.enqueue({ previousSessionId: A, sessionId: B });
    rebinder.retry();
    rebinder.retry();
    await Promise.resolve();
    release?.();
    await rebinder.settled();
    expect(highest).toBe(1);
  });
});
