export async function recordDiscoveredSession(options: {
  currentCredential(): string | null;
  nativeSessionId: string;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
}): Promise<boolean> {
  const credential = options.currentCredential();
  if (credential === null) return false;
  try {
    await options.recordSession({
      authorization: `Bearer ${credential}`,
      nativeSessionId: options.nativeSessionId,
    });
    return true;
  } catch {
    return false;
  }
}
