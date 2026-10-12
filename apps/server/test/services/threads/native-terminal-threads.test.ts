import { describe, expect, it, vi } from "vitest";
import {
  archiveThread,
  createEnvironment,
  createNativeTerminalThread,
  createProject,
  createTerminalSession,
  createThread,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  noopNotifier,
  setNativeTerminalThreadTerminal,
  terminalSessions,
  upsertHost,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { createProviderRegistryService } from "../../../src/services/providers/provider-registry.js";
import {
  reopenNativeTerminalsAfterDaemonReconnect,
  takeNativeTerminalLaunchSpec,
} from "../../../src/services/threads/native-terminal-threads.js";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

async function createDisconnectedNativeThread(
  harness: TestAppHarness,
  index: number,
  hostId: string,
): Promise<{ threadId: string; terminalId: string }> {
  const { project } = createProject(harness.db, noopNotifier, {
    name: `Native Terminal Project ${index}`,
    source: {
      type: "local_path",
      hostId,
      path: `/tmp/native-terminal-${index}`,
    },
  });
  const environment = createEnvironment(harness.db, noopNotifier, {
    providerOwnsPath: false,
    hostId,
    projectId: project.id,
    path: `/tmp/native-terminal-${index}/env`,
    status: "ready",
  });
  const thread = createThread(harness.db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  createNativeTerminalThread(harness.db, {
    threadId: thread.id,
    providerId: "codex",
    nativeSessionId: `session-existing-${index}`,
    initialPrompt: null,
    model: null,
  });
  const terminal = createTerminalSession(harness.db, {
    threadId: thread.id,
    environmentId: environment.id,
    hostId,
    daemonSessionId: null,
    title: "Codex",
    initialCwd: "/tmp",
    cols: 120,
    rows: 36,
    status: "disconnected",
  });
  setNativeTerminalThreadTerminal(harness.db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  return { threadId: thread.id, terminalId: terminal.id };
}

describe("reopenNativeTerminalsAfterDaemonReconnect", () => {
  it("reopens with the same CLI session when the provider registers after the settle timeout", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-reconnect",
        name: "Native Terminal Host",
      });
      const { threadId } = await createDisconnectedNativeThread(h, 1, host.id);
      expect(
        listNativeTerminalThreadsWithDisconnectedTerminal(h.db, host.id),
      ).toContain(threadId);
      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "daemon-disconnect" })
        .where(eq(terminalSessions.threadId, threadId))
        .run();
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService({
        deferRegistrationsSettled: true,
      });
      h.deps.providerRegistry = providerRegistry;
      const warn = vi.spyOn(h.deps.logger, "warn");
      const createTerminal = vi
        .spyOn(h.deps.terminalSessions, "createTerminal")
        .mockImplementation(async () => {
          const terminal = createTerminalSession(h.db, {
            threadId,
            environmentId: null,
            hostId: host.id,
            daemonSessionId: null,
            title: "Codex",
            initialCwd: "/tmp",
            cols: 120,
            rows: 36,
            status: "running",
          });
          return terminal;
        });

      const reopening = reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
        hostId: host.id,
        threadIds: [threadId],
      });
      await new Promise((resolve) => setTimeout(resolve, 30_100));
      expect(createTerminal).not.toHaveBeenCalled();

      providerRegistry.register(registration);
      await reopening;

      expect(warn).not.toHaveBeenCalled();
      expect(createTerminal).toHaveBeenCalledOnce();
      expect(
        takeNativeTerminalLaunchSpec(h.deps, threadId).nativeSessionId,
      ).toBe("session-existing-1");
      const start = createTerminal.mock.calls[0]?.[0].payload.start;
      if (start?.mode !== "command") {
        throw new Error("Expected a command terminal launch");
      }
      expect(start.command).toContain("--reattach");
      expect(start.command).toContain("native-run");
    });
  }, 45_000);

  it("rejects a stale reconnect immediately before terminal creation", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-stale",
        name: "Native Terminal Host",
      });
      const { threadId } = await createDisconnectedNativeThread(h, 4, host.id);
      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "daemon-disconnect" })
        .where(eq(terminalSessions.threadId, threadId))
        .run();
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService();
      providerRegistry.register(registration);
      h.deps.providerRegistry = providerRegistry;
      let releaseProviderEnv!: (value: { entries: [] }) => void;
      let providerEnvStarted!: () => void;
      const providerEnvReady = new Promise<void>((resolve) => {
        providerEnvStarted = resolve;
      });
      const providerEnv = new Promise<{ entries: [] }>((resolve) => {
        releaseProviderEnv = resolve;
      });
      vi.spyOn(h.pluginService, "resolveProviderEnv").mockImplementation(
        async () => {
          providerEnvStarted();
          return providerEnv;
        },
      );
      const createTerminal = vi.spyOn(
        h.deps.terminalSessions,
        "createTerminal",
      );
      const warn = vi.spyOn(h.deps.logger, "warn");

      const reopening = reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
        hostId: host.id,
        threadIds: [threadId],
      });
      await providerEnvReady;
      archiveThread(h.db, noopNotifier, threadId);
      releaseProviderEnv({ entries: [] });
      await reopening;

      expect(createTerminal).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          err: expect.objectContaining({
            status: 409,
            body: expect.objectContaining({
              code: "native_terminal_reconnect_stale",
            }),
          }),
        }),
        "Failed to reopen native terminal after the host daemon reconnected",
      );
    });
  });

  it("does not reopen a terminal closed or archived while provider registration is pending", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (h) => {
      const host = upsertHost(h.db, noopNotifier, {
        id: "host-native-closed",
        name: "Native Terminal Host",
      });
      const closed = await createDisconnectedNativeThread(h, 2, host.id);
      const archived = await createDisconnectedNativeThread(h, 3, host.id);
      const sourceRegistry = await createTestProviderRegistry();
      const registration = sourceRegistry.get("codex");
      if (registration === null)
        throw new Error("Codex provider is not seeded");
      const providerRegistry = createProviderRegistryService({
        deferRegistrationsSettled: true,
      });
      h.deps.providerRegistry = providerRegistry;
      const createTerminal = vi.spyOn(
        h.deps.terminalSessions,
        "createTerminal",
      );
      const reconnectCandidates = [closed.threadId, archived.threadId];
      expect(
        listNativeTerminalThreadsWithDisconnectedTerminal(h.db, host.id),
      ).toEqual(reconnectCandidates);

      h.db
        .update(terminalSessions)
        .set({ status: "exited", closeReason: "daemon-disconnect" })
        .where(eq(terminalSessions.id, closed.terminalId))
        .run();
      await h.deps.terminalSessions.closeTerminal({
        terminalId: closed.terminalId,
        payload: { mode: "force", reason: "user" },
      });
      expect(
        h.db
          .select({ closeReason: terminalSessions.closeReason })
          .from(terminalSessions)
          .where(eq(terminalSessions.id, closed.terminalId))
          .get()?.closeReason,
      ).toBe("user");
      archiveThread(h.db, noopNotifier, archived.threadId);

      const reopening = reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
        hostId: host.id,
        threadIds: reconnectCandidates,
      });
      await Promise.resolve();
      providerRegistry.register(registration);
      await reopening;

      expect(createTerminal).not.toHaveBeenCalled();
    });
  });
});
