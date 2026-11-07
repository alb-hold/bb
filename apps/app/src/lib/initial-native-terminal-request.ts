declare global {
  var __bbInitialNativeTerminalRequest:
    | { path: string; response: Promise<Response>; claimed?: boolean }
    | undefined;
}

export function takeInitialNativeTerminalResponse(
  url: URL,
  signal?: AbortSignal | null,
): Promise<Response | null> | null {
  const initial = globalThis.__bbInitialNativeTerminalRequest;
  if (
    !initial ||
    initial.claimed ||
    typeof window === "undefined" ||
    url.origin !== window.location.origin ||
    url.pathname !== initial.path
  )
    return null;
  initial.claimed = true;
  return initial.response
    .then((response) => {
      signal?.throwIfAborted();
      return response.ok ? response.clone() : null;
    })
    .catch(() => {
      signal?.throwIfAborted();
      return null;
    });
}
