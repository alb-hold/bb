import { describe, expect, it } from "vitest";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

const requestId = "creq_abcdefghjk";

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
});
