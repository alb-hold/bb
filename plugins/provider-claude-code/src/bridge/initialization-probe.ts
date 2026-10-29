import {
  query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { translateMissingClaudeCliCatalogError } from "./missing-cli-error.js";
import { afterClaudeRenewalSettles } from "./claude-refresh-lock.js";
import { applyPinnedSettings } from "./pinned-settings.js";
import { resolveClaudeCodeExecutable } from "./session-options.js";

async function* promptWithoutMessages(
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function probeClaudeInitialization(args: {
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<SDKControlInitializeResponse> {
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({
    env: args.env,
  });
  const promptEnd = new AbortController();
  const pinned = applyPinnedSettings({
    cwd: args.cwd,
    env: args.env,
    persistSession: false,
    settingSources: ["user", "project", "local"],
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
  });
  let session: ReturnType<typeof query>;
  try {
    session = query({
      prompt: promptWithoutMessages(promptEnd.signal),
      options: pinned.options,
    });
  } catch (error) {
    promptEnd.abort();
    pinned.release();
    throw translateMissingClaudeCliCatalogError(error);
  }

  try {
    return await session.initializationResult();
  } catch (error) {
    throw translateMissingClaudeCliCatalogError(error);
  } finally {
    promptEnd.abort();
    await afterClaudeRenewalSettles(args.env);
    session.close();
    pinned.release();
  }
}
