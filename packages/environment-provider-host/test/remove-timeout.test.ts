import { expect, it } from "vitest";
import {
  REMOVE_DEADLINE_MS,
  REMOVE_TIMEOUT_MS,
  describeRemovalDuration,
  removalDeadlineReason,
} from "../src/remove-timeout.js";

it("states the removal deadline in whole minutes a minute before the command timeout", () => {
  expect(REMOVE_TIMEOUT_MS - REMOVE_DEADLINE_MS).toBe(60_000);
  expect(removalDeadlineReason(REMOVE_DEADLINE_MS)).toBe(
    "the removal did not finish within 14 minutes",
  );
});

it.each([
  [1_000, "1 second"],
  [20_000, "20 seconds"],
  [60_000, "1 minute"],
  [90_000, "90 seconds"],
  [400, "1 second"],
] as const)("describes %i ms as %s", (milliseconds, text) => {
  expect(describeRemovalDuration(milliseconds)).toBe(text);
});
