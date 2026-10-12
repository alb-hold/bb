import { BbHttpError } from "@bb/sdk";
import { nativeTerminalClosedForGood } from "./native-holder.js";

export class NativeBbUnreachableError extends Error {
  constructor(cause: unknown) {
    super("bb did not answer the native terminal check", { cause });
    this.name = "NativeBbUnreachableError";
  }
}

function neverAnswered(error: unknown): boolean {
  if (error instanceof TypeError && error.message === "fetch failed") {
    return true;
  }
  return (
    error instanceof Error &&
    error.message.startsWith("Cannot connect to BB server.")
  );
}

export async function checkNativeTerminalClosedForGood(
  load: () => Promise<Parameters<typeof nativeTerminalClosedForGood>[0]>,
): Promise<boolean> {
  try {
    return nativeTerminalClosedForGood(await load());
  } catch (error) {
    if (error instanceof BbHttpError) return error.status === 404;
    if (neverAnswered(error)) throw new NativeBbUnreachableError(error);
    return false;
  }
}
