import { describe, expect, it } from "vitest";
import { isTmpRootOwnerProcess } from "../../helpers/tmp-owner.js";

describe("integration temp root owner process identity", () => {
  it("keeps an unknown or matching process identity and rejects a reused pid", () => {
    expect(isTmpRootOwnerProcess(null, 1_000, 1_000)).toBe(true);
    expect(isTmpRootOwnerProcess(1_500, 1_000, 1_000)).toBe(true);
    expect(isTmpRootOwnerProcess(2_001, 1_000, 1_000)).toBe(false);
  });
});
