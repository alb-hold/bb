import { describe, expect, it } from "vitest";
import { recordDiscoveredSession } from "../native-session-discovery.js";

const ID = "01a1246a-b896-7b71-9895-ce5345f5f623";

describe("recording a discovered native session", () => {
  it("sends the holder's current credential with the session id", async () => {
    const sent: Array<{ authorization: string; nativeSessionId: string }> = [];
    const recorded = await recordDiscoveredSession({
      currentCredential: () => "current",
      nativeSessionId: ID,
      recordSession: async (args) => {
        sent.push(args);
      },
    });
    expect(recorded).toBe(true);
    expect(sent).toEqual([
      { authorization: "Bearer current", nativeSessionId: ID },
    ]);
  });

  it("sends nothing and reports not recorded while the holder has no credential yet", async () => {
    let calls = 0;
    const recorded = await recordDiscoveredSession({
      currentCredential: () => null,
      nativeSessionId: ID,
      recordSession: async () => {
        calls += 1;
      },
    });
    expect(recorded).toBe(false);
    expect(calls).toBe(0);
  });

  it("reports not recorded when the server refuses, so that it is tried again", async () => {
    const recorded = await recordDiscoveredSession({
      currentCredential: () => "current",
      nativeSessionId: ID,
      recordSession: async () => {
        throw new Error("401");
      },
    });
    expect(recorded).toBe(false);
  });
});
