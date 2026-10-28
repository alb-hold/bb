import { renderTemplate } from "@bb/templates";
import { and, eq, sql } from "drizzle-orm";
import { events, getThread, updateThread } from "@bb/db";
import {
  removeCommandMentionsFromPromptInput,
  type PromptInput,
  type PromptMentionCommandTrigger,
  type Thread,
} from "@bb/domain";
import {
  countWords,
  displayWidth,
  truncateToWidth,
  truncateToWidthAtWordBoundary,
} from "@bb/text-utils";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { runTextAiTask } from "../ai/ai-tasks.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";

const MIN_TITLE_GENERATION_WORDS = 5;
const MAX_GENERATED_TITLE_WIDTH = 48;
const MAX_TITLE_FALLBACK_WIDTH = 80;
const MAX_TITLE_PROMPT_WIDTH = 4000;
const ELLIPSIS = "...";
const MAX_BRANCH_SLUG_LENGTH = 48;

interface ApplyGeneratedThreadTitleArgs {
  threadId: string;
  title: string;
}

interface ThreadMetadataGenerationArgs {
  input: PromptInput[];
  threadId: string;
}

interface GeneratedThreadMetadata {
  title?: string;
}

type ThreadMetadataGenerationOutcomeReason =
  | "already-titled"
  | "empty-input"
  | "failed"
  | "inference-unavailable"
  | "too-short"
  | "timeout";

export interface ThreadMetadataGenerationOutcome {
  durationMs: number;
  metadata: GeneratedThreadMetadata | null;
  reason?: ThreadMetadataGenerationOutcomeReason;
}

interface AppliedThreadTitleOutcome {
  outcome: ThreadMetadataGenerationOutcome;
  titleApplied: boolean;
}

const titlesInFlight = new Map<string, Promise<AppliedThreadTitleOutcome>>();
const providerTitleFallbacks = new WeakMap<
  AppDeps["db"],
  Map<string, string>
>();

function providerTitleFallbacksForDb(db: AppDeps["db"]): Map<string, string> {
  let titles = providerTitleFallbacks.get(db);
  if (titles === undefined) {
    titles = new Map();
    providerTitleFallbacks.set(db, titles);
  }
  return titles;
}

function cleanPromptText(input: PromptInput[]): string {
  return input
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function clampToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  const body = truncateToWidth(text, maxWidth - ELLIPSIS.length);
  return `${body}${ELLIPSIS}`;
}

export function deriveTitleFallback(input: PromptInput[]): string | null {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return null;
  }
  return clampToWidth(text, MAX_TITLE_FALLBACK_WIDTH);
}

const FORK_TITLE_PATTERN = /^\((\d+)\) (.+)$/s;

export function deriveForkTitle(
  source: Pick<Thread, "title" | "titleFallback">,
): string | null {
  const sourceTitle = source.title?.trim() || source.titleFallback?.trim();
  if (!sourceTitle) {
    return null;
  }
  const numbered = FORK_TITLE_PATTERN.exec(sourceTitle);
  if (numbered === null) {
    return `(1) ${sourceTitle}`;
  }
  return `(${BigInt(numbered[1]) + 1n}) ${numbered[2]}`;
}

interface InvokedPromptCommand {
  name: string;
  trigger: PromptMentionCommandTrigger;
}

export function collectInvokedPromptCommands(
  input: PromptInput[],
): InvokedPromptCommand[] {
  const seen = new Set<string>();
  return input.flatMap((part) =>
    part.type === "text"
      ? part.mentions.flatMap((mention) => {
          if (mention.resource.kind !== "command") {
            return [];
          }
          const { name, trigger } = mention.resource;
          const key = `${trigger}${name}`;
          if (seen.has(key)) {
            return [];
          }
          seen.add(key);
          return [{ name, trigger }];
        })
      : [],
  );
}

function promptTextWithoutCommands(
  input: PromptInput[],
  commands: InvokedPromptCommand[],
): string {
  return cleanPromptText(
    commands.reduce<PromptInput[]>(
      (remaining, command) =>
        removeCommandMentionsFromPromptInput(remaining, command),
      input,
    ),
  );
}

function formatInvokedCommands(commands: InvokedPromptCommand[]): string {
  return commands
    .map((command) => `${command.trigger}${command.name}`)
    .join(", ");
}

export function shouldGenerateThreadTitle(input: PromptInput[]): boolean {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return false;
  }

  if (collectInvokedPromptCommands(input).length > 0) {
    return true;
  }

  return countWords(text) >= MIN_TITLE_GENERATION_WORDS;
}

export function sanitizeGeneratedTitle(value: string): string | null {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const title = truncateToWidthAtWordBoundary(
    normalized,
    MAX_GENERATED_TITLE_WIDTH,
  ).trim();
  return title.length > 0 ? title : null;
}

export function sanitizeGeneratedBranchSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/u, "");

  return slug.length > 0 ? slug : null;
}

export function buildThreadTitlePrompt(input: PromptInput[]): string | null {
  const text = cleanPromptText(input);
  if (!text) {
    return null;
  }
  const commands = collectInvokedPromptCommands(input);
  const body = promptTextWithoutCommands(input, commands);
  return renderTemplate("generateThreadMetadata", {
    cleanedPrompt: clampToWidth(
      body.length > 0 ? body : text,
      MAX_TITLE_PROMPT_WIDTH,
    ),
    ...(commands.length > 0
      ? { invokedCommands: formatInvokedCommands(commands) }
      : {}),
  });
}

export async function generateThreadMetadataWithOutcome(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<ThreadMetadataGenerationOutcome> {
  const startedAt = Date.now();
  const complete = (
    metadata: GeneratedThreadMetadata | null,
    reason?: ThreadMetadataGenerationOutcomeReason,
  ): ThreadMetadataGenerationOutcome => ({
    durationMs: Date.now() - startedAt,
    metadata,
    ...(reason ? { reason } : {}),
  });

  const prompt = buildThreadTitlePrompt(args.input);
  if (prompt === null) {
    return complete(null, "empty-input");
  }
  if (!shouldGenerateThreadTitle(args.input)) {
    return complete(null, "too-short");
  }

  const outcome = await runTextAiTask(deps, {
    task: "thread-title",
    label: "Thread title generation",
    logContext: { threadId: args.threadId },
    prompt,
  });
  if (!outcome.ok) {
    return complete(
      null,
      outcome.reason === "timeout"
        ? "timeout"
        : outcome.reason === "failed"
          ? "failed"
          : "inference-unavailable",
    );
  }
  const title = sanitizeGeneratedTitle(outcome.value);
  return title === null ? complete(null, "failed") : complete({ title });
}

export function applyGeneratedThreadTitle(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ApplyGeneratedThreadTitleArgs,
): boolean {
  const title = sanitizeGeneratedTitle(args.title);
  if (
    title === null ||
    title.length <= 3 ||
    isPrefixOfFirstAssistantReply(deps, args.threadId, title)
  ) {
    return false;
  }

  return writeThreadTitleIfEmpty(deps, args.threadId, title);
}

function writeThreadTitleIfEmpty(
  deps: Pick<AppDeps, "db" | "hub">,
  threadId: string,
  title: string,
): boolean {
  const currentThread = getThread(deps.db, threadId);
  if (!currentThread || currentThread.title) return false;

  updateThread(deps.db, deps.hub, threadId, { title });
  return true;
}

function isPrefixOfFirstAssistantReply(
  deps: Pick<AppDeps, "db">,
  threadId: string,
  title: string,
): boolean {
  const firstAssistantReply = deps.db
    .select({
      text: sql<string | null>`json_extract(${events.data}, '$.item.text')`,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "item/completed"),
        eq(events.itemKind, "agentMessage"),
        sql`COALESCE(json_extract(${events.data}, '$.item.text'), '') <> ''`,
      ),
    )
    .orderBy(events.sequence)
    .limit(1)
    .get()?.text;
  return firstAssistantReply?.startsWith(title) ?? false;
}

export function applyFallbackThreadTitle(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ApplyGeneratedThreadTitleArgs,
): boolean {
  const title = sanitizeGeneratedTitle(args.title);
  if (title === null) return false;

  return writeThreadTitleIfEmpty(deps, args.threadId, title);
}

export function applyProviderThreadTitle(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ApplyGeneratedThreadTitleArgs,
): boolean {
  const title = sanitizeGeneratedTitle(args.title);
  if (
    title === null ||
    title.length <= 3 ||
    isPrefixOfFirstAssistantReply(deps, args.threadId, title)
  ) {
    return false;
  }

  return writeThreadTitleIfEmpty(deps, args.threadId, title);
}

export function generateFromProviderThreadName(
  deps: LoggedWorkSessionDeps,
  args: ApplyGeneratedThreadTitleArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  const candidate = sanitizeGeneratedTitle(args.title);
  if (!thread || thread.title || candidate === null) return Promise.resolve();

  providerTitleFallbacksForDb(deps.db).set(args.threadId, candidate);
  const input = thread.titleFallback
    ? [{ type: "text" as const, text: thread.titleFallback, mentions: [] }]
    : [];
  return generateAndApplyThreadTitle(deps, {
    input,
    threadId: args.threadId,
  })
    .then(({ outcome }) => {
      if (outcome.metadata !== null) return;
      const fallback = providerTitleFallbacksForDb(deps.db).get(args.threadId);
      if (fallback !== undefined) {
        applyProviderThreadTitle(deps, {
          threadId: args.threadId,
          title: fallback,
        });
      }
    })
    .catch((error: unknown) => {
      deps.logger.warn(
        {
          threadId: args.threadId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Failed to generate thread title",
      );
    })
    .finally(() => {
      providerTitleFallbacksForDb(deps.db).delete(args.threadId);
    });
}

export function generateAndApplyThreadTitle(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<AppliedThreadTitleOutcome> {
  const existingThread = getThread(deps.db, args.threadId);
  if (
    existingThread?.title != null &&
    !providerTitleFallbacksForDb(deps.db).has(args.threadId)
  ) {
    return Promise.resolve({
      outcome: { durationMs: 0, metadata: null, reason: "already-titled" },
      titleApplied: false,
    });
  }
  const pending = titlesInFlight.get(args.threadId);
  if (pending !== undefined) return pending;
  const firstAttempt = generateThreadMetadataWithOutcome(deps, args);
  const retried = firstAttempt.then((outcome) =>
    outcome.reason === "failed" || outcome.reason === "timeout"
      ? generateThreadMetadataWithOutcome(deps, args)
      : outcome,
  );
  const generating = retried
    .then((outcome) => {
      let titleApplied = false;
      if (outcome.metadata?.title) {
        try {
          titleApplied = applyGeneratedThreadTitle(deps, {
            threadId: args.threadId,
            title: outcome.metadata.title,
          });
        } catch (error) {
          deps.logger.warn(
            {
              threadId: args.threadId,
              ...runtimeErrorLogFields(deps.config, error),
            },
            "Failed to apply generated thread title",
          );
        }
      }
      if (!titleApplied) {
        const providerTitle = providerTitleFallbacksForDb(deps.db).get(
          args.threadId,
        );
        if (providerTitle !== undefined) {
          titleApplied = applyProviderThreadTitle(deps, {
            threadId: args.threadId,
            title: providerTitle,
          });
        }
        if (
          !titleApplied &&
          (providerTitle !== undefined ||
            outcome.metadata !== null ||
            outcome.reason !== "too-short")
        ) {
          const fallback = getThread(deps.db, args.threadId)?.titleFallback;
          const title = fallback ? sanitizeGeneratedTitle(fallback) : null;
          if (title !== null) {
            titleApplied = applyFallbackThreadTitle(deps, {
              threadId: args.threadId,
              title,
            });
          }
        }
      }
      return { outcome, titleApplied };
    })
    .finally(() => {
      titlesInFlight.delete(args.threadId);
    });
  titlesInFlight.set(args.threadId, generating);
  return generating;
}
