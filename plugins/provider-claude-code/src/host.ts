import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { completeClaudeInference } from "./ai/claude-complete.js";
import { claudeAiStatusFromHealth } from "./ai/claude-status.js";
import { claudeAiHostContract } from "./ai/host-contract.js";
import {
  claudeExecutable,
  getClaudeProviderHealth,
} from "./bridge/provider-maintenance.js";
import { resolveClaudeNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const claudeHostContract = defineRpcContract({
  ...claudeAiHostContract,
  ...experimental_nativeRootsHostContract,
});

export default experimental_defineHostEntry({
  contract: claudeHostContract,
  handlers: {
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
    "claude.ai.complete": async (input, context) =>
      completeClaudeInference(input, context.signal, {
        executable: await claudeExecutable(),
        env: process.env,
      }),
    "claude.ai.status": async () =>
      claudeAiStatusFromHealth(await getClaudeProviderHealth()),
  },
});
