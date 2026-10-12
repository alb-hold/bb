import { BbHttpError } from "@bb/sdk";
import { createNodeBbSdk } from "@bb/sdk/node";
import { cliFetch } from "./client.js";
import { nativeTerminalClosedForGood } from "./native-holder.js";

const NATIVE_CLOSED_CHECK_TIMEOUT_MS = 10_000;

export class NativeBbUnreachableError extends Error {
  constructor(cause: unknown) {
    super("bb did not answer the native terminal check", { cause });
    this.name = "NativeBbUnreachableError";
  }
}

export async function checkNativeTerminalClosedForGood(args: {
  baseUrl: string;
  threadId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  let answered = false;
  const timeoutMs = args.timeoutMs ?? NATIVE_CLOSED_CHECK_TIMEOUT_MS;
  const sdk = createNodeBbSdk({
    baseUrl: args.baseUrl,
    fetch: async (input, init) => {
      const response = await cliFetch(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      answered = true;
      return response;
    },
  });
  try {
    return nativeTerminalClosedForGood(
      await sdk.nativeTerminals.get({ threadId: args.threadId }),
    );
  } catch (error) {
    if (error instanceof BbHttpError) return error.status === 404;
    if (answered) return false;
    throw new NativeBbUnreachableError(error);
  }
}
