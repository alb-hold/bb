import {
  createTerminalSession,
  listPendingTerminalDaemonCloses,
  queueTerminalDaemonClose,
  updateTerminalSession,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { seedHostSession, seedSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

interface SentDaemonMessage {
  reason?: string;
  terminalId?: string;
  type: string;
}

function terminalCloseMessages(
  send: { mock: { calls: unknown[][] } },
  sessionId: string,
): SentDaemonMessage[] {
  return send.mock.calls
    .filter(
      (call) =>
        call[0] === sessionId &&
        (call[1] as SentDaemonMessage).type === "terminal.close",
    )
    .map((call) => call[1] as SentDaemonMessage);
}

describe("closing a terminal while its daemon session is disconnected", () => {
  it("tells the daemon to close it when the daemon reconnects, does not repeat it on a later reconnect, and leaves a reattaching terminal alone", async () => {
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
        payload: { mode: "force", reason: "user" },
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
          (message: SentDaemonMessage) => message.terminalId === kept.id,
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
        payload: { mode: "force", reason: "user" },
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
        payload: { mode: "force", reason: "user" },
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

  it("replays a close harmlessly when the server stops after the send and before the entry is removed", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-close-replay-window",
      });
      const send = vi.spyOn(harness.hub, "sendDaemonSessionMessage");
      send.mockReturnValue(true);
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const clientMessages = vi.spyOn(harness.hub, "sendTerminalClientMessage");
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        daemonSessionId: session.id,
        environmentId: null,
        hostId: host.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: null,
        title: "replay window",
      });
      updateTerminalSession(harness.db, {
        scope: { kind: "terminal", terminalId: terminal.id },
        update: { kind: "holder-backed" },
      });
      harness.deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: session.id,
      });
      await harness.deps.terminalSessions.closeTerminal({
        terminalId: terminal.id,
        payload: { mode: "force", reason: "user" },
      });
      const exitedRow = () =>
        harness.deps.db.$client
          .prepare(
            "SELECT status, close_reason AS closeReason, updated_at AS updatedAt, daemon_session_id AS daemonSessionId FROM terminal_sessions WHERE id = ?",
          )
          .get(terminal.id);
      const settled = exitedRow();

      harness.db.$client.exec(
        `CREATE TRIGGER crash_on_dequeue
          BEFORE DELETE ON fork_terminal_pending_daemon_closes
          BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
      );
      send.mockClear();
      const first = seedSession(harness.deps, host.id);
      send.mockReturnValue(true);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: first.id,
        hostId: host.id,
      });
      expect(terminalCloseMessages(send, first.id)).toHaveLength(1);
      expect(
        listPendingTerminalDaemonCloses(harness.db, host.id).map(
          (pending) => pending.terminalSessionId,
        ),
      ).toEqual([terminal.id]);
      harness.db.$client.exec("DROP TRIGGER crash_on_dequeue");

      send.mockClear();
      const second = seedSession(harness.deps, host.id);
      send.mockReturnValue(true);
      await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
        daemonSessionId: second.id,
        hostId: host.id,
      });
      expect(terminalCloseMessages(send, second.id)).toHaveLength(1);
      expect(listPendingTerminalDaemonCloses(harness.db, host.id)).toEqual([]);

      warn.mockClear();
      clientMessages.mockClear();
      await harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        message: {
          type: "terminal.exited",
          terminalId: terminal.id,
          exitCode: null,
          closeReason: "user",
        },
        sessionId: second.id,
      });
      expect(exitedRow()).toEqual(settled);
      expect(warn).not.toHaveBeenCalled();
      expect(clientMessages).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "the exit is written",
      trigger: `CREATE TRIGGER crash_on_exit BEFORE UPDATE ON terminal_sessions
        WHEN NEW.status = 'exited'
        BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
    },
    {
      name: "the daemon close is queued",
      trigger: `CREATE TRIGGER crash_on_queue
        BEFORE INSERT ON fork_terminal_pending_daemon_closes
        BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
    },
  ])(
    "leaves a consistent state when the server stops before $name: the terminal is closed on reconnect or reattached",
    async ({ trigger }) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-close-crash-window",
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
          title: "crash window",
        });
        updateTerminalSession(harness.db, {
          scope: { kind: "terminal", terminalId: terminal.id },
          update: { kind: "holder-backed" },
        });
        harness.deps.terminalSessions.handleDaemonSessionClosed({
          sessionId: session.id,
        });

        harness.db.$client.exec(trigger);
        await expect(
          harness.deps.terminalSessions.closeTerminal({
            terminalId: terminal.id,
            payload: { mode: "force", reason: "user" },
          }),
        ).rejects.toThrow("simulated crash");
        harness.db.$client.exec(
          "DROP TRIGGER IF EXISTS crash_on_exit; DROP TRIGGER IF EXISTS crash_on_queue;",
        );
        send.mockClear();

        const next = seedSession(harness.deps, host.id);
        send.mockReturnValue(true);
        await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
          daemonSessionId: next.id,
          hostId: host.id,
        });

        const row = harness.deps.db.$client
          .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
          .get(terminal.id) as { status: string };
        const closes = terminalCloseMessages(send, next.id);
        if (row.status === "exited") {
          expect(closes).toHaveLength(1);
        } else {
          expect(row.status).toBe("running");
          expect(closes).toHaveLength(0);
        }
      });
    },
  );
});
