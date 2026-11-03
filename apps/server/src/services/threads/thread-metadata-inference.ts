import type { PromptInput, ProvisioningTranscriptEntry } from "@bb/domain";
import { getThread } from "@bb/db";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { appendThreadProvisioningEvent } from "./thread-events.js";
import {
  generateAndApplyThreadTitle,
  type ThreadMetadataGenerationOutcome,
} from "./title-generation.js";

interface ThreadMetadataInferenceArgs {
  input: PromptInput[];
  provisioningId: string;
  threadId: string;
  writeTranscript: boolean;
}

interface ThreadMetadataInferenceResult {
  titleApplied: boolean;
  title: string | null;
}

interface MetadataCompletedEntryArgs {
  outcome: ThreadMetadataGenerationOutcome;
  startedAt: number;
}

function metadataCompletedEntry(
  args: MetadataCompletedEntryArgs,
): ProvisioningTranscriptEntry {
  const titleGenerated = Boolean(args.outcome.metadata?.title);
  return {
    type: "step",
    key: "metadata-completed",
    text: titleGenerated ? "Generated title" : "No title generated",
    status: "completed",
    startedAt: args.startedAt,
    metadata: {
      durationMs: args.outcome.durationMs,
      titleGenerated,
      ...(args.outcome.reason ? { reason: args.outcome.reason } : {}),
    },
  };
}

export async function inferThreadMetadata(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataInferenceArgs,
): Promise<ThreadMetadataInferenceResult> {
  const startedAt = Date.now();
  const provisioningId = args.provisioningId;
  if (args.writeTranscript) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: null,
      provisioningId,
      status: "active",
      entries: [
        {
          type: "step",
          key: "metadata-started",
          text: "Generating title",
          status: "started",
          startedAt,
        },
      ],
    });
  }

  const { outcome, titleApplied } = await generateAndApplyThreadTitle(deps, {
    input: args.input,
    threadId: args.threadId,
  });

  if (args.writeTranscript) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.threadId,
      environmentId: null,
      provisioningId,
      status: "active",
      entries: [metadataCompletedEntry({ outcome, startedAt })],
    });
  }

  return {
    title:
      (titleApplied ? getThread(deps.db, args.threadId)?.title : null) ??
      outcome.metadata?.title ??
      null,
    titleApplied,
  };
}
