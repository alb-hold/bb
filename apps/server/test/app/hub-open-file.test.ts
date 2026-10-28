import { describe, expect, it, vi } from "vitest";
import { ChildTerminalSocket } from "../../src/services/terminals/data-plane/child-terminal-socket.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

describe("NotificationHub device handoff routing", () => {
  it("delivers bursts only to clients viewing the origin thread", () => {
    const hub = new NotificationHub();
    const viewing = createMockHubSocket();
    const other = createMockHubSocket();
    const deviceToken = hub.issueDeviceHandoffClientToken(viewing);
    viewing.messages.length = 0;
    expect(
      hub.recordDeviceHandoffTurnSubmitter(
        deviceToken,
        "thr_1",
        "turn-request-1",
      ),
    ).toBe(true);
    hub.subscribe(viewing, { kind: "thread-detail", threadId: "thr_1" });
    hub.subscribe(other, { kind: "thread-detail", threadId: "thr_2" });
    hub.setDeviceHandoffView(viewing, "thr_1");
    hub.setDeviceHandoffView(other, "thr_2");

    expect(
      hub.notifyDeviceHandoff(
        { kind: "copy-text", text: "first", origin: { threadId: "thr_1" } },
        "Thread one",
      ),
    ).toBe(1);
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "open-url",
          url: "https://example.com/2",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      ),
    ).toBe(1);
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "open-url",
          url: "https://example.com/3",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      ),
    ).toBe(1);
    const handoffs = viewing.messages.map((message) => JSON.parse(message));
    expect(handoffs).toHaveLength(3);
    expect(
      handoffs.map((handoff) => [handoff.type, handoff.request.kind]),
    ).toEqual([
      ["device-handoff", "copy-text"],
      ["device-handoff", "open-url"],
      ["device-handoff", "open-url"],
    ]);
    expect(other.messages).toHaveLength(0);
  });

  it("fails closed for a thread-only handoff without a prior submitter", () => {
    const hub = new NotificationHub();
    const unrelatedCurrent = createMockHubSocket();
    const forgedViewer = createMockHubSocket();
    hub.subscribe(unrelatedCurrent, {
      kind: "thread-detail",
      threadId: "thr_elsewhere",
    });
    hub.subscribe(forgedViewer, { kind: "thread-detail", threadId: "thr_1" });
    hub.setDeviceHandoffView(forgedViewer, "thr_1");

    expect(() =>
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "first secret",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      ),
    ).toThrow("No device has sent a message in this thread yet");
    expect(unrelatedCurrent.messages).toHaveLength(0);
    expect(forgedViewer.messages).toHaveLength(0);
  });

  it("delivers terminal-scoped handoffs to the app view, not its terminal data socket", () => {
    const hub = new NotificationHub();
    const sink = {
      broadcast: vi.fn(),
      close: vi.fn(),
      relayOutput: vi.fn(),
      reply: vi.fn(),
      replay: vi.fn(),
    };
    const terminalDataSocket = new ChildTerminalSocket(
      "attach_1",
      "term_1",
      sink,
      false,
      false,
      false,
    );
    const appViewer = createMockHubSocket();
    const token = hub.issueDeviceHandoffClientToken(appViewer);
    hub.registerTerminalClient("term_1", terminalDataSocket);
    expect(
      hub.linkDeviceHandoffTerminalAttachment(
        token,
        "term_1",
        terminalDataSocket,
      ),
    ).toBe(true);
    hub.recordTerminalClientVisibility(
      "term_1",
      terminalDataSocket,
      true,
      Date.now(),
    );
    hub.setDeviceHandoffView(appViewer, null, "term_1");

    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "terminal copy",
          origin: { terminalSessionId: "term_1" },
        },
        "Terminal one",
      ),
    ).toBe(1);
    const handoff = appViewer.messages
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "device-handoff");
    expect(handoff.request).toMatchObject({
      text: "terminal copy",
    });
    expect(terminalDataSocket.isClosed).toBe(false);
  });

  it("does not link a terminal attachment to an unissued client token", () => {
    const hub = new NotificationHub();
    const owner = createMockHubSocket();
    const forged = createMockHubSocket();
    const ownerToken = hub.issueDeviceHandoffClientToken(owner);
    hub.issueDeviceHandoffClientToken(forged);
    const terminalSocket = createMockHubSocket();
    hub.registerTerminalClient("term_1", terminalSocket);

    expect(
      hub.linkDeviceHandoffTerminalAttachment(
        "x".repeat(22),
        "term_1",
        terminalSocket,
      ),
    ).toBe(false);
    hub.setDeviceHandoffView(owner, null, "term_1");
    hub.setDeviceHandoffView(forged, null, "term_1");
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "token-bound",
          origin: { terminalSessionId: "term_1" },
        },
        "Terminal one",
      ),
    ).toBe(0);

    expect(
      hub.linkDeviceHandoffTerminalAttachment(
        ownerToken,
        "term_1",
        terminalSocket,
      ),
    ).toBe(true);
    hub.recordTerminalClientVisibility(
      "term_1",
      terminalSocket,
      true,
      Date.now(),
    );
    expect(
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "token-bound",
          origin: { terminalSessionId: "term_1" },
        },
        "Terminal one",
      ),
    ).toBe(1);
    expect(
      owner.messages
        .map((message) => JSON.parse(message))
        .some((message) => message.type === "device-handoff"),
    ).toBe(true);
    expect(
      forged.messages
        .map((message) => JSON.parse(message))
        .some((message) => message.type === "device-handoff"),
    ).toBe(false);
  });

  it("routes a thread-only expiry only to its bound device", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const hub = new NotificationHub();
      const laterAtOrigin = createMockHubSocket();
      const token = hub.issueDeviceHandoffClientToken(laterAtOrigin);
      laterAtOrigin.messages.length = 0;
      expect(
        hub.recordDeviceHandoffTurnSubmitter(token, "thr_1", "turn-1"),
      ).toBe(true);
      hub.subscribe(laterAtOrigin, {
        kind: "thread-detail",
        threadId: "thr_1",
      });
      hub.setDeviceHandoffView(laterAtOrigin, "thr_1");
      hub.setDeviceHandoffView(laterAtOrigin, null);
      hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "expired copy",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      );
      vi.advanceTimersByTime(10 * 60 * 1000);
      hub.setDeviceHandoffView(laterAtOrigin, "thr_1");
      expect(
        laterAtOrigin.messages.map((message) => JSON.parse(message)),
      ).toMatchObject([{ type: "device-handoff-expired", threadId: "thr_1" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending handoff available to its bound device for the ten-minute sign-in window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const hub = new NotificationHub();
      const laterAtOrigin = createMockHubSocket();
      const token = hub.issueDeviceHandoffClientToken(laterAtOrigin);
      laterAtOrigin.messages.length = 0;
      expect(
        hub.recordDeviceHandoffTurnSubmitter(token, "thr_1", "turn-1"),
      ).toBe(true);
      hub.notifyDeviceHandoff(
        {
          kind: "open-url",
          url: "https://login.example.com/device",
          origin: { threadId: "thr_1" },
        },
        "Thread one",
      );
      vi.advanceTimersByTime(3 * 60 * 1000);
      hub.subscribe(laterAtOrigin, {
        kind: "thread-detail",
        threadId: "thr_1",
      });
      hub.setDeviceHandoffView(laterAtOrigin, "thr_1");

      expect(
        laterAtOrigin.messages.map((message) => JSON.parse(message)),
      ).toHaveLength(1);
      expect(JSON.parse(laterAtOrigin.messages[0]!)).toMatchObject({
        type: "device-handoff",
        request: { kind: "open-url", url: "https://login.example.com/device" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("broadcasts to every connected client and returns the delivered count", () => {
    const hub = new NotificationHub();
    const viewing = createMockHubSocket();
    const other = createMockHubSocket();
    hub.registerClient(viewing, true);
    hub.registerClient(other, true);
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
