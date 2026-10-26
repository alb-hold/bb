import { expect, it } from "vitest";
import { hostSchema, syncScopeSchema, vaultPathSchema } from "./contract.js";

it("keeps docs host and vault boundaries in the client contract", () => {
  expect(
    hostSchema.safeParse({
      id: "host-1",
      name: "Host",
      status: "restarting",
      maxPermissionMode: "full",
      lastSeenAt: null,
      lastRejectedProtocolVersion: null,
      createdAt: 0,
      updatedAt: 0,
    }).success,
  ).toBe(true);
  expect(vaultPathSchema.safeParse("../outside").success).toBe(false);
  expect(syncScopeSchema.safeParse({ kind: "unknown" }).success).toBe(false);
});
