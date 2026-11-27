import { describe, expect, it } from "vitest";
import { formatThreadTimelineText } from "../src/format-timeline-text.js";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

const requestId = "creq_abcdefghjk";
const steerRequestId = "creq_mnpqrstuvw";

function userTurnRequests(
  events: Parameters<typeof renderTimelineFixture>[0]["events"],
) {
  const fixture = renderTimelineFixture({
    events,
    projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
  });
  return fixture.rows.flatMap((row) =>
    row.kind === "conversation" && row.role === "user" && row.turnRequest
      ? [row.turnRequest]
      : [],
  );
}

describe("undelivered user messages", () => {
  it("marks an accepted input as undelivered when its turn was interrupted with no provider item after it", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({ requestId, text: "hello" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual(["undelivered"]);
  });

  it("marks the input undelivered when the stop was recorded before the turn started", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({ requestId, text: "hello" }),
      event.systemThreadInterrupted(),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual(["undelivered"]);
  });

  it("tells the CLI text timeline that the message was not delivered", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const fixture = renderTimelineFixture({
      events: [
        event.clientTurnRequested({ requestId, text: "hello" }),
        event.turnStarted({ turnId: "turn-1" }),
        event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
        event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const text = formatThreadTimelineText(fixture.rows, { verbose: true });
    expect(text).toContain("not delivered");
  });

  it("keeps the input accepted when the provider produced an item after it", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({ requestId, text: "hello" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.commandStarted({
        command: "ls",
        itemId: "command-1",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual(["accepted"]);
  });

  it("keeps the input accepted when the turn completed normally", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({ requestId, text: "hello" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.turnCompleted({ turnId: "turn-1", status: "completed" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual(["accepted"]);
  });

  it("marks a steer undelivered when the earlier prompt kept producing items after it was accepted", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({ requestId, text: "first" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.providerUserMessage({
        clientRequestId: requestId,
        text: "first",
        turnId: "turn-1",
      }),
      event.clientTurnRequested({ requestId: steerRequestId, text: "second" }),
      event.inputAccepted({ clientRequestId: steerRequestId, turnId: "turn-1" }),
      event.commandStarted({
        command: "ls",
        itemId: "command-1",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual([
      "accepted",
      "undelivered",
    ]);
  });

  it("keeps a steer accepted when the provider reported consuming it before the stop", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({ requestId, text: "first" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.providerUserMessage({
        clientRequestId: requestId,
        text: "first",
        turnId: "turn-1",
      }),
      event.clientTurnRequested({ requestId: steerRequestId, text: "second" }),
      event.inputAccepted({ clientRequestId: steerRequestId, turnId: "turn-1" }),
      event.providerUserMessage({
        clientRequestId: steerRequestId,
        text: "second",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("keeps the local image restorable when a stop lands before the CLI consumed the message", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const fixture = renderTimelineFixture({
      events: [
        event.clientTurnRequested({
          requestId,
          text: "look at this",
          input: [
            { type: "text", text: "look at this", mentions: [] },
            { type: "localImage", path: "/tmp/shot.png" },
          ],
        }),
        event.turnStarted({ turnId: "turn-1" }),
        event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
        event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const userRows = fixture.rows.flatMap((row) =>
      row.kind === "conversation" && row.role === "user" ? [row] : [],
    );
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.turnRequest?.status).toBe("undelivered");
    expect(userRows[0]?.attachments?.localImagePaths).toEqual([
      "/tmp/shot.png",
    ]);
  });

  it("does not mark the same message undelivered once the CLI echoed it before the stop", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const requests = userTurnRequests([
      event.clientTurnRequested({
        requestId,
        text: "look at this",
        input: [
          { type: "text", text: "look at this", mentions: [] },
          { type: "localImage", path: "/tmp/shot.png" },
        ],
      }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestId: requestId, turnId: "turn-1" }),
      event.providerUserMessage({
        clientRequestId: requestId,
        text: "look at this",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);
    expect(requests.map((request) => request.status)).toEqual(["accepted"]);
  });
});
