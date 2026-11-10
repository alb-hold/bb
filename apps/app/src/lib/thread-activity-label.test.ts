import { expect, it } from "vitest";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  getThreadActivityLabel,
  getThreadDetailActivityIndicator,
} from "./thread-activity-label";

it.each([
  ["idle", false, 0, 0, "Idle"],
  ["active", false, 0, 0, "Working"],
  ["starting", false, 0, 0, "Working"],
  ["stopping", false, 0, 0, "Working"],
  ["pending", false, 0, 1, "Thread has a message waiting to send"],
  ["active", true, 0, 1, "Needs input"],
  ["idle", false, 1, 0, "Working"],
] as const)(
  "labels detail activity from runtime %s, input=%s, agents=%s and queue=%s",
  (
    displayStatus,
    hasPendingInteraction,
    activeBackgroundAgentCount,
    queuedMessageCount,
    label,
  ) => {
    const thread = makeThreadResponse({
      runtime: { displayStatus },
      hasPendingInteraction,
      activeBackgroundAgentCount,
      queuedMessageCount,
    });
    expect(
      getThreadActivityLabel(getThreadDetailActivityIndicator(thread)),
    ).toBe(label);
  },
);
