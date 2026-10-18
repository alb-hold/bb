import { createApiClient } from "@bb/server-contract";
import { DEVICE_HANDOFF_CLIENT_TOKEN_HEADER } from "@bb/server-contract";
import { fetchWithAppSurface } from "./app-surface";
import { wsManager } from "./ws";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

const turnSubmissionPath =
  /^\/api\/v1\/(?:threads\/[^/]+\/(?:send|edit-message|retry|queued-messages(?:\/[^/]+\/send)?)|device-handoff\/claim)$/u;

export function fetchWithDeviceHandoffSubmission(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    BASE_URL,
  );
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (
    url.origin === BASE_URL &&
    method === "POST" &&
    turnSubmissionPath.test(url.pathname)
  ) {
    const token = wsManager.getDeviceHandoffClientToken();
    if (token !== null) {
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      );
      headers.set(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER, token);
      init = { ...init, headers };
    }
  }
  return fetchWithAppSurface(input, init);
}

const client = createApiClient(BASE_URL, {
  fetch: fetchWithDeviceHandoffSubmission,
});

export const apiClient = client.api.v1;

export function toRelativeUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}
