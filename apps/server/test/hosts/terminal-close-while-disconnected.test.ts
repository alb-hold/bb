import { createTerminalSession, updateTerminalSession } from "@bb/db";
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
});
