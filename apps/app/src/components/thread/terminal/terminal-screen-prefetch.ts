import { sdk } from "@/lib/sdk";

type ScreenRequest = ReturnType<typeof requestScreen>;
const pending = new Map<string, { at: number; request: ScreenRequest }>();
const keyFor = (terminalId: string, threadId?: string) =>
  JSON.stringify([terminalId, threadId]);

function requestScreen(terminalId: string, threadId?: string) {
  return Promise.resolve(
    sdk.terminals.experimental_screen({ terminalId, threadId }),
  ).catch(() => null);
}

export function prefetchTerminalScreen(
  terminalId: string,
  threadId?: string,
): ScreenRequest {
  const key = keyFor(terminalId, threadId);
  const cached = pending.get(key);
  if (cached && Date.now() - cached.at < 5_000) return cached.request;
  pending.delete(key);
  if (pending.size >= 4) pending.delete(pending.keys().next().value!);
  const request = requestScreen(terminalId, threadId);
  pending.set(key, { at: Date.now(), request });
  return request;
}

export function fetchTerminalScreen(
  terminalId: string,
  threadId?: string,
): ScreenRequest {
  const key = keyFor(terminalId, threadId);
  const cached = pending.get(key);
  pending.delete(key);
  return cached && Date.now() - cached.at < 5_000
    ? cached.request
    : requestScreen(terminalId, threadId);
}
