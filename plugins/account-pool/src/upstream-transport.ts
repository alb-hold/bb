import { lookup as dnsLookup } from "node:dns";
import { Socket, type LookupFunction } from "node:net";
import {
  buildConnector,
  Client,
  EnvHttpProxyAgent,
  errors,
  Pool,
} from "undici";

export const CONNECT_TIMEOUT_MS = 9_000;
export const CONNECT_SURFACE_LIMIT_MS = 10_000;
export const CONNECT_MAX_ADDRESSES = 4;
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_400;

function withConnectDeadline(
  connect: buildConnector.connector,
): buildConnector.connector {
  return (options, callback) => {
    let settled = false;
    let socket: unknown;
    const timer = setTimeout(() => {
      settled = true;
      const error = new errors.ConnectTimeoutError();
      if (socket instanceof Socket) socket.destroy(error);
      callback(error, null);
    }, CONNECT_TIMEOUT_MS);
    timer.unref();
    try {
      socket = connect(options, (...result) => {
        clearTimeout(timer);
        if (settled) {
          result[1]?.destroy();
          return;
        }
        settled = true;
        callback(...result);
      });
      if (socket instanceof Socket)
        socket.once("close", () => clearTimeout(timer));
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };
}

function connectionOptions(options: Pool.Options) {
  const connect =
    typeof options.connect === "function"
      ? options.connect
      : buildConnector(options.connect);
  return { ...options, connect: withConnectDeadline(connect) };
}

export function createUpstreamTransport(
  connect: { lookup?: LookupFunction } = {},
) {
  const resolve = connect.lookup ?? dnsLookup;
  const lookup: LookupFunction = (hostname, options, done) => {
    resolve(hostname, options, (error, address, family) => {
      done(
        error,
        Array.isArray(address)
          ? address.slice(0, CONNECT_MAX_ADDRESSES)
          : address,
        family,
      );
    });
  };
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false,
    factory: (origin, options) =>
      options.connections === 1
        ? new Client(origin, connectionOptions(options))
        : new Pool(origin, connectionOptions(options)),
    clientFactory: (origin, options) =>
      new Client(origin, connectionOptions(options)),
    connect: {
      timeout: CONNECT_TIMEOUT_MS,
      autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
      lookup,
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
