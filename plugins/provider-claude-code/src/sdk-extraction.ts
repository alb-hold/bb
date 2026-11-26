import {
  type ThreadEventContextWindowUsage,
  type ThreadEventTokenUsageBreakdown,
  toPositiveNumber,
  extractResultText,
  normalizeProviderCommandOutput,
  textBlockSchema,
  toNonNegativeNumber,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_SERVER_TOOL_RESULT_BLOCK_TYPES,
  claudeAssistantUsageMessageSchema,
  claudeModelUsageSchema,
  mcpToolUseBlockSchema,
  messageContentSchema,
  sdkUsageSchema,
  serverToolResultBlockSchema,
  serverToolUseBlockSchema,
  streamEventSchema,
  thinkingBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
  type ClaudeAssistantMessage,
  type ClaudeMessageContentBlock,
  type ClaudeResultMessage,
  type ClaudeSdkUsage,
  type ClaudeStreamEventMessage,
  type ClaudeToolUseResult,
  type ClaudeUserMessage,
} from "./schemas.js";

interface ClaudeContextWindowUsageArgs {
  fallbackModelContextWindow: number | null;
  latestRequestContextTokens: number | undefined;
  message: ClaudeResultMessage | SDKResultMessage;
}

interface ClaudeToolUseBlockData {
  id: string;
  input: unknown;
  name: string;
}

interface ClaudeToolResultBlockData {
  content: unknown;
  isError: boolean;
  toolName?: string;
  toolUseId: string;
  toolUseResult: ClaudeToolUseResult | null;
}

interface ParseClaudeMessageContentArgs {
  message: unknown;
}

interface ClaudeProcessOutputStreams {
  stderr: string;
  stdout: string;
}

interface ClaudeCommandExecutionOutputArgs {
  content: unknown;
  toolUseResult: ClaudeToolUseResult | null;
}

interface ClaudeCommandExitCodeArgs extends ClaudeCommandExecutionOutputArgs {
  isError: boolean;
}

const CLAUDE_EXIT_CODE_HEADER_PATTERN = /^(?:Error: )?Exit code ([1-9]\d*)$/;

const CLAUDE_EMPTY_BASH_OUTPUT_PLACEHOLDERS = [
  "(Bash completed with no output)",
] as const;
const LARGE_CLAUDE_CONTEXT_WINDOW = 1_000_000;
const LARGE_CLAUDE_CONTEXT_MODELS = new Set([
  "best",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-mythos-5-2",
  "fable",
]);

export function getNestedParentToolUseId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  if (!("parent_tool_use_id" in message)) {
    return undefined;
  }
  return typeof message.parent_tool_use_id === "string"
    ? message.parent_tool_use_id
    : undefined;
}

function parseMessageContent(
  message: ParseClaudeMessageContentArgs,
): ClaudeMessageContentBlock[] {
  const parsed = messageContentSchema.safeParse(message.message);
  return parsed.success ? (parsed.data.content ?? []) : [];
}

export function extractAssistantText(
  message: ClaudeAssistantMessage,
): string | undefined {
  const chunks: string[] = [];
  for (const block of parseMessageContent(message)) {
    const text = textBlockSchema.safeParse(block);
    if (text.success) chunks.push(text.data.text);
  }
  const joined = chunks.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

export interface ClaudeServerToolResultBlockData {
  blockType: (typeof CLAUDE_SERVER_TOOL_RESULT_BLOCK_TYPES)[number];
  isError: boolean;
  outputText: string | undefined;
  toolUseId: string;
}

export function extractToolUses(
  message: ClaudeAssistantMessage,
): ClaudeToolUseBlockData[] {
  const uses: ClaudeToolUseBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const tool = toolUseBlockSchema.safeParse(block);
    if (tool.success) {
      uses.push({
        id: tool.data.id,
        name: tool.data.name,
        input: tool.data.input,
      });
      continue;
    }
    const serverTool = serverToolUseBlockSchema.safeParse(block);
    if (serverTool.success) {
      uses.push({
        id: serverTool.data.id,
        name: serverTool.data.name,
        input: serverTool.data.input,
      });
      continue;
    }
    const mcpTool = mcpToolUseBlockSchema.safeParse(block);
    if (mcpTool.success) {
      uses.push({
        id: mcpTool.data.id,
        name: mcpTool.data.server_name
          ? `mcp__${mcpTool.data.server_name}__${mcpTool.data.name}`
          : mcpTool.data.name,
        input: mcpTool.data.input,
      });
    }
  }
  return uses;
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractDocumentBlockText(document: unknown): string | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const doc = document as Record<string, unknown>;
  const source =
    typeof doc.source === "object" && doc.source !== null
      ? (doc.source as Record<string, unknown>)
      : undefined;
  if (source !== undefined) {
    if (source.type === "text") {
      const data = trimNonEmpty(source.data);
      if (data !== undefined) return data;
    } else if (source.type === "content") {
      const contentText = trimNonEmpty(extractResultText(source.content));
      if (contentText !== undefined) return contentText;
    }
  }
  return trimNonEmpty(doc.title);
}

function extractCodeExecutionFileIds(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const fileIds: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const fileId = trimNonEmpty((item as Record<string, unknown>).file_id);
    if (fileId !== undefined) fileIds.push(fileId);
  }
  return fileIds.length > 0 ? `Files: ${fileIds.join(", ")}` : undefined;
}

function parseServerToolResultContent(
  content: unknown,
  explicitError: boolean | undefined,
): { isError: boolean; outputText: string | undefined } {
  if (Array.isArray(content)) {
    const webSearchLines: string[] = [];
    let sawWebSearchResult = false;
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item.type !== "web_search_result") continue;
      sawWebSearchResult = true;
      const title = trimNonEmpty(item.title);
      const url = trimNonEmpty(item.url);
      if (title !== undefined && url !== undefined) {
        webSearchLines.push(`${title} (${url})`);
      } else if (title !== undefined) {
        webSearchLines.push(title);
      } else if (url !== undefined) {
        webSearchLines.push(url);
      }
    }
    if (sawWebSearchResult) {
      return {
        isError: explicitError === true,
        outputText:
          webSearchLines.length > 0 ? webSearchLines.join("\n") : undefined,
      };
    }
    return {
      isError: explicitError === true,
      outputText: trimNonEmpty(extractResultText(content)),
    };
  }

  if (typeof content === "string") {
    return {
      isError: explicitError === true,
      outputText: trimNonEmpty(content),
    };
  }

  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    const contentType =
      typeof record.type === "string" ? record.type : undefined;

    if (contentType !== undefined && contentType.endsWith("_error")) {
      const errorMessage =
        trimNonEmpty(record.error_message) ??
        trimNonEmpty(record.message) ??
        trimNonEmpty(record.error_code);
      return { isError: true, outputText: errorMessage };
    }

    if (contentType === "advisor_redacted_result") {
      return { isError: explicitError === true, outputText: undefined };
    }

    if (contentType === "advisor_result") {
      return {
        isError: explicitError === true,
        outputText: trimNonEmpty(record.text),
      };
    }

    if (
      contentType === "bash_code_execution_result" ||
      contentType === "code_execution_result"
    ) {
      const returnCode =
        typeof record.return_code === "number" ? record.return_code : 0;
      const isError = explicitError === true || returnCode !== 0;
      const combined = combineClaudeProcessOutput({
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
      });
      const outputText =
        trimNonEmpty(combined) ??
        extractCodeExecutionFileIds(record.content) ??
        (returnCode !== 0 ? `Exit code ${returnCode}` : undefined);
      return { isError, outputText };
    }

    if (contentType === "encrypted_code_execution_result") {
      const returnCode =
        typeof record.return_code === "number" ? record.return_code : 0;
      const isError = explicitError === true || returnCode !== 0;
      const outputText =
        trimNonEmpty(record.stderr) ??
        extractCodeExecutionFileIds(record.content) ??
        (returnCode !== 0 ? `Exit code ${returnCode}` : undefined);
      return { isError, outputText };
    }

    if (contentType === "text_editor_code_execution_view_result") {
      const fileType = trimNonEmpty(record.file_type);
      const outputText =
        fileType === undefined || fileType === "text"
          ? trimNonEmpty(record.content)
          : `Viewed ${fileType} file`;
      return { isError: explicitError === true, outputText };
    }

    if (contentType === "text_editor_code_execution_str_replace_result") {
      const lines = Array.isArray(record.lines)
        ? record.lines
            .filter((line): line is string => typeof line === "string")
            .join("\n")
        : undefined;
      return {
        isError: explicitError === true,
        outputText: trimNonEmpty(lines) ?? "Applied edit",
      };
    }

    if (contentType === "text_editor_code_execution_create_result") {
      return {
        isError: explicitError === true,
        outputText:
          record.is_file_update === true ? "Updated file" : "Created file",
      };
    }

    if (contentType === "web_fetch_result") {
      const docText = extractDocumentBlockText(record.content);
      const url = trimNonEmpty(record.url);
      return {
        isError: explicitError === true,
        outputText: docText ?? url,
      };
    }

    if (contentType === "tool_search_tool_search_result") {
      const toolNames: string[] = [];
      if (Array.isArray(record.tool_references)) {
        for (const ref of record.tool_references) {
          if (typeof ref !== "object" || ref === null) continue;
          const toolName = trimNonEmpty(
            (ref as Record<string, unknown>).tool_name,
          );
          if (toolName !== undefined) toolNames.push(toolName);
        }
      }
      return {
        isError: explicitError === true,
        outputText: toolNames.length > 0 ? toolNames.join(", ") : undefined,
      };
    }

    if ("encrypted_content" in record || "encrypted_stdout" in record) {
      return { isError: explicitError === true, outputText: undefined };
    }

    return {
      isError: explicitError === true,
      outputText:
        trimNonEmpty(record.text) ?? trimNonEmpty(extractResultText(content)),
    };
  }

  return { isError: explicitError === true, outputText: undefined };
}

export function extractServerToolResults(
  message: ClaudeAssistantMessage,
): ClaudeServerToolResultBlockData[] {
  const results: ClaudeServerToolResultBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const parsed = serverToolResultBlockSchema.safeParse(block);
    if (!parsed.success) continue;
    const outcome = parseServerToolResultContent(
      parsed.data.content,
      parsed.data.is_error,
    );
    results.push({
      blockType: parsed.data.type,
      toolUseId: parsed.data.tool_use_id,
      isError: outcome.isError,
      outputText: outcome.outputText,
    });
  }
  return results;
}

export function extractStreamTextDelta(
  message: ClaudeStreamEventMessage,
): string | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    if (parsed.data.delta.type !== "text_delta") {
      return undefined;
    }
    return parsed.data.delta.text || undefined;
  }
  if (parsed.data.content_block.type !== "text") {
    return undefined;
  }
  return parsed.data.content_block.text || undefined;
}

export function extractStreamThinkingDelta(
  message: ClaudeStreamEventMessage,
): string | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    if (parsed.data.delta.type !== "thinking_delta") {
      return undefined;
    }
    return parsed.data.delta.thinking || undefined;
  }
  if (parsed.data.content_block.type !== "thinking") {
    return undefined;
  }
  return parsed.data.content_block.thinking || undefined;
}

export function extractThinkingBlocks(
  message: ClaudeAssistantMessage,
): string[] {
  const thinkingBlocks: string[] = [];
  for (const block of parseMessageContent(message)) {
    const thinkingBlock = thinkingBlockSchema.safeParse(block);
    if (thinkingBlock.success && thinkingBlock.data.thinking.length > 0) {
      thinkingBlocks.push(thinkingBlock.data.thinking);
    }
  }
  return thinkingBlocks;
}

export function extractToolResults(
  message: ClaudeUserMessage,
): ClaudeToolResultBlockData[] {
  const results: ClaudeToolResultBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const result = toolResultBlockSchema.safeParse(block);
    if (result.success) {
      results.push({
        toolUseId: result.data.tool_use_id,
        toolName: result.data.tool_name,
        content: result.data.content,
        isError: result.data.is_error ?? false,
        toolUseResult: result.data.tool_use_result ?? null,
      });
    }
  }
  return results;
}

function combineClaudeProcessOutput(
  streams: ClaudeProcessOutputStreams,
): string | undefined {
  if (streams.stdout.length === 0) {
    return streams.stderr.length > 0 ? streams.stderr : undefined;
  }
  if (streams.stderr.length === 0) {
    return streams.stdout;
  }
  return streams.stdout.endsWith("\n")
    ? `${streams.stdout}${streams.stderr}`
    : `${streams.stdout}\n${streams.stderr}`;
}

export function extractClaudeCommandExitCode(
  args: ClaudeCommandExitCodeArgs,
): number {
  if (!args.isError) {
    return 0;
  }
  const headerSources = [
    extractResultText(args.content),
    typeof args.toolUseResult === "string" ? args.toolUseResult : "",
  ];
  for (const text of headerSources) {
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const exitCode = Number(
      CLAUDE_EXIT_CODE_HEADER_PATTERN.exec(firstLine)?.[1],
    );
    if (Number.isSafeInteger(exitCode)) {
      return exitCode;
    }
  }
  return 1;
}

export function extractClaudeCommandExecutionOutput(
  args: ClaudeCommandExecutionOutputArgs,
): string | undefined {
  const normalizedContentOutput = normalizeProviderCommandOutput({
    text: extractResultText(args.content),
    emptyPlaceholders: CLAUDE_EMPTY_BASH_OUTPUT_PLACEHOLDERS,
  });
  if (args.toolUseResult !== null) {
    if (typeof args.toolUseResult === "string") {
      return (
        normalizeProviderCommandOutput({
          text: args.toolUseResult,
          emptyPlaceholders: CLAUDE_EMPTY_BASH_OUTPUT_PLACEHOLDERS,
        }) ?? normalizedContentOutput
      );
    }
    return (
      combineClaudeProcessOutput({
        stdout: args.toolUseResult.stdout ?? "",
        stderr: args.toolUseResult.stderr ?? "",
      }) ?? normalizedContentOutput
    );
  }
  return normalizedContentOutput;
}

interface ClaudeResultTokenUsage {
  last: ThreadEventTokenUsageBreakdown;
  modelContextWindow: number | null;
  promptCacheTtlMs: number | undefined;
}

const CLAUDE_ONE_HOUR_CACHE_TTL_MS = 60 * 60_000;
const CLAUDE_FIVE_MINUTE_CACHE_TTL_MS = 5 * 60_000;

export function extractClaudeResultTokenUsage(
  message: ClaudeResultMessage | SDKResultMessage,
): ClaudeResultTokenUsage | undefined {
  const parsed = sdkUsageSchema.safeParse(message.usage);
  const last = parsed.success ? toTokenUsageBreakdown(parsed.data) : undefined;
  const parsedModelUsage = claudeModelUsageSchema.safeParse(message.modelUsage);
  const modelContextWindow = parsedModelUsage.success
    ? extractModelContextWindow(parsedModelUsage.data)
    : null;

  if (!last && modelContextWindow === null) {
    return undefined;
  }

  return {
    last: last ?? {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    modelContextWindow,
    promptCacheTtlMs: parsed.success
      ? toPromptCacheTtlMs(parsed.data)
      : undefined,
  };
}

export function extractClaudeContextWindowUsage(
  args: ClaudeContextWindowUsageArgs,
): ThreadEventContextWindowUsage | undefined {
  const parsedModelUsage = claudeModelUsageSchema.safeParse(
    args.message.modelUsage,
  );
  const modelContextWindow = parsedModelUsage.success
    ? (extractModelContextWindow(parsedModelUsage.data) ??
      args.fallbackModelContextWindow)
    : args.fallbackModelContextWindow;
  const usedTokens = args.latestRequestContextTokens ?? null;

  if (usedTokens === null && modelContextWindow === null) {
    return undefined;
  }

  return {
    usedTokens,
    modelContextWindow,
    estimated: true,
  };
}

export function extractClaudeRequestContextTokens(
  message: ClaudeAssistantMessage,
): number | null {
  const parsedMessage = claudeAssistantUsageMessageSchema.safeParse(
    message.message,
  );
  if (!parsedMessage.success || !parsedMessage.data.usage) {
    return null;
  }

  return toClaudeCurrentContextTokens(parsedMessage.data.usage);
}

function toTokenUsageBreakdown(
  usage: ClaudeSdkUsage,
): ThreadEventTokenUsageBreakdown {
  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = toNonNegativeNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = toNonNegativeNumber(
    usage.cache_creation_input_tokens,
  );
  const cachedInputTokens = cacheReadTokens + cacheCreationTokens;

  return {
    totalTokens: inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cache_creation_input_tokens }),
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function toPromptCacheTtlMs(usage: ClaudeSdkUsage): number | undefined {
  const writes = usage.cache_creation;
  if (toNonNegativeNumber(writes?.ephemeral_1h_input_tokens) > 0) {
    return CLAUDE_ONE_HOUR_CACHE_TTL_MS;
  }
  if (toNonNegativeNumber(writes?.ephemeral_5m_input_tokens) > 0) {
    return CLAUDE_FIVE_MINUTE_CACHE_TTL_MS;
  }
  return undefined;
}

function toClaudeCurrentContextTokens(usage: ClaudeSdkUsage): number | null {
  return (
    toNonNegativeNumber(usage.input_tokens) +
    toNonNegativeNumber(usage.cache_read_input_tokens) +
    toNonNegativeNumber(usage.cache_creation_input_tokens)
  );
}

function extractModelContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
): number | null {
  if (!modelUsage) return null;

  let largestContextWindow: number | null = null;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const reportedContextWindow = toPositiveNumber(usage.contextWindow);
    if (reportedContextWindow === undefined) continue;

    const modelContextWindow = resolveClaudeModelContextWindowHint(model);
    const contextWindow =
      modelContextWindow === null
        ? reportedContextWindow
        : Math.max(reportedContextWindow, modelContextWindow);
    if (largestContextWindow === null || contextWindow > largestContextWindow) {
      largestContextWindow = contextWindow;
    }
  }

  return largestContextWindow;
}

export function resolveClaudeModelContextWindowHint(
  selectedModel: string,
): number | null {
  if (
    selectedModel.endsWith("[1m]") ||
    LARGE_CLAUDE_CONTEXT_MODELS.has(selectedModel)
  ) {
    return LARGE_CLAUDE_CONTEXT_WINDOW;
  }
  return null;
}
