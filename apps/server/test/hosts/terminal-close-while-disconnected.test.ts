import {
  createTerminalSession,
  listPendingTerminalDaemonCloses,
  queueTerminalDaemonClose,
  updateTerminalSession,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { seedHostSession, seedSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function terminalCloseMessages(
  send: ReturnType<typeof vi.spyOn>,
  sessionId: string,
) {
  return send.mock.calls
    .filter(
      ([target, message]) =>
        target === sessionId &&
        (message as { type?: string }).type === "terminal.close",
    )
    .map(([, message]) => message as { terminalId: string; reason: string });
}

describe("closing a terminal while its daemon session is disconnected", () => {
  it("tells the daemon to close it once the daemon reconnects, exactly once, and leaves a reattaching terminal alone", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-close-while-disconnected",
      });
      const send = vi.spyOn(harness.hub, "sendDaemonSessionMessage");
      send.mockReturnValue(true);
      const open = (title: string) => {
        const terminal = createTerminalSession(harness.db, {
          cols: 80,
          daemonSessionId: session.id,
          environmentId: null,
          hostId: host.id,
          initialCwd: "/tmp",
          rows: 24,
          status: "running",
          threadId: null,
          title,
        });
        updateTerminalSession(harness.db, {
          scope: { kind: "terminal", terminalId: terminal.id },
          update: { kind: "holder-backed" },
        });
        return terminal;
      };
      const closed = open("closed while disconnected");
      const kept = open("still running");

      harness.deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: session.id,
      });
      await harness.deps.terminalSessions.closeTerminal({
        terminalId: closed.id,
        payload: { mode: "always", reason: "user" },
      });
      send.mockClear();

      const next = seedSession(harness.deps, host.id);
      send.mockReturnValue(true);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: next.id,
        hostId: host.id,
      });

      expect(terminalCloseMessages(send, next.id)).toEqual([
        { type: "terminal.close", terminalId: closed.id, reason: "user" },
      ]);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: next.id,
        hostId: host.id,
      });
      expect(terminalCloseMessages(send, next.id)).toHaveLength(1);
      expect(
        terminalCloseMessages(send, next.id).some(
          (message) => message.terminalId === kept.id,
        ),
      ).toBe(false);
    });
  });

  it("delivers the close for a terminal that was already marked exited by the disconnect and is then closed by the user", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-close-after-disconnect-exit",
      });
      const send = vi.spyOn(harness.hub, "sendDaemonSessionMessage");
      send.mockReturnValue(true);
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        daemonSessionId: session.id,
        environmentId: null,
        hostId: host.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: null,
        title: "exited by disconnect",
      });
      updateTerminalSession(harness.db, {
        scope: { kind: "terminal", terminalId: terminal.id },
        update: {
          closeReason: "daemon-disconnect",
          exitCode: null,
          kind: "exit",
        },
      });
      await harness.deps.terminalSessions.closeTerminal({
        terminalId: terminal.id,
        payload: { mode: "always", reason: "user" },
      });
      send.mockClear();

      const next = seedSession(harness.deps, host.id);
      send.mockReturnValue(true);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: next.id,
        hostId: host.id,
      });

      expect(terminalCloseMessages(send, next.id)).toEqual([
        { type: "terminal.close", terminalId: terminal.id, reason: "user" },
      ]);
    });
  });

  it("keeps the close queued while the daemon cannot be reached, and never closes a terminal the database shows as running", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-close-queue-guard",
      });
      const send = vi.spyOn(harness.hub, "sendDaemonSessionMessage");
      const open = (title: string) =>
        createTerminalSession(harness.db, {
          cols: 80,
          daemonSessionId: session.id,
          environmentId: null,
          hostId: host.id,
          initialCwd: "/tmp",
          rows: 24,
          status: "running",
          threadId: null,
          title,
        });
      const closed = open("closed");
      const running = open("running");
      harness.deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: session.id,
      });
      send.mockReturnValue(true);
      await harness.deps.terminalSessions.closeTerminal({
        terminalId: closed.id,
        payload: { mode: "always", reason: "user" },
      });
      queueTerminalDaemonClose(harness.db, {
        hostId: host.id,
        now: Date.now(),
        terminalSessionId: running.id,
      });
      send.mockClear();

      const next = seedSession(harness.deps, host.id);
      send.mockReturnValue(false);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: next.id,
        hostId: host.id,
      });
      expect(
        listPendingTerminalDaemonCloses(harness.db, host.id).map(
          (pending) => pending.terminalSessionId,
        ),
      ).toContain(closed.id);

      send.mockClear();
      send.mockReturnValue(true);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: next.id,
        hostId: host.id,
      });
      expect(terminalCloseMessages(send, next.id)).toEqual([
        { type: "terminal.close", terminalId: closed.id, reason: "user" },
      ]);
      expect(listPendingTerminalDaemonCloses(harness.db, host.id)).toEqual([]);
    });
  });
});
