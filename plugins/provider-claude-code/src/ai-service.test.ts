import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerClaudeAiService } from "./ai-service.js";
import type { ClaudeAiStatus, ClaudeAiTextResult } from "./ai/host-contract.js";

function setup(
  answer: (
    call: ExperimentalFakeHostRpcCall,
  ) => ClaudeAiTextResult | ClaudeAiStatus,
  primaryHostId: string | null = "host-1",
) {
  const { bb, harness } = createFakePluginHost({
    sdk: { system: { config: async () => ({ primaryHostId }) } },
    experimental_callHostRpc: answer,
  });
  registerClaudeAiService(bb);
  const [service] = harness.registrations.aiServiceRegistrations;
  if (service?.complete === undefined || service.status === undefined) {
    throw new Error("Claude did not register a complete service");
  }
  return {
    service,
    complete: service.complete,
    status: service.status,
    calls: harness.inspection.experimental_hostRpcCalls,
  };
}

function modelOf(call: ExperimentalFakeHostRpcCall): unknown {
  return (call.input as { model?: unknown }).model;
}

describe("Claude AI service", () => {
  it("serves text tasks only, so voice stays with a transcriber", () => {
    const claude = setup(() => ({ ok: true, text: "unused" }));
    expect(claude.service.id).toBe("claude");
    expect(claude.service.transcribe).toBeUndefined();
  });

  it("retries with Sonnet after a rate limit", async () => {
    const claude = setup((call) =>
      modelOf(call) === "claude-haiku-5-5"
        ? { ok: false, code: "rate_limited", message: "Slow down" }
        : { ok: true, text: "The user is ready." },
    );
    await expect(
      claude.complete("Fix it", { signal: new AbortController().signal }),
    ).resolves.toBe("The user is ready.");
    expect(claude.calls.map(modelOf)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(claude.calls[0]).toMatchObject({
      hostId: "host-1",
      method: "claude.ai.complete",
    });
  });

  it("does not retry a sign-in failure and surfaces its message", async () => {
    const claude = setup(() => ({
      ok: false,
      code: "auth_required",
      message: "Run `claude auth login` on the primary machine",
    }));
    await expect(
      claude.complete("Fix it", { signal: new AbortController().signal }),
    ).rejects.toThrow("Run `claude auth login` on the primary machine");
    expect(claude.calls).toHaveLength(1);
  });

  it("reports not ready without a primary machine", async () => {
    const claude = setup(() => ({ ready: true }), null);
    await expect(claude.status()).resolves.toEqual({
      ready: false,
      message: "No primary machine is connected",
    });
    expect(claude.calls).toHaveLength(0);
  });

  it("asks the primary machine for its sign-in status", async () => {
    const claude = setup(() => ({ ready: true }));
    await expect(claude.status()).resolves.toEqual({ ready: true });
    expect(claude.calls[0]).toMatchObject({
      hostId: "host-1",
      method: "claude.ai.status",
    });
  });
});
