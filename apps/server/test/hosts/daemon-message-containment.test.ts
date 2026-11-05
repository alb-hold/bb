import { closeSession } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  authorizeDaemonArrival,
  onDaemonSocketMessage,
} from "../../src/ws/daemon-protocol.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function createTestDaemonSocket() {
  return {
    close: vi.fn(),
    send: vi.fn(),
  };
}

const RESTARTING = JSON.stringify({ type: "daemon.restarting" });
const HEARTBEAT = JSON.stringify({ type: "heartbeat" });

describe("daemon socket message containment", () => {
  it("keeps the socket open when a handler throws, logs the message type, and handles the next message", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-handler-throws",
      });
      const socket = createTestDaemonSocket();
      const warn = vi.spyOn(harness.deps.logger, "warn");
      vi.spyOn(harness.hub, "markHostRestarting").mockImplementationOnce(() => {
        throw new Error("handler failure");
      });

      await onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        raw: RESTARTING,
        sessionId: session.id,
        socket,
      });
      await onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        raw: HEARTBEAT,
        sessionId: session.id,
        socket,
      });

      expect(socket.close).not.toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "heartbeat-ack" }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: "daemon.restarting",
          sessionId: session.id,
        }),
        expect.stringContaining("keeping the socket open"),
      );
    });
  });

  it("contains a handler error that is an ApiError 403 unrelated to the session", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-handler-403",
      });
      const socket = createTestDaemonSocket();
      vi.spyOn(harness.hub, "markHostRestarting").mockImplementationOnce(() => {
        throw new ApiError(403, "forbidden", "not for this terminal");
      });

      await onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        raw: RESTARTING,
        sessionId: session.id,
        socket,
      });

      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  it("keeps the socket open for a frame that is not valid JSON or fails its schema, and handles the next frame", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-bad-frames",
      });
      const socket = createTestDaemonSocket();
      const warn = vi.spyOn(harness.deps.logger, "warn");

      for (const raw of [
        "{not json",
        JSON.stringify({
          type: "environment-change",
          environmentId: "env-1",
          change: "status-changed",
        }),
      ]) {
        await onDaemonSocketMessage(harness.deps, {
          hostId: host.id,
          raw,
          sessionId: session.id,
          socket,
        });
      }
      await onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        raw: HEARTBEAT,
        sessionId: session.id,
        socket,
      });

      expect(socket.close).not.toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: "environment-change",
          reason: "invalid-schema",
        }),
        expect.stringContaining("dropping the message"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: null, reason: "invalid-json" }),
        expect.stringContaining("dropping the message"),
      );
    });
  });

  it("does not log the dropped payload", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-no-payload-log",
      });
      const socket = createTestDaemonSocket();
      const warn = vi.spyOn(harness.deps.logger, "warn");

      await onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        raw: JSON.stringify({
          type: "environment-change",
          environmentId: "secret-environment-value",
          change: "status-changed",
        }),
        sessionId: session.id,
        socket,
      });

      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "secret-environment-value",
      );
    });
  });

  it("limits repeated handler-failure logs for one session and message type", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-log-throttle",
      });
      const socket = createTestDaemonSocket();
      const warn = vi.spyOn(harness.deps.logger, "warn");
      vi.spyOn(harness.hub, "markHostRestarting").mockImplementation(() => {
        throw new Error("handler failure");
      });

      for (let index = 0; index < 50; index += 1) {
        await onDaemonSocketMessage(harness.deps, {
          hostId: host.id,
          raw: RESTARTING,
          sessionId: session.id,
          socket,
        });
      }

      const failureLogs = warn.mock.calls.filter(
        ([, message]) =>
          typeof message === "string" &&
          message.includes("keeping the socket open"),
      );
      expect(failureLogs.length).toBeGreaterThanOrEqual(1);
      expect(failureLogs.length).toBeLessThan(5);
      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  it("logs one warning when the arrival check keeps failing outside the session lookup, and still handles a later valid message", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-arrival-throttle",
      });
      const socket = createTestDaemonSocket();
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const failingDeps = {
        config: harness.deps.config,
        db: new Proxy(
          {},
          {
            get() {
              throw new Error("database is busy");
            },
          },
        ) as never,
        logger: harness.deps.logger,
      };
      const arrival = {
        hostId: host.id,
        messageType: "heartbeat" as const,
        sessionId: session.id,
        socket,
      };

      for (let index = 0; index < 50; index += 1) {
        expect(authorizeDaemonArrival(failingDeps, arrival)).toBe(false);
      }

      const arrivalLogs = warn.mock.calls.filter(
        ([, message]) =>
          typeof message === "string" &&
          message.includes("authorization failed"),
      );
      expect(arrivalLogs).toHaveLength(1);
      expect(arrivalLogs[0]?.[0]).toMatchObject({
        messageType: "heartbeat",
        sessionId: session.id,
      });
      expect(socket.close).not.toHaveBeenCalled();
      expect(authorizeDaemonArrival(harness.deps, arrival)).toBe(true);
    });
  });

  it("closes the socket when the session is no longer the daemon's active session", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-containment-inactive-session",
      });
      const socket = createTestDaemonSocket();
      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      await onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        raw: HEARTBEAT,
        sessionId: session.id,
        socket,
      });

      expect(socket.close).toHaveBeenCalledWith(1008, "inactive-session");
    });
  });

  it("closes the socket when the session belongs to another host", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps, {
        id: "host-containment-owner",
      });
      const { host: otherHost } = seedHostSession(harness.deps, {
        id: "host-containment-other",
      });
      const socket = createTestDaemonSocket();

      await onDaemonSocketMessage(harness.deps, {
        acceptedAtArrival: true,
        hostId: otherHost.id,
        raw: HEARTBEAT,
        sessionId: session.id,
        socket,
      });

      expect(socket.close).toHaveBeenCalledWith(1008, "unauthorized-session");
    });
  });
});
