import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import {
  CALLER_THREAD_HEADER_NAME,
  CLI_REQUEST_HEADER_NAME,
} from "@bb/config/app-surface";
import type { Dispatcher } from "undici";
import { resolveContextThreadId } from "./context-env.js";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set("x-bb-app-surface", "cli");
  return fetch(input, { ...init, headers });
}

function cliSdkFetch(timeoutMs: number | undefined): typeof cliFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(CLI_REQUEST_HEADER_NAME, "1");
    const callerThreadId = resolveContextThreadId();
    if (callerThreadId !== undefined) {
      headers.set(CALLER_THREAD_HEADER_NAME, callerThreadId);
    }
    if (timeoutMs === undefined) return cliFetch(input, { ...init, headers });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return cliFetch(input, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal,
    });
  };
}

export function createCliBbSdk(baseUrl: string, timeoutMs?: number): BbSdk {
  return createNodeBbSdk({ baseUrl, fetch: cliSdkFetch(timeoutMs) });
}
