import { describe, expect, it } from "vitest";
import {
  isTmpRootOwnerIdentityLive,
  isTmpRootOwnerProcess,
} from "../../helpers/tmp-owner.js";

describe("integration temp root owner process identity", () => {
  it("keeps an unknown or matching process identity and rejects a reused pid", () => {
    expect(isTmpRootOwnerProcess(null, 1_000, 1_000)).toBe(true);
    expect(isTmpRootOwnerProcess(1_500, 1_000, 1_000)).toBe(true);
    expect(isTmpRootOwnerProcess(2_001, 1_000, 1_000)).toBe(false);
  });
});

it("keeps an unreadable owner PID unless the process is confirmed gone", () => {
  expect(isTmpRootOwnerIdentityLive(null, 1_000, 1_000, true)).toBe(true);
  expect(isTmpRootOwnerIdentityLive(null, 1_000, 1_000, false)).toBe(false);
});
