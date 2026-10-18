import type { QueryClient } from "@tanstack/react-query";
import type {
  NativeTerminalThread,
  TerminalListResponse,
  TerminalSession,
} from "@bb/server-contract";
import {
  allTerminalsQueryKeyPrefix,
  nativeTerminalThreadQueryKey,
  terminalsQueryKey,
  type TerminalQueryScope,
} from "../queries/query-keys";

interface TerminalSessionCacheArgs {
  queryClient: QueryClient;
  session: TerminalSession;
}

interface CloseTerminalSessionCacheArgs extends TerminalSessionCacheArgs {
  terminalId: string;
}

function upsertTerminalSession(
  current: TerminalListResponse | undefined,
  session: TerminalSession,
): TerminalListResponse {
  if (!current) {
    return { sessions: [session] };
  }

  const existingIndex = current.sessions.findIndex(
    (existingSession) => existingSession.id === session.id,
  );
  if (existingIndex === -1) {
    return { sessions: [...current.sessions, session] };
  }

  return {
    sessions: current.sessions.map((existingSession) =>
      existingSession.id === session.id ? session : existingSession,
    ),
  };
}

function removeTerminalSession(
  current: TerminalListResponse | undefined,
  terminalId: string,
): TerminalListResponse | undefined {
  if (!current) {
    return current;
  }

  const sessions = current.sessions.filter((session) => {
    return session.id !== terminalId;
  });
  if (sessions.length === current.sessions.length) {
    return current;
  }

  return { sessions };
}

function refreshNativeTerminalThread(
  queryClient: QueryClient,
  session: TerminalSession,
): void {
  if (session.threadId === null) return;
  void queryClient.invalidateQueries({
    queryKey: nativeTerminalThreadQueryKey(session.threadId),
    exact: true,
  });
}

function terminalScopesForSession(
  session: TerminalSession,
): TerminalQueryScope[] {
  if (session.threadId !== null) {
    return [{ kind: "thread", threadId: session.threadId }];
  }
  if (session.environmentId !== null) {
    return [{ kind: "environment", environmentId: session.environmentId }];
  }
  return [
    { kind: "host_path", hostId: session.hostId },
    { kind: "host_path", hostId: session.hostId, cwd: session.initialCwd },
  ];
}

function upsertTerminalSessionCaches({
  queryClient,
  session,
}: TerminalSessionCacheArgs): void {
  for (const scope of terminalScopesForSession(session)) {
    queryClient.setQueryData<TerminalListResponse>(
      terminalsQueryKey(scope),
      (current) => upsertTerminalSession(current, session),
    );
  }
  queryClient.invalidateQueries({
    queryKey: allTerminalsQueryKeyPrefix(),
  });
}

export function applyTerminalSessionUpsert({
  queryClient,
  session,
}: TerminalSessionCacheArgs): void {
  upsertTerminalSessionCaches({ queryClient, session });
  refreshNativeTerminalThread(queryClient, session);
}

export function applyTerminalSessionMissing({
  queryClient,
  terminalId,
}: {
  queryClient: QueryClient;
  terminalId: string;
}): void {
  queryClient.setQueriesData<TerminalListResponse>(
    { queryKey: allTerminalsQueryKeyPrefix() },
    (current) => removeTerminalSession(current, terminalId),
  );
  queryClient.invalidateQueries({
    queryKey: allTerminalsQueryKeyPrefix(),
  });
}

export function applyTerminalSessionClose({
  queryClient,
  session,
  terminalId,
}: CloseTerminalSessionCacheArgs): void {
  for (const scope of terminalScopesForSession(session)) {
    queryClient.setQueryData<TerminalListResponse>(
      terminalsQueryKey(scope),
      (current) =>
        session.status === "exited"
          ? removeTerminalSession(current, terminalId)
          : upsertTerminalSession(current, session),
    );
  }
  queryClient.invalidateQueries({
    queryKey: allTerminalsQueryKeyPrefix(),
  });
  refreshNativeTerminalThread(queryClient, session);
}

interface NativeTerminalThreadCacheArgs {
  queryClient: QueryClient;
  view: NativeTerminalThread;
}

export async function applyNativeTerminalModeSwitch({
  queryClient,
  threadId,
  view,
}: {
  queryClient: QueryClient;
  threadId: string;
  view: NativeTerminalThread | null;
}): Promise<void> {
  await queryClient.cancelQueries({
    queryKey: nativeTerminalThreadQueryKey(threadId),
    exact: true,
  });
  if (view === null) {
    queryClient.setQueryData<NativeTerminalThread | null>(
      nativeTerminalThreadQueryKey(threadId),
      null,
    );
    return;
  }
  applyNativeTerminalThreadView({ queryClient, view });
}

export function applyNativeTerminalThreadView({
  queryClient,
  view,
}: NativeTerminalThreadCacheArgs): void {
  queryClient.setQueryData<NativeTerminalThread | null>(
    nativeTerminalThreadQueryKey(view.threadId),
    view,
  );
  if (view.terminal !== null) {
    upsertTerminalSessionCaches({ queryClient, session: view.terminal });
  }
}
