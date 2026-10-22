import { permanentRefusal } from "./native-session-rebinder.js";

export type DiscoveredSessionOutcome =
  | { kind: "recorded" }
  | { code: string; kind: "refused" }
  | { kind: "retry" };

export async function recordDiscoveredSession(options: {
  currentCredential(): string | null;
  nativeSessionId: string;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
}): Promise<DiscoveredSessionOutcome> {
  const credential = options.currentCredential();
  if (credential === null) return { kind: "retry" };
  try {
    await options.recordSession({
      authorization: `Bearer ${credential}`,
      nativeSessionId: options.nativeSessionId,
    });
    return { kind: "recorded" };
  } catch (error) {
    const code = permanentRefusal(error);
    return code === null ? { kind: "retry" } : { code, kind: "refused" };
  }
}
