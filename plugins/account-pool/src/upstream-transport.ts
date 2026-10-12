import type { LookupFunction } from "node:net";
import { EnvHttpProxyAgent } from "undici";

export const CONNECT_ATTEMPT_TIMEOUT_MS = 3_000;

export function createUpstreamTransport(
  connect: { lookup?: LookupFunction } = {},
) {
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false,
    connect: {
      autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
      ...connect,
    },
  });
  const upstreamFetch: typeof fetch = (input, init) => {
    const options = { ...init, dispatcher };
    return fetch(input, options);
  };
  return {
    fetch: upstreamFetch,
    destroy: () => dispatcher.destroy(),
  };
}

const TRANSPORT_CODES = new Set([
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_GOAWAY_SESSION",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

export function transportErrorCode(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      TRANSPORT_CODES.has(cause.code)
    ) {
      return withMemberCodes(cause, cause.code);
    }
    cause = cause.cause;
  }
  return "unclassified transport error";
}

function withMemberCodes(error: Error, code: string): string {
  if (!("errors" in error) || !Array.isArray(error.errors)) return code;
  const members = error.errors.flatMap((member: unknown) =>
    member instanceof Error &&
    "code" in member &&
    typeof member.code === "string"
      ? [member.code]
      : [],
  );
  return members.length === 0 ? code : `${code} [${members.join(", ")}]`;
}
