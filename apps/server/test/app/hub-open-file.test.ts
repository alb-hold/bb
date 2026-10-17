import { describe, expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

describe("NotificationHub.notifyThreadOpen", () => {
  it("routes device handoffs to the thread viewer and falls back to all clients", () => {
    const hub = new NotificationHub();
    const viewing = createMockHubSocket();
    const other = createMockHubSocket();
    hub.subscribe(viewing, { kind: "thread-detail", threadId: "thr_1" });
    hub.subscribe(other, { kind: "thread-detail", threadId: "thr_2" });
    const request = {
      kind: "copy-text" as const,
      text: "copy me",
      origin: { threadId: "thr_1" },
    };

    expect(hub.notifyDeviceHandoff(request, "Thread one")).toBe(1);
    expect(viewing.messages).toHaveLength(1);
    expect(other.messages).toHaveLength(0);

    const unscoped = new NotificationHub();
    const first = createMockHubSocket();
    const second = createMockHubSocket();
    unscoped.registerClient(first);
    unscoped.registerClient(second);
    expect(unscoped.notifyDeviceHandoff(request, "Thread one")).toBe(2);
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
  });

  it("replays recent handoffs to newly connected authenticated clients", () => {
    const hub = new NotificationHub();
    const sender = createMockHubSocket();
    hub.registerClient(sender);
    hub.notifyDeviceHandoff(
      {
        kind: "copy-text",
        text: "copy me",
        origin: { threadId: "thr_1" },
      },
      "Thread one",
    );
    const connectedLater = createMockHubSocket();
    hub.registerClient(connectedLater);

    expect(connectedLater.messages).toHaveLength(1);
    expect(JSON.parse(connectedLater.messages[0]!)).toMatchObject({
      type: "device-handoff",
      originLabel: "Thread one",
      request: { text: "copy me" },
    });
  });

  it("broadcasts to every connected client and returns the delivered count", () => {
    const hub = new NotificationHub();
    const viewing = createMockHubSocket();
    const other = createMockHubSocket();
    hub.subscribe(viewing, { kind: "thread-detail", threadId: "thr_1" });
    hub.subscribe(other, { kind: "thread-detail", threadId: "thr_2" });

    const delivered = hub.notifyThreadOpen(
      { projectId: "proj_1", threadId: "thr_1" },
      {
        split: "right",
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: 42,
        },
      },
    );

    expect(delivered).toBe(2);
    for (const socket of [viewing, other]) {
      expect(socket.messages).toHaveLength(1);
      expect(JSON.parse(socket.messages[0])).toEqual({
        type: "thread-open",
        projectId: "proj_1",
        threadId: "thr_1",
        split: "right",
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: 42,
        },
      });
    }
  });

  it("broadcasts typed thread-pane actions to every connected client", () => {
    const hub = new NotificationHub();
    const first = createMockHubSocket();
    const second = createMockHubSocket();
    hub.registerClient(first);
    hub.registerClient(second);

    expect(
      hub.notifyThreadPaneAction(
        { projectId: "proj_1", threadId: "thr_1" },
        "clear-spotlight",
      ),
    ).toBe(2);
    for (const socket of [first, second]) {
      expect(JSON.parse(socket.messages[0]!)).toEqual({
        type: "thread-pane-action",
        projectId: "proj_1",
        threadId: "thr_1",
        action: "clear-spotlight",
      });
    }
  });
});
