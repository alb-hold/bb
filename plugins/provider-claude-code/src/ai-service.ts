import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import {
  claudeAiHostContract,
  type ClaudeAiFailureCode,
  type ClaudeAiTextResult,
} from "./ai/host-contract.js";

export const CLAUDE_TEXT_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
] as const;
const COMPLETE_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 5_000;
const HOST_CALL_GRACE_MS = 1_000;
const RETRY_WITH_NEXT_MODEL: ReadonlySet<ClaudeAiFailureCode> = new Set([
  "rate_limited",
  "service_unavailable",
  "invalid_response",
]);

export function registerClaudeAiService(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: claudeAiHostContract });

  async function primaryHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  bb.experimental_aiServices.register({
    id: "claude",
    displayName: "Claude",
    async complete(prompt, { signal }) {
      const hostId = await primaryHostId();
      if (hostId === null) throw new Error("No primary machine is connected");
      let last: ClaudeAiTextResult | null = null;
      for (const model of CLAUDE_TEXT_MODELS) {
        last = await host.call(
          "claude.ai.complete",
          { model, prompt, timeoutMs: COMPLETE_TIMEOUT_MS },
          {
            hostId,
            signal,
            timeoutMs: COMPLETE_TIMEOUT_MS + HOST_CALL_GRACE_MS,
          },
        );
        if (last.ok || !RETRY_WITH_NEXT_MODEL.has(last.code)) break;
        if (signal.aborted) break;
      }
      if (last === null) throw new Error("Claude did not answer");
      if (last.ok) return last.text;
      throw new Error(last.message);
    },
    async status(): Promise<PluginAiServiceStatus> {
      const hostId = await primaryHostId();
      if (hostId === null) {
        return { ready: false, message: "No primary machine is connected" };
      }
      return host.call(
        "claude.ai.status",
        {},
        { hostId, timeoutMs: STATUS_TIMEOUT_MS },
      );
    },
  });
}
