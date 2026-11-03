import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import type { Dispatcher } from "undici";

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

function cliFetchWithTimeout(timeoutMs: number): typeof cliFetch {
  return (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return cliFetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal,
    });
  };
}

export function createCliBbSdk(baseUrl: string, timeoutMs?: number): BbSdk {
  return createNodeBbSdk({
    baseUrl,
    fetch: timeoutMs === undefined ? cliFetch : cliFetchWithTimeout(timeoutMs),
  });
}
