// ../domain/src/context-snapshot.ts
import { z } from "zod";
var tokenCountSchema = z.number().int().nonnegative();
var contextEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tokens: tokenCountSchema
});
var contextCategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["used", "free", "reserved", "deferred"]),
  tokens: tokenCountSchema,
  entries: z.array(contextEntrySchema)
});
var contextSnapshotSchema = z.object({
  capturedAt: z.iso.datetime(),
  providerSessionId: z.string().min(1),
  providerTurnId: z.string().min(1).nullable(),
  model: z.string().min(1),
  usedTokens: tokenCountSchema,
  contextWindowTokens: z.number().int().positive(),
  autoCompactAtTokens: z.number().int().positive().nullable(),
  estimated: z.boolean(),
  categories: z.array(contextCategorySchema)
});

// ../domain/src/shared-types.ts
import { z as z3 } from "zod";

// ../domain/src/json-value.ts
import { z as z2 } from "zod";
var jsonValueSchema = z2.lazy(
  () => z2.union([
    z2.string(),
    z2.number(),
    z2.boolean(),
    z2.null(),
    z2.array(jsonValueSchema),
    z2.record(z2.string(), jsonValueSchema)
  ])
);
var jsonObjectSchema = z2.record(
  z2.string(),
  jsonValueSchema
);

// ../domain/src/shared-types.ts
var reasoningLevelSchema = z3.string().min(1);
var serviceTierSchema = z3.string().min(1);
var instructionModeValues = ["append", "replace"];
var instructionModeSchema = z3.enum(instructionModeValues);
var permissionModeValues = ["accept-edits", "auto", "full"];
var permissionModeSchema = z3.enum(permissionModeValues);
var permissionModeInputSchema = z3.union([permissionModeSchema, z3.literal("workspace-write")]).transform(
  (permissionMode) => permissionMode === "workspace-write" ? "accept-edits" : permissionMode
);
var legacyRecordedPermissionModeValues = [
  "workspace-write",
  "readonly"
];
var recordedPermissionModeSchema = z3.enum([
  ...permissionModeValues,
  ...legacyRecordedPermissionModeValues
]);
var permissionEscalationValues = ["ask", "deny"];
var permissionEscalationSchema = z3.enum(permissionEscalationValues);
var promptInputVisibilityValues = ["agent-only"];
var promptInputVisibilitySchema = z3.enum(promptInputVisibilityValues);
var promptInputVisibilityFields = {
  visibility: promptInputVisibilitySchema.optional()
};
var promptMentionPathSourceValues = ["workspace", "thread-storage"];
var promptMentionPathSourceSchema = z3.enum(promptMentionPathSourceValues);
var promptMentionPathEntryKindValues = ["file", "directory"];
var promptMentionPathEntryKindSchema = z3.enum(
  promptMentionPathEntryKindValues
);
var promptMentionCommandTriggerValues = ["/", "$"];
var promptMentionCommandTriggerSchema = z3.enum(
  promptMentionCommandTriggerValues
);
var promptMentionCommandSourceValues = ["skill", "command"];
var promptMentionCommandSourceSchema = z3.enum(
  promptMentionCommandSourceValues
);
var promptMentionCommandOriginValues = [
  "builtin",
  "project",
  "user"
];
var promptMentionCommandOriginSchema = z3.enum(
  promptMentionCommandOriginValues
);
var canonicalPromptMentionResourceSchema = z3.discriminatedUnion("kind", [
  z3.object({
    kind: z3.literal("thread"),
    threadId: z3.string(),
    projectId: z3.string().optional(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("project"),
    projectId: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("section"),
    sectionId: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("path"),
    source: promptMentionPathSourceSchema,
    entryKind: promptMentionPathEntryKindSchema,
    path: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("command"),
    trigger: promptMentionCommandTriggerSchema,
    name: z3.string(),
    source: promptMentionCommandSourceSchema,
    origin: promptMentionCommandOriginSchema,
    label: z3.string(),
    argumentHint: z3.string().nullable()
  }),
  z3.object({
    kind: z3.literal("plugin"),
    pluginId: z3.string(),
    icon: z3.string().nullable().optional(),
    itemId: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("attachment"),
    path: z3.string(),
    label: z3.string()
  })
]);
function normalizeLegacyPromptMentionResource(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value;
  if (record.kind !== "folder" || typeof record.folderId !== "string") {
    return value;
  }
  const { folderId, ...rest } = record;
  return { ...rest, kind: "section", sectionId: folderId };
}
var promptMentionResourceSchema = z3.preprocess(
  normalizeLegacyPromptMentionResource,
  canonicalPromptMentionResourceSchema
);
var promptTextMentionSchema = z3.object({
  start: z3.number().int().nonnegative(),
  end: z3.number().int().nonnegative(),
  resource: promptMentionResourceSchema
});
var promptInputSchema = z3.discriminatedUnion("type", [
  z3.object({
    type: z3.literal("text"),
    text: z3.string(),
    mentions: z3.array(promptTextMentionSchema).default([]),
    ...promptInputVisibilityFields
  }),
  z3.object({
    type: z3.literal("image"),
    url: z3.string().url(),
    ...promptInputVisibilityFields
  }),
  z3.object({
    type: z3.literal("localImage"),
    path: z3.string(),
    sourceProjectId: z3.string().min(1).optional(),
    hostId: z3.string().min(1).optional(),
    ...promptInputVisibilityFields
  }),
  z3.object({
    type: z3.literal("localFile"),
    path: z3.string(),
    sourceProjectId: z3.string().min(1).optional(),
    hostId: z3.string().min(1).optional(),
    name: z3.string().optional(),
    sizeBytes: z3.number().int().nonnegative().optional(),
    mimeType: z3.string().optional(),
    ...promptInputVisibilityFields
  })
]);
var threadExecutionSourceSchema = z3.enum([
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start"
]);
var callerExecutionInputSourceValues = [
  "explicit",
  "client-preference"
];
var callerExecutionInputSourceSchema = z3.enum(
  callerExecutionInputSourceValues
);
var threadExecutionOptionsSchema = z3.object({
  model: z3.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  source: threadExecutionSourceSchema.optional(),
  seq: z3.number().int().optional()
});
var resolvedThreadExecutionOptionsSchema = threadExecutionOptionsSchema.extend({
  model: z3.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  source: threadExecutionSourceSchema
});
var recordedThreadExecutionOptionsSchema = resolvedThreadExecutionOptionsSchema.extend({
  permissionMode: recordedPermissionModeSchema
});
var threadExecutionReportSchema = z3.object({
  model: z3.string().min(1),
  reasoningLevel: reasoningLevelSchema.nullable(),
  permissionMode: permissionModeSchema.nullable(),
  serviceTier: serviceTierSchema.nullable()
});
var runtimePermissionScopeValues = ["workspace", "full"];
var runtimePermissionScopeSchema = z3.enum(runtimePermissionScopeValues);
var runtimePermissionPolicySchema = z3.discriminatedUnion(
  "permissionMode",
  [
    z3.object({
      permissionMode: z3.literal("accept-edits"),
      permissionScope: z3.literal("workspace"),
      approvalReviewer: z3.literal("user"),
      permissionEscalation: permissionEscalationSchema
    }),
    z3.object({
      permissionMode: z3.literal("auto"),
      permissionScope: z3.literal("workspace"),
      approvalReviewer: z3.literal("automatic"),
      permissionEscalation: permissionEscalationSchema
    }),
    z3.object({
      permissionMode: z3.literal("full"),
      permissionScope: z3.literal("full"),
      approvalReviewer: z3.null(),
      permissionEscalation: z3.null()
    })
  ]
);
var promptModeSchema = z3.literal("plan");
var sessionOptionValueSchema = z3.union([z3.string(), z3.boolean()]);
var sessionOptionSelectionsSchema = z3.record(
  z3.string().min(1),
  sessionOptionValueSchema
);
var runtimeThreadExecutionBaseOptionsSchema = z3.object({
  model: z3.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  providerOptions: jsonObjectSchema
});
var runtimeThreadExecutionOptionsSchema = runtimeThreadExecutionBaseOptionsSchema.and(runtimePermissionPolicySchema);
var projectExecutionDefaultsSchema = z3.object({
  providerId: z3.string().min(1),
  model: z3.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema
});

// ../domain/src/completed-turn-display.ts
import { z as z4 } from "zod";
var COMPLETED_TURN_DISPLAY_VALUES = ["collapse", "flat"];
var completedTurnDisplaySchema = z4.enum(COMPLETED_TURN_DISPLAY_VALUES);

// ../domain/src/background-task.ts
import { z as z5 } from "zod";
var backgroundTaskStatusValues = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "killed",
  "stopped"
];
var backgroundTaskStatusSchema = z5.enum(backgroundTaskStatusValues);
var workflowAgentStateValues = [
  "queued",
  "running",
  "done",
  "failed",
  "skipped"
];
var workflowAgentStateSchema = z5.enum(workflowAgentStateValues);
var workflowAgentSnapshotSchema = z5.object({
  index: z5.number().int().positive(),
  label: z5.string(),
  state: workflowAgentStateSchema,
  model: z5.string(),
  attempt: z5.number().int().positive(),
  cached: z5.boolean(),
  lastProgressAt: z5.number(),
  phaseIndex: z5.number().int().positive().optional(),
  phaseTitle: z5.string().optional(),
  agentType: z5.string().optional(),
  isolation: z5.string().optional(),
  queuedAt: z5.number().optional(),
  startedAt: z5.number().optional(),
  lastToolName: z5.string().optional(),
  lastToolSummary: z5.string().optional(),
  promptPreview: z5.string().optional(),
  resultPreview: z5.string().optional(),
  error: z5.string().optional(),
  tokens: z5.number().optional(),
  toolCalls: z5.number().optional(),
  durationMs: z5.number().optional()
});
var workflowPhaseSnapshotSchema = z5.object({
  index: z5.number().int().positive(),
  title: z5.string(),
  kind: z5.string().optional()
});
var workflowProgressSnapshotSchema = z5.object({
  phases: z5.array(workflowPhaseSnapshotSchema),
  agents: z5.array(workflowAgentSnapshotSchema)
});
var backgroundTaskUsageSchema = z5.object({
  totalTokens: z5.number(),
  toolUses: z5.number(),
  durationMs: z5.number()
});

// ../domain/src/provider-event.ts
import { z as z14 } from "zod";

// ../domain/src/thread-events.ts
import { z as z11 } from "zod";

// ../domain/src/pending-interactions.ts
import { z as z8 } from "zod";

// ../domain/src/plugin-interaction-limits.ts
var PLUGIN_INTERACTION_MAX_TITLE_LENGTH = 160;
var PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES = 64 * 1024;
var PLUGIN_INTERACTION_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1e3;
function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ../domain/src/item-presentation.ts
import { z as z6 } from "zod";
var THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH = 280;
var threadEventItemPresentationLabelSchema = z6.object({
  pending: z6.string().min(1),
  completed: z6.string().min(1)
});
var threadEventItemPresentationIconSchema = z6.object({
  glyph: z6.string().min(1)
});
var threadEventItemPresentationTintSchema = z6.object({
  light: z6.string().min(1),
  dark: z6.string().min(1)
});
var THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH = 80;
var threadEventItemPresentationBadgeSchema = z6.object({
  glyph: z6.string().min(1),
  label: z6.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  hint: z6.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  tone: z6.enum(["neutral", "destructive"])
});
var threadEventItemPresentationSchema = z6.object({
  label: threadEventItemPresentationLabelSchema,
  icon: threadEventItemPresentationIconSchema,
  title: z6.string().optional(),
  detail: z6.string().max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  suppress: z6.boolean().optional(),
  tint: threadEventItemPresentationTintSchema.optional(),
  badge: threadEventItemPresentationBadgeSchema.optional()
});

// ../domain/src/provider-extension-kind.ts
import { z as z7 } from "zod";
var EXTENSION_KIND_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/u;
function isExtensionKind(value) {
  return EXTENSION_KIND_PATTERN.test(value);
}
var extensionKindSchema = z7.string().refine(isExtensionKind, {
  message: 'extension kinds are "<pluginId>/<name>" (lowercase letters, digits, and "-")'
});

// ../domain/src/pending-interactions.ts
var pendingInteractionStatusSchema = z8.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted"
]);
var pendingInteractionCommandActionSchema = z8.discriminatedUnion(
  "type",
  [
    z8.object({
      type: z8.literal("read"),
      command: z8.string(),
      name: z8.string(),
      path: z8.string()
    }),
    z8.object({
      type: z8.literal("listFiles"),
      command: z8.string(),
      path: z8.string().nullable()
    }),
    z8.object({
      type: z8.literal("search"),
      command: z8.string(),
      query: z8.string().nullable(),
      path: z8.string().nullable()
    }),
    z8.object({
      type: z8.literal("unknown"),
      command: z8.string()
    })
  ]
);
var pendingInteractionNetworkPermissionsSchema = z8.object({
  enabled: z8.boolean().nullable()
});
var pendingInteractionFileSystemPermissionsSchema = z8.object({
  read: z8.array(z8.string()),
  write: z8.array(z8.string())
});
var pendingInteractionMacOsPreferencesPermissionSchema = z8.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsContactsPermissionSchema = z8.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsAutomationPermissionSchema = z8.union([
  z8.literal("none"),
  z8.literal("all"),
  z8.object({
    kind: z8.literal("bundle_ids"),
    bundleIds: z8.array(z8.string())
  })
]);
var pendingInteractionMacOsPermissionsSchema = z8.object({
  preferences: pendingInteractionMacOsPreferencesPermissionSchema,
  automations: pendingInteractionMacOsAutomationPermissionSchema,
  launchServices: z8.boolean(),
  accessibility: z8.boolean(),
  calendar: z8.boolean(),
  reminders: z8.boolean(),
  contacts: pendingInteractionMacOsContactsPermissionSchema
});
var pendingInteractionRequestedPermissionProfileSchema = z8.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
  macos: pendingInteractionMacOsPermissionsSchema.nullable()
});
var pendingInteractionGrantablePermissionProfileSchema = z8.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable()
}).strict();
var pendingInteractionGrantedPermissionProfileSchema = pendingInteractionGrantablePermissionProfileSchema;
var pendingInteractionApprovalDecisionSchema = z8.enum([
  "allow_once",
  "allow_for_session",
  "deny"
]);
var pendingInteractionFileChangeWriteScopeSchema = z8.string().min(1);
var pendingInteractionCommandApprovalSubjectSchema = z8.object({
  kind: z8.literal("command"),
  itemId: z8.string().min(1),
  command: z8.string().min(1),
  cwd: z8.string().nullable(),
  actions: z8.array(pendingInteractionCommandActionSchema),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionFileChangeApprovalSubjectSchema = z8.object({
  kind: z8.literal("file_change"),
  itemId: z8.string().min(1),
  writeScope: pendingInteractionFileChangeWriteScopeSchema.nullable(),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionPermissionGrantApprovalSubjectSchema = z8.object({
  kind: z8.literal("permission_grant"),
  itemId: z8.string().min(1),
  toolName: z8.string().nullable(),
  permissions: pendingInteractionGrantablePermissionProfileSchema
});
var pendingInteractionPlanApprovalSubjectSchema = z8.object({
  kind: z8.literal("plan"),
  itemId: z8.string().min(1),
  plan: z8.string().min(1),
  planFilePath: z8.string().min(1).nullable()
});
var pendingInteractionToolUseApprovalSubjectSchema = z8.object({
  kind: z8.literal("tool_use"),
  itemId: z8.string().min(1),
  tool: z8.string().min(1),
  presentation: threadEventItemPresentationSchema
});
var pendingInteractionApprovalSubjectSchema = z8.discriminatedUnion("kind", [
  pendingInteractionCommandApprovalSubjectSchema,
  pendingInteractionFileChangeApprovalSubjectSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionPlanApprovalSubjectSchema,
  pendingInteractionToolUseApprovalSubjectSchema
]);
var approvalPendingInteractionPayloadSchema = z8.object({
  kind: z8.literal("approval"),
  subject: pendingInteractionApprovalSubjectSchema,
  reason: z8.string().nullable(),
  availableDecisions: z8.array(pendingInteractionApprovalDecisionSchema).min(1)
});
var USER_QUESTION_MAX_QUESTIONS = 4;
var USER_QUESTION_MAX_OPTIONS = 4;
var USER_QUESTION_MAX_SELECTED = 4;
var USER_QUESTION_MAX_FREE_TEXT_LENGTH = 4096;
var pendingInteractionUserQuestionIdSchema = z8.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question ids cannot be blank"
});
var pendingInteractionUserQuestionPromptSchema = z8.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question prompts cannot be blank"
});
var pendingInteractionUserQuestionShortLabelSchema = z8.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question short labels cannot be blank"
});
var pendingInteractionUserQuestionOptionValueSchema = z8.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option values cannot be blank"
});
var pendingInteractionUserQuestionOptionLabelSchema = z8.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option labels cannot be blank"
});
var pendingInteractionUserQuestionOptionDescriptionSchema = z8.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option descriptions cannot be blank"
});
var pendingInteractionUserQuestionFreeTextSchema = z8.string().min(1).max(
  USER_QUESTION_MAX_FREE_TEXT_LENGTH,
  `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`
).refine((value) => value.trim().length > 0, {
  message: "User question free text cannot be blank"
});
var pendingInteractionUserQuestionOptionSchema = z8.object({
  value: pendingInteractionUserQuestionOptionValueSchema,
  label: pendingInteractionUserQuestionOptionLabelSchema,
  description: pendingInteractionUserQuestionOptionDescriptionSchema.optional()
});
var pendingInteractionUserQuestionQuestionSchema = z8.object({
  id: pendingInteractionUserQuestionIdSchema,
  prompt: pendingInteractionUserQuestionPromptSchema,
  shortLabel: pendingInteractionUserQuestionShortLabelSchema.optional(),
  multiSelect: z8.boolean(),
  options: z8.array(pendingInteractionUserQuestionOptionSchema).max(
    USER_QUESTION_MAX_OPTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_OPTIONS} options`
  ).optional(),
  allowFreeText: z8.boolean()
}).superRefine((question, context) => {
  const optionValues = /* @__PURE__ */ new Set();
  question.options?.forEach((option, index) => {
    if (optionValues.has(option.value)) {
      context.addIssue({
        code: z8.ZodIssueCode.custom,
        message: "User question option values must be unique",
        path: ["options", index, "value"]
      });
      return;
    }
    optionValues.add(option.value);
  });
}).refine(
  (question) => question.allowFreeText || (question.options?.length ?? 0) > 0,
  {
    message: "User questions must allow free text or provide at least one option",
    path: ["options"]
  }
);
var userQuestionPendingInteractionPayloadSchema = z8.object({
  kind: z8.literal("user_question"),
  questions: z8.array(pendingInteractionUserQuestionQuestionSchema).min(1).max(
    USER_QUESTION_MAX_QUESTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_QUESTIONS} questions`
  )
}).superRefine((payload, context) => {
  const questionIds = /* @__PURE__ */ new Set();
  payload.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: z8.ZodIssueCode.custom,
        message: "User question ids must be unique",
        path: ["questions", index, "id"]
      });
      return;
    }
    questionIds.add(question.id);
  });
});
var pluginPendingInteractionPayloadSchema = z8.object({
  kind: z8.literal("plugin"),
  title: z8.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema,
  presentation: threadEventItemPresentationSchema.optional()
});
var pluginExtensionInteractionRequestPayloadSchema = z8.object({
  kind: extensionKindSchema,
  title: z8.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin request data exceeds 64 KiB" }
  )
});
var interactionRequestPayloadSchema = z8.union([
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
var pendingInteractionPayloadSchema = z8.union([
  approvalPendingInteractionPayloadSchema,
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
var approvalDecisionDiscriminatorError = "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'";
var approvalPendingInteractionResolutionSchema = z8.discriminatedUnion(
  "decision",
  [
    z8.object({
      decision: z8.literal("allow_once"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z8.object({
      decision: z8.literal("allow_for_session"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z8.object({
      decision: z8.literal("deny")
    })
  ],
  approvalDecisionDiscriminatorError
);
var pendingInteractionUserAnswerSchema = z8.object({
  selected: z8.array(z8.string().min(1)).max(
    USER_QUESTION_MAX_SELECTED,
    `User question selected choices cannot exceed ${USER_QUESTION_MAX_SELECTED}`
  ),
  freeText: pendingInteractionUserQuestionFreeTextSchema.optional()
});
var userQuestionPendingInteractionResolutionSchema = z8.object({
  kind: z8.literal("user_answer"),
  answers: z8.record(z8.string().min(1), pendingInteractionUserAnswerSchema)
});
var pluginInteractionDescriptionSchema = z8.object({
  title: z8.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH).optional(),
  detail: z8.string().trim().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  payload: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin interaction description payload exceeds 64 KiB" }
  ).optional()
});
var pluginPendingInteractionResolutionSchema = z8.object({
  kind: z8.literal("plugin_submitted"),
  description: pluginInteractionDescriptionSchema.optional()
});
var pluginExtensionInteractionResolutionSchema = z8.object({
  kind: z8.literal("request_answer"),
  value: jsonValueSchema
});
var pendingInteractionResolutionSchema = z8.union(
  [
    approvalPendingInteractionResolutionSchema,
    userQuestionPendingInteractionResolutionSchema,
    pluginPendingInteractionResolutionSchema,
    pluginExtensionInteractionResolutionSchema
  ],
  approvalDecisionDiscriminatorError
);
var approvalInteractionOutcomeSchema = z8.object({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema
});
var userQuestionInteractionOutcomeSchema = z8.object({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema
});
var pluginExtensionInteractionOutcomeSchema = z8.object({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema
});
var providerInteractionOutcomeSchema = z8.union([
  approvalInteractionOutcomeSchema,
  userQuestionInteractionOutcomeSchema,
  pluginExtensionInteractionOutcomeSchema
]);
var pendingInteractionProviderOriginSchema = z8.object({
  kind: z8.literal("provider"),
  providerId: z8.string().min(1),
  providerThreadId: z8.string().min(1),
  providerRequestId: z8.string().min(1)
});
var pendingInteractionPluginOriginSchema = z8.object({
  kind: z8.literal("plugin"),
  pluginId: z8.string().min(1),
  rendererId: z8.string().min(1)
});
var pendingInteractionCreateSchema = z8.object({
  threadId: z8.string().min(1),
  turnId: z8.string().min(1),
  providerId: z8.string().min(1),
  providerThreadId: z8.string().min(1),
  providerRequestId: z8.string().min(1),
  payload: pendingInteractionPayloadSchema
});
var pendingInteractionBaseSchema = z8.object({
  id: z8.string().min(1),
  threadId: z8.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z8.string().nullable(),
  createdAt: z8.number().int().nonnegative(),
  expiresAt: z8.number().int().nonnegative().nullable().optional(),
  resolvedAt: z8.number().int().nonnegative().nullable()
});
var providerPendingInteractionBaseSchema = pendingInteractionBaseSchema.extend({
  turnId: z8.string().min(1),
  providerId: z8.string().min(1),
  providerThreadId: z8.string().min(1),
  providerRequestId: z8.string().min(1),
  origin: pendingInteractionProviderOriginSchema.optional()
});
var approvalPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable()
});
var userQuestionPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable()
});
var pluginExtensionPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema.nullable()
});
var providerPendingInteractionSchema = z8.union([
  approvalPendingInteractionSchema,
  userQuestionPendingInteractionSchema,
  pluginExtensionPendingInteractionSchema
]);
var pluginPendingInteractionSchema = pendingInteractionBaseSchema.extend({
  turnId: z8.string().min(1).nullable(),
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema,
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pendingInteractionSchema = z8.union([
  providerPendingInteractionSchema,
  pluginPendingInteractionSchema
]);
var interactionLifecycleRecordBaseSchema = z8.object({
  id: z8.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z8.string().nullable()
});
var interactionLifecycleProviderOriginSchema = z8.object({
  kind: z8.literal("provider"),
  providerId: z8.string().min(1),
  providerRequestId: z8.string().min(1)
});
var approvalInteractionLifecycleRecordPayloadSchema = approvalPendingInteractionPayloadSchema.omit({ availableDecisions: true });
var approvalInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: approvalInteractionLifecycleRecordPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable()
});
var userQuestionInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable()
});
var pluginInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema.omit({ data: true }),
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pluginExtensionInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: pluginExtensionInteractionRequestPayloadSchema.omit({
    data: true
  }),
  resolution: pluginExtensionInteractionResolutionSchema.omit({ value: true }).nullable()
});
var interactionLifecycleSchema = z8.union([
  approvalInteractionLifecycleSchema,
  userQuestionInteractionLifecycleSchema,
  pluginInteractionLifecycleSchema,
  pluginExtensionInteractionLifecycleSchema
]);

// ../domain/src/protocol-ids.ts
import { z as z9 } from "zod";
var clientTurnRequestIdSchema = z9.string().regex(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);

// ../domain/src/system-message.ts
import { z as z10 } from "zod";
var systemMessageKindValues = [
  "ownership-assigned",
  "ownership-removed",
  "child-needs-attention",
  "child-completed",
  "child-failed",
  "child-interrupted",
  "child-outcome-batch",
  "tool-result-delivered",
  "unlabeled"
];
var systemMessageKindSchema = z10.enum(systemMessageKindValues);
var systemThreadInterruptedReasonSchema = z10.enum([
  "manual-stop",
  "host-daemon-restarted",
  "host-removed",
  "provider-turn-idle"
]);
var childThreadOutcomeSchema = z10.object({
  threadId: z10.string(),
  status: z10.enum(["completed", "failed", "interrupted"]),
  interruption: z10.object({
    reason: systemThreadInterruptedReasonSchema,
    cause: z10.literal("host-connection-lost").optional()
  }).optional()
});
var systemMessageSubjectSchema = z10.discriminatedUnion("kind", [
  z10.object({
    kind: z10.literal("thread"),
    threadId: z10.string(),
    threadName: z10.string(),
    outcomes: z10.array(childThreadOutcomeSchema).optional()
  }),
  z10.object({
    kind: z10.literal("thread-batch"),
    count: z10.number(),
    outcomes: z10.array(childThreadOutcomeSchema).optional()
  }),
  z10.object({
    kind: z10.literal("tool-call"),
    toolName: z10.string(),
    suppress: z10.boolean()
  })
]);

// ../domain/src/thread-events.ts
var systemEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/rejected",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/operation",
  "system/interaction/lifecycle",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
  "system/thread-provisioning",
  // Legacy persisted watchdog diagnostic; retained for read/decode/render
  // only, with no current producer.
  "system/provider-turn-watchdog"
];
var threadTurnInitiatorValues = ["user", "agent", "system"];
var threadTurnInitiatorSchema = z11.enum(threadTurnInitiatorValues);
var turnRequestOptionsSchema = recordedThreadExecutionOptionsSchema;
var turnRequestTargetSchema = z11.discriminatedUnion("kind", [
  z11.object({ kind: z11.literal("thread-start") }),
  z11.object({ kind: z11.literal("new-turn") }),
  z11.object({
    kind: z11.literal("auto"),
    expectedTurnId: z11.string().nullable()
  }),
  z11.object({
    kind: z11.literal("steer"),
    expectedTurnId: z11.string().nullable()
  })
]);
var clientTurnLifecycleEventDataSchema = z11.object({
  direction: z11.literal("outbound"),
  source: z11.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  request: z11.object({
    method: z11.enum(["thread/start", "turn/start"]),
    params: z11.record(z11.string(), z11.unknown())
  })
});
var turnRequestEventDataSchema = z11.object({
  direction: z11.literal("outbound"),
  requestId: clientTurnRequestIdSchema,
  // Retry provenance, written only when a `turn.failed` gate's retry row
  // dispatches. Both fields are present together or not at all: absence means
  // "this is an original dispatch", which is the overwhelmingly common case.
  // (Supersedes the pre-plugin `continuationOfRequestId` key, which the removed
  // core rate-limit recovery wrote and nothing ever read.)
  /** The original request this attempt re-submits, unchanged across attempts. */
  retryOfRequestId: clientTurnRequestIdSchema.optional(),
  /** Which attempt this is: 2 is the first retry of the original request. */
  retryAttempt: z11.number().int().min(2).optional(),
  source: z11.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  senderThreadId: z11.string().nullable(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
  input: z11.array(promptInputSchema),
  inputGroups: z11.array(z11.array(promptInputSchema).min(1)).min(1).optional(),
  target: turnRequestTargetSchema,
  request: z11.object({
    method: z11.enum(["thread/start", "turn/start"]),
    params: z11.record(z11.string(), z11.unknown())
  }),
  execution: turnRequestOptionsSchema
});
var turnRequestRejectedEventDataSchema = z11.object({
  requestId: clientTurnRequestIdSchema,
  reason: z11.string().min(1),
  message: z11.string().min(1)
});
var systemErrorEventDataSchema = z11.object({
  code: z11.string().optional(),
  message: z11.string(),
  detail: z11.string().optional()
});
var ownershipChangeOperationActionValues = [
  "assign",
  "release",
  "transfer"
];
var ownershipChangeOperationActionSchema = z11.enum(
  ownershipChangeOperationActionValues
);
var ownershipChangeOperationMetadataSchema = z11.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z11.string().nullable(),
  nextParentThreadTitle: z11.string().nullable(),
  previousParentThreadId: z11.string().nullable(),
  previousParentThreadTitle: z11.string().nullable()
});
var systemOperationEventDataSchema = z11.object({
  operation: z11.string(),
  status: z11.string(),
  message: z11.string(),
  operationId: z11.string(),
  metadata: z11.record(z11.string(), jsonValueSchema).optional()
});
var systemInteractionLifecycleEventDataSchema = z11.object({
  interaction: interactionLifecycleSchema
});
var systemPermissionGrantLifecycleEventDataSchema = z11.object({
  interactionId: z11.string(),
  providerId: z11.string(),
  providerRequestId: z11.string(),
  status: pendingInteractionStatusSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z11.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema
});
var systemUserQuestionLifecycleEventDataSchema = z11.object({
  interactionId: z11.string(),
  providerId: z11.string(),
  providerRequestId: z11.string(),
  status: pendingInteractionStatusSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z11.string().nullable().default(null),
  payload: userQuestionPendingInteractionPayloadSchema
});
var systemThreadInterruptedEventDataSchema = z11.object({
  reason: systemThreadInterruptedReasonSchema,
  cause: z11.literal("host-connection-lost").optional()
});
var provisioningTranscriptEntrySchema = z11.object({
  type: z11.enum(["step", "output"]),
  key: z11.string(),
  text: z11.string(),
  startedAt: z11.number().optional(),
  status: z11.enum(["started", "completed", "failed"]).optional(),
  metadata: z11.record(z11.string(), z11.unknown()).optional()
});
var systemThreadProvisioningStatusValues = [
  "active",
  "completed",
  "failed",
  "cancelled"
];
var systemThreadProvisioningStatusSchema = z11.enum(
  systemThreadProvisioningStatusValues
);
var systemThreadProvisioningEventDataSchema = z11.object({
  provisioningId: z11.string(),
  status: systemThreadProvisioningStatusSchema,
  environmentId: z11.string().nullable(),
  entries: z11.array(provisioningTranscriptEntrySchema)
});
var systemLegacyUserMessageEventDataSchema = z11.object({
  text: z11.string(),
  toolCallId: z11.string().optional(),
  turnId: z11.string().optional()
});
var systemProviderTurnWatchdogEventDataSchema = z11.object({
  reason: z11.literal("provider-turn-idle"),
  thresholdMs: z11.number().int().positive(),
  elapsedMs: z11.number().int().nonnegative(),
  activeTurnId: z11.string().min(1),
  activeTurnStartedAt: z11.number().int().nonnegative(),
  lastActivityEventSequence: z11.number().int().positive(),
  lastActivityEventType: z11.string().min(1),
  lastActivityEventAt: z11.number().int().nonnegative(),
  providerId: z11.string().min(1),
  providerThreadId: z11.string().min(1).nullable(),
  firedAt: z11.number().int().nonnegative()
});

// ../domain/src/thread-event-scope.ts
import { z as z12 } from "zod";
var threadEventScopeKindValues = ["thread", "turn"];
var threadEventScopeKindSchema = z12.enum(threadEventScopeKindValues);
var threadEventScopeSchema = z12.discriminatedUnion("kind", [
  z12.object({ kind: z12.literal("thread") }),
  z12.object({ kind: z12.literal("turn"), turnId: z12.string().min(1) })
]);
var threadEventScopePolicyValues = [
  "thread",
  "turn",
  "thread-or-turn"
];
var threadEventScopePolicySchema = z12.enum(threadEventScopePolicyValues);
var threadEventScopeDefinitionByType = {
  "thread/started": {
    policy: "thread",
    rationale: "Thread lifecycle event; it creates the thread timeline itself."
  },
  "thread/identity": {
    policy: "thread",
    rationale: "Thread metadata event; it identifies the provider thread outside turn chronology."
  },
  "turn/started": { policy: "turn" },
  "turn/completed": { policy: "turn" },
  "turn/input/accepted": { policy: "turn" },
  "thread/name/updated": {
    policy: "thread",
    rationale: "Thread metadata event; names are not part of a specific turn transcript."
  },
  "thread/compacted": { policy: "turn" },
  "thread/context/cleared": { policy: "turn" },
  "thread/goal/updated": {
    policy: "thread",
    rationale: "Thread goal state is current thread metadata, not part of a specific turn transcript."
  },
  "thread/goal/cleared": {
    policy: "thread",
    rationale: "Thread goal state is current thread metadata, not part of a specific turn transcript."
  },
  "item/started": { policy: "turn" },
  "item/completed": { policy: "turn" },
  "item/agentMessage/delta": { policy: "turn" },
  "item/commandExecution/outputDelta": { policy: "turn" },
  "item/fileChange/outputDelta": { policy: "turn" },
  "item/reasoning/summaryTextDelta": { policy: "turn" },
  "item/reasoning/textDelta": { policy: "turn" },
  "item/plan/delta": { policy: "turn" },
  "item/mcpToolCall/progress": { policy: "turn" },
  "item/toolCall/progress": { policy: "turn" },
  "item/backgroundTask/progress": {
    policy: "thread",
    rationale: "Background tasks outlive their spawning turn; thread scope keeps turn windows sequence-contiguous (late progress must not interleave into later turns' ranges)."
  },
  "item/backgroundTask/completed": {
    policy: "thread",
    rationale: "Terminal task state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range."
  },
  "item/delegation/progress": {
    policy: "thread",
    rationale: "Background delegations outlive their spawning turn exactly like background tasks; thread scope keeps turn windows sequence-contiguous."
  },
  "item/delegation/completed": {
    policy: "thread",
    rationale: "A background delegation's terminal state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range."
  },
  "thread/tokenUsage/updated": { policy: "turn" },
  "thread/contextWindowUsage/updated": {
    policy: "thread-or-turn",
    rationale: "Context usage is session state; providers can report it before, during, or after a turn."
  },
  "turn/plan/updated": { policy: "turn" },
  "turn/diff/updated": { policy: "turn" },
  "provider/error": {
    policy: "thread-or-turn",
    rationale: "Provider diagnostics use thread scope for provider setup/session failures; in-turn failures use turn scope."
  },
  "provider/rateLimits/updated": {
    policy: "thread",
    rationale: "Subscription usage is account-scoped state that can affect multiple turns and threads."
  },
  "provider.env-resolved": {
    policy: "thread",
    rationale: "Resolved provider environment is session state and can change between turns."
  },
  "thread/extensionState/updated": {
    policy: "thread",
    rationale: "Plugin-declared thread state is current thread metadata (like goals), not part of a specific turn transcript; latest snapshot per kind wins."
  },
  "provider/warning": {
    policy: "thread-or-turn",
    rationale: "Provider warnings use thread scope for config, deprecation, or global notices; turn-specific warnings use turn scope."
  },
  "provider/modelFallback": {
    policy: "thread-or-turn",
    rationale: "Provider model fallback signals can occur while a turn is active or at session scope before a turn is established."
  },
  "thread/execution/reported": {
    policy: "thread",
    rationale: "What the provider reports it runs with is session state, reported when a session is constructed, before or between turns."
  },
  "provider/unhandled": {
    policy: "thread-or-turn",
    rationale: "Unhandled provider events use thread scope only when no active turn context exists; in-turn unknown events use turn scope."
  },
  "client/thread/start": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it requests thread creation before any turn exists."
  },
  "client/turn/requested": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it records the request before provider turn acceptance."
  },
  "client/turn/rejected": {
    policy: "thread",
    rationale: "Client request rejection occurs before provider turn acceptance and identifies the request at thread scope."
  },
  "client/turn/start": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it records the start request before provider turn acceptance."
  },
  "system/error": {
    policy: "thread-or-turn",
    rationale: "System errors use thread scope for app, daemon, or session failures outside a turn; turn failures use turn scope."
  },
  "system/manager/user_message": {
    policy: "thread-or-turn",
    rationale: "Legacy persisted user-visible system messages may be thread-scoped for general updates or turn-scoped for in-turn updates."
  },
  "system/thread/interrupted": {
    policy: "thread",
    rationale: "Thread stop lifecycle event; it represents user interruption of the whole running thread."
  },
  "system/operation": {
    policy: "thread-or-turn",
    rationale: "Thread-management operations use thread scope outside provider turns; tool-owned operations use turn scope so the operation stays with the tool call that caused it."
  },
  "system/interaction/lifecycle": {
    policy: "thread-or-turn",
    rationale: "A provider interaction belongs to the turn that raised it; a plugin may raise one outside any turn."
  },
  "system/permissionGrant/lifecycle": { policy: "turn" },
  "system/userQuestion/lifecycle": { policy: "turn" },
  "system/thread-provisioning": {
    policy: "thread",
    rationale: "Workspace provisioning lifecycle event; environment setup belongs to the thread, not a turn."
  },
  "system/provider-turn-watchdog": {
    policy: "thread",
    rationale: "Legacy persisted watchdog diagnostics are decoded for old timelines only; there is no current producer."
  }
};
function getThreadEventScopePolicyDefinitionEntries() {
  return Object.entries(threadEventScopeDefinitionByType).map(
    ([type, definition]) => ({
      type,
      definition
    })
  );
}
function buildThreadEventScopePolicyByType() {
  const policies = {};
  for (const entry of getThreadEventScopePolicyDefinitionEntries()) {
    policies[entry.type] = entry.definition.policy;
  }
  return policies;
}
var threadEventScopePolicyByType = buildThreadEventScopePolicyByType();
function threadScope() {
  return { kind: "thread" };
}
function turnScope(turnId) {
  return { kind: "turn", turnId };
}
function getThreadEventScopeTurnId(scope) {
  return scope.kind === "turn" ? scope.turnId : void 0;
}
function validateThreadEventScope(args) {
  const policy = threadEventScopePolicyByType[args.type];
  if (policy === "thread-or-turn") {
    return { valid: true };
  }
  if (policy !== args.scope.kind) {
    return {
      valid: false,
      message: `${args.type} requires ${policy} scope but received ${args.scope.kind} scope`
    };
  }
  return { valid: true };
}

// ../domain/src/thread-timeline-goal.ts
import { z as z13 } from "zod";
var threadTimelineGoalStatusSchema = z13.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete"
]);
var threadTimelineGoalSchema = z13.object({
  sourceSeq: z13.number().int().nonnegative(),
  updatedAt: z13.number(),
  objective: z13.string(),
  status: threadTimelineGoalStatusSchema,
  tokenBudget: z13.number().nullable(),
  tokensUsed: z13.number(),
  timeUsedSeconds: z13.number()
});

// ../domain/src/provider-event.ts
var threadEventItemStatusSchema = z14.enum([
  "pending",
  "completed",
  "failed",
  "interrupted"
]);
var threadEventItemApprovalStatusSchema = z14.enum(["waiting_for_approval", "denied"]).nullable();
var threadEventTurnStatusSchema = z14.enum([
  "completed",
  "failed",
  "interrupted"
]);
var providerErrorCategoryValues = [
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown"
];
var providerErrorCategorySchema = z14.enum(providerErrorCategoryValues);
var providerErrorInfoSchema = z14.object({
  category: providerErrorCategorySchema,
  providerCode: z14.string().nullable(),
  httpStatusCode: z14.number().nullable()
});
var providerRateLimitStatusSchema = z14.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown"
]);
var providerRateLimitWindowSchema = z14.object({
  providerKey: z14.string().min(1).nullable(),
  label: z14.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z14.number().int().nonnegative().nullable()
});
var providerRateLimitStateSchema = z14.object({
  providerId: z14.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z14.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z14.array(providerRateLimitWindowSchema),
  reachedReason: z14.string().min(1).nullable(),
  overageStatus: z14.enum(["allowed", "warning", "rejected", "unavailable"]).nullable(),
  overageReason: z14.string().min(1).nullable()
});
var threadEventFileChangeKindSchema = z14.enum(["add", "delete", "update"]);
var threadEventFileChangeSchema = z14.object({
  path: z14.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z14.string().optional(),
  diff: z14.string().optional()
});
var threadEventPlanStepStatusSchema = z14.enum([
  "pending",
  "active",
  "completed",
  "failed"
]);
var threadEventPlanStepSchema = z14.object({
  step: z14.string(),
  status: threadEventPlanStepStatusSchema.optional()
});
var itemPresentationField = {
  presentation: threadEventItemPresentationSchema.optional()
};
var threadEventWebSearchItemSchema = z14.object({
  type: z14.literal("webSearch"),
  id: z14.string(),
  queries: z14.array(z14.string()).min(1),
  resultText: z14.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventWebFetchItemSchema = z14.object({
  type: z14.literal("webFetch"),
  id: z14.string(),
  url: z14.string(),
  prompt: z14.string().nullable(),
  pattern: z14.string().nullable(),
  resultText: z14.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventImageViewItemSchema = z14.object({
  type: z14.literal("imageView"),
  id: z14.string(),
  path: z14.string(),
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventFileReadItemSchema = z14.object({
  type: z14.literal("fileRead"),
  id: z14.string(),
  path: z14.string(),
  cmd: z14.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventSearchModeSchema = z14.enum(["content", "path", "list"]);
var threadEventSearchItemSchema = z14.object({
  type: z14.literal("search"),
  id: z14.string(),
  mode: threadEventSearchModeSchema,
  query: z14.string(),
  path: z14.string().optional(),
  cmd: z14.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventDelegationItemSchema = z14.object({
  type: z14.literal("delegation"),
  id: z14.string(),
  childRef: z14.string().min(1),
  label: z14.string(),
  status: threadEventItemStatusSchema,
  background: z14.boolean(),
  summary: z14.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventPlanStepsItemSchema = z14.object({
  type: z14.literal("planSteps"),
  id: z14.string(),
  steps: z14.array(threadEventPlanStepSchema),
  explanation: z14.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventExtensionItemSchema = z14.object({
  type: z14.literal("extension"),
  id: z14.string(),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
  status: threadEventItemStatusSchema,
  presentation: threadEventItemPresentationSchema,
  parentToolCallId: z14.string().optional()
});
var threadEventTextTruncationSchema = z14.object({
  originalLength: z14.number(),
  retainedHeadLength: z14.number(),
  retainedTailLength: z14.number(),
  truncatedAt: z14.number()
});
var threadEventItemTruncationSchema = z14.object({
  aggregatedOutput: threadEventTextTruncationSchema.optional(),
  result: threadEventTextTruncationSchema.optional(),
  resultText: threadEventTextTruncationSchema.optional()
});
var threadEventImageGenerationItemSchema = z14.object({
  type: z14.literal("imageGeneration"),
  id: z14.string(),
  status: threadEventItemStatusSchema,
  prompt: z14.string().nullable(),
  path: z14.string().nullable(),
  result: z14.string().optional(),
  error: z14.string().nullable(),
  transparentBackground: z14.boolean(),
  truncation: threadEventItemTruncationSchema.optional(),
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventUserContentSchema = z14.discriminatedUnion("type", [
  z14.object({ type: z14.literal("text"), text: z14.string() }),
  z14.object({ type: z14.literal("image"), url: z14.string() }),
  z14.object({ type: z14.literal("localImage"), path: z14.string() }),
  z14.object({ type: z14.literal("localFile"), path: z14.string() })
]);
var threadEventTokenUsageBreakdownSchema = z14.object({
  totalTokens: z14.number(),
  inputTokens: z14.number(),
  cachedInputTokens: z14.number(),
  cacheReadInputTokens: z14.number().nonnegative().optional(),
  cacheWriteInputTokens: z14.number().nonnegative().optional(),
  outputTokens: z14.number(),
  reasoningOutputTokens: z14.number()
});
var threadUsageCostSchema = z14.object({
  amount: z14.number().nonnegative(),
  currency: z14.string().min(1)
});
var threadEventContextWindowUsageSchema = z14.object({
  snapshot: contextSnapshotSchema.optional(),
  usedTokens: z14.number().nullable(),
  modelContextWindow: z14.number().nullable(),
  estimated: z14.boolean(),
  cost: threadUsageCostSchema.optional()
});
var threadEventTokenUsageSchema = z14.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z14.number().nullable()
});
var threadEventWarningCategorySchema = z14.enum([
  "deprecation",
  "config",
  "general",
  "compaction-skipped"
]);
var providerRawEventSchema = z14.object({
  jsonrpc: z14.literal("2.0"),
  id: z14.union([z14.string(), z14.number()]).optional(),
  method: z14.string(),
  params: jsonValueSchema.optional()
});
var providerUnhandledEventSchema = z14.object({
  type: z14.literal("provider/unhandled"),
  threadId: z14.string(),
  providerThreadId: z14.string(),
  providerId: z14.string(),
  rawType: z14.string(),
  rawEvent: providerRawEventSchema,
  parentToolCallId: z14.string().optional()
});
var toolCallProgressEventSchema = z14.object({
  type: z14.literal("item/toolCall/progress"),
  threadId: z14.string(),
  providerThreadId: z14.string(),
  itemId: z14.string(),
  message: z14.string().optional(),
  parentToolCallId: z14.string().optional()
});
var threadEventBackgroundTaskItemSchema = z14.object({
  type: z14.literal("backgroundTask"),
  id: z14.string(),
  familyId: z14.string().optional(),
  taskType: z14.string(),
  description: z14.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z14.boolean(),
  workflowName: z14.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z14.string().optional(),
  error: z14.string().optional(),
  outputFile: z14.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z14.string().optional()
});
var threadEventItemSchema = z14.discriminatedUnion("type", [
  z14.object({
    type: z14.literal("userMessage"),
    id: z14.string(),
    content: z14.array(threadEventUserContentSchema),
    clientRequestId: clientTurnRequestIdSchema.optional(),
    parentToolCallId: z14.string().optional()
  }).strict(),
  z14.object({
    type: z14.literal("agentMessage"),
    id: z14.string(),
    text: z14.string(),
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("commandExecution"),
    id: z14.string(),
    command: z14.string(),
    cwd: z14.string(),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    aggregatedOutput: z14.string().optional(),
    exitCode: z14.number().optional(),
    durationMs: z14.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("fileChange"),
    id: z14.string(),
    changes: z14.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  threadEventWebSearchItemSchema,
  threadEventWebFetchItemSchema,
  threadEventImageViewItemSchema,
  threadEventImageGenerationItemSchema,
  threadEventFileReadItemSchema,
  threadEventSearchItemSchema,
  z14.object({
    type: z14.literal("toolCall"),
    id: z14.string(),
    server: z14.string().optional(),
    tool: z14.string(),
    arguments: z14.record(z14.string(), z14.unknown()).optional(),
    status: threadEventItemStatusSchema,
    result: z14.unknown().optional(),
    error: z14.string().optional(),
    durationMs: z14.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("reasoning"),
    id: z14.string(),
    summary: z14.array(z14.string()),
    content: z14.array(z14.string()),
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("plan"),
    id: z14.string(),
    text: z14.string(),
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  threadEventPlanStepsItemSchema,
  z14.object({
    type: z14.literal("contextCompaction"),
    id: z14.string(),
    ...itemPresentationField,
    parentToolCallId: z14.string().optional()
  }),
  threadEventBackgroundTaskItemSchema,
  threadEventDelegationItemSchema,
  threadEventExtensionItemSchema
]);
function itemTextDeltaEventSchema(type) {
  return z14.object({
    type: z14.literal(type),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    itemId: z14.string(),
    delta: z14.string(),
    parentToolCallId: z14.string().optional()
  });
}
var unscopedProviderEventSchema = z14.discriminatedUnion("type", [
  z14.object({
    type: z14.literal("thread/started"),
    threadId: z14.string()
  }),
  z14.object({
    type: z14.literal("thread/identity"),
    threadId: z14.string(),
    providerThreadId: z14.string()
  }),
  z14.object({
    type: z14.literal("turn/started"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    parentToolCallId: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("turn/completed"),
    threadId: z14.string(),
    providerThreadId: z14.string().nullable(),
    status: threadEventTurnStatusSchema,
    error: z14.object({ message: z14.string() }).optional(),
    providerCheckpointId: z14.string().min(1).optional()
  }),
  z14.object({
    type: z14.literal("turn/input/accepted"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    clientRequestId: clientTurnRequestIdSchema,
    scope: threadEventScopeSchema
  }).strict(),
  z14.object({
    type: z14.literal("thread/name/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    threadName: z14.string(),
    source: z14.literal("agent").optional()
  }),
  z14.object({
    type: z14.literal("thread/compacted"),
    threadId: z14.string(),
    providerThreadId: z14.string()
  }),
  z14.object({
    type: z14.literal("thread/context/cleared"),
    threadId: z14.string(),
    providerThreadId: z14.string()
  }),
  z14.object({
    type: z14.literal("thread/goal/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    objective: z14.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z14.number().nullable(),
    tokensUsed: z14.number(),
    timeUsedSeconds: z14.number()
  }),
  z14.object({
    type: z14.literal("thread/goal/cleared"),
    threadId: z14.string(),
    providerThreadId: z14.string()
  }),
  z14.object({
    type: z14.literal("item/started"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    item: threadEventItemSchema
  }),
  z14.object({
    type: z14.literal("item/completed"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    item: threadEventItemSchema
  }),
  itemTextDeltaEventSchema("item/agentMessage/delta"),
  z14.object({
    type: z14.literal("item/commandExecution/outputDelta"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    itemId: z14.string(),
    delta: z14.string(),
    reset: z14.boolean().optional(),
    parentToolCallId: z14.string().optional()
  }),
  itemTextDeltaEventSchema("item/fileChange/outputDelta"),
  itemTextDeltaEventSchema("item/reasoning/summaryTextDelta"),
  itemTextDeltaEventSchema("item/reasoning/textDelta"),
  itemTextDeltaEventSchema("item/plan/delta"),
  z14.object({
    type: z14.literal("item/mcpToolCall/progress"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    itemId: z14.string(),
    message: z14.string().optional(),
    parentToolCallId: z14.string().optional()
  }),
  toolCallProgressEventSchema,
  z14.object({
    type: z14.literal("item/backgroundTask/progress"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z14.object({
    type: z14.literal("item/backgroundTask/completed"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z14.object({
    type: z14.literal("item/delegation/progress"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    item: threadEventDelegationItemSchema
  }),
  z14.object({
    type: z14.literal("item/delegation/completed"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    item: threadEventDelegationItemSchema
  }),
  z14.object({
    type: z14.literal("thread/tokenUsage/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    tokenUsage: threadEventTokenUsageSchema
  }),
  z14.object({
    type: z14.literal("thread/contextWindowUsage/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    contextWindowUsage: threadEventContextWindowUsageSchema
  }),
  z14.object({
    type: z14.literal("turn/plan/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    plan: z14.array(threadEventPlanStepSchema),
    explanation: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("turn/diff/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    diff: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("provider/error"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    message: z14.string(),
    detail: z14.string().optional(),
    willRetry: z14.boolean().optional(),
    errorInfo: providerErrorInfoSchema.optional()
  }),
  z14.object({
    type: z14.literal("provider/rateLimits/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    rateLimits: providerRateLimitStateSchema
  }),
  z14.object({
    type: z14.literal("provider.env-resolved"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    entries: z14.array(
      z14.object({
        name: z14.string(),
        source: z14.union([
          z14.literal("shell"),
          z14.object({ plugin: z14.string() }).strict(),
          z14.object({
            core: z14.enum([
              "machine-git",
              "machine-environment",
              "project-environment"
            ])
          }).strict()
        ]),
        value: z14.union([
          z14.string(),
          z14.object({ masked: z14.literal(true) }).strict()
        ]),
        reason: z14.string().optional()
      }).strict()
    )
  }),
  z14.object({
    type: z14.literal("thread/extensionState/updated"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    kind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z14.object({
    type: z14.literal("provider/warning"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    category: threadEventWarningCategorySchema,
    summary: z14.string().optional(),
    details: z14.string().optional()
  }),
  z14.object({
    type: z14.literal("provider/modelFallback"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    originalModel: z14.string().min(1),
    fallbackModel: z14.string().min(1),
    reason: z14.enum(["refusal", "provider"]),
    message: z14.string()
  }),
  z14.object({
    type: z14.literal("thread/execution/reported"),
    threadId: z14.string(),
    providerThreadId: z14.string(),
    execution: threadExecutionReportSchema
  }),
  providerUnhandledEventSchema
]);
var scopedEventDataSchema = z14.object({
  scope: threadEventScopeSchema
});
var providerEventSchema = unscopedProviderEventSchema.and(
  scopedEventDataSchema
);
var providerEventTypeValues = unscopedProviderEventSchema.options.map(
  (option) => option.shape.type.value
);
var unscopedSystemEventSchema = z14.discriminatedUnion("type", [
  z14.object({
    type: z14.literal("client/thread/start"),
    threadId: z14.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z14.object({
    type: z14.literal("client/turn/requested"),
    threadId: z14.string()
  }).merge(turnRequestEventDataSchema),
  z14.object({
    type: z14.literal("client/turn/rejected"),
    threadId: z14.string()
  }).merge(turnRequestRejectedEventDataSchema),
  z14.object({
    type: z14.literal("client/turn/start"),
    threadId: z14.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z14.object({
    type: z14.literal("system/error"),
    threadId: z14.string()
  }).merge(systemErrorEventDataSchema),
  z14.object({
    type: z14.literal("system/manager/user_message"),
    threadId: z14.string()
  }).merge(systemLegacyUserMessageEventDataSchema),
  z14.object({
    type: z14.literal("system/thread/interrupted"),
    threadId: z14.string()
  }).merge(systemThreadInterruptedEventDataSchema),
  z14.object({
    type: z14.literal("system/operation"),
    threadId: z14.string()
  }).merge(systemOperationEventDataSchema),
  z14.object({
    type: z14.literal("system/interaction/lifecycle"),
    threadId: z14.string()
  }).merge(systemInteractionLifecycleEventDataSchema),
  z14.object({
    type: z14.literal("system/permissionGrant/lifecycle"),
    threadId: z14.string()
  }).merge(systemPermissionGrantLifecycleEventDataSchema),
  z14.object({
    type: z14.literal("system/userQuestion/lifecycle"),
    threadId: z14.string()
  }).merge(systemUserQuestionLifecycleEventDataSchema),
  z14.object({
    type: z14.literal("system/thread-provisioning"),
    threadId: z14.string()
  }).merge(systemThreadProvisioningEventDataSchema),
  z14.object({
    type: z14.literal("system/provider-turn-watchdog"),
    threadId: z14.string()
  }).merge(systemProviderTurnWatchdogEventDataSchema)
]);
var systemEventSchema = unscopedSystemEventSchema.and(scopedEventDataSchema);
var threadEventSchema = z14.union([providerEventSchema, systemEventSchema]).superRefine((event, ctx) => {
  const result2 = validateThreadEventScope({
    type: event.type,
    scope: event.scope
  });
  if (!result2.valid) {
    ctx.addIssue({
      code: z14.ZodIssueCode.custom,
      message: result2.message ?? "Invalid thread event scope",
      path: ["scope"]
    });
    return;
  }
});
function isThreadEventWithItem(event) {
  switch (event.type) {
    case "item/started":
    case "item/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
      return true;
    default:
      return false;
  }
}
var threadEventTypeValues = [
  ...providerEventTypeValues,
  ...systemEventTypeValues
];
var threadEventTypeSet = new Set(threadEventTypeValues);
var threadEventTypeSchema = z14.string().refine(
  (value) => threadEventTypeSet.has(value),
  "Invalid thread event type"
);

// ../domain/src/plugin-icon.ts
var PLUGIN_ICON_MAX_BYTES = 32 * 1024;
var NAMESPACED_GLYPH_PATTERN = /^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/u;
function isNamespacedGlyph(glyph) {
  return NAMESPACED_GLYPH_PATTERN.test(glyph);
}
function parseNamespacedGlyph(glyph) {
  if (!isNamespacedGlyph(glyph)) {
    return null;
  }
  const separator = glyph.indexOf("/");
  return {
    pluginId: glyph.slice(0, separator),
    name: glyph.slice(separator + 1)
  };
}

// ../domain/src/thread-provider-state.ts
import { z as z15 } from "zod";
var THREAD_PROVIDER_COMMANDS_STATE_KIND = "bb/provider-commands";
var THREAD_SESSION_OPTIONS_STATE_KIND = "bb/session-options";
var threadProviderCommandSchema = z15.object({
  name: z15.string().min(1),
  description: z15.string(),
  inputHint: z15.string().min(1).optional()
});
var threadProviderCommandsStateSchema = z15.object({
  commands: z15.array(threadProviderCommandSchema).max(500)
});
var threadSessionOptionValueSchema = z15.object({
  id: z15.string().min(1),
  label: z15.string().min(1),
  description: z15.string().min(1).optional(),
  group: z15.string().min(1).optional()
});
var threadSessionOptionBaseShape = {
  id: z15.string().min(1),
  label: z15.string().min(1),
  description: z15.string().min(1).optional(),
  category: z15.string().min(1).optional()
};
var threadSessionOptionSchema = z15.discriminatedUnion("type", [
  z15.object({
    ...threadSessionOptionBaseShape,
    type: z15.literal("select"),
    value: z15.string(),
    values: z15.array(threadSessionOptionValueSchema).max(1e3)
  }),
  z15.object({
    ...threadSessionOptionBaseShape,
    type: z15.literal("boolean"),
    value: z15.boolean(),
    fixed: z15.boolean().optional()
  })
]);
var threadSessionOptionsStateSchema = z15.object({
  options: z15.array(threadSessionOptionSchema).max(64)
});
var threadSessionOptionSelectionsStateSchema = z15.object({
  selections: sessionOptionSelectionsSchema
});
var CORE_THREAD_STATE_SCHEMAS = {
  [THREAD_PROVIDER_COMMANDS_STATE_KIND]: threadProviderCommandsStateSchema,
  [THREAD_SESSION_OPTIONS_STATE_KIND]: threadSessionOptionsStateSchema
};

// ../domain/src/provider-fork.ts
import { z as z16 } from "zod";
var PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"];
var providerForkSchema = z16.enum(PROVIDER_FORK_VALUES);

// ../domain/src/provider-types.ts
import { z as z17 } from "zod";
var modelReasoningEffortSchema = z17.object({
  reasoningEffort: reasoningLevelSchema,
  label: z17.string().min(1).optional(),
  description: z17.string()
});
var modelServiceTierSchema = z17.object({
  id: serviceTierSchema,
  label: z17.string().min(1).optional(),
  description: z17.string().min(1).optional()
});
var availableModelSchema = z17.object({
  id: z17.string(),
  model: z17.string(),
  displayName: z17.string(),
  routeProviderId: z17.string().min(1).optional(),
  description: z17.string(),
  supportedReasoningEfforts: z17.array(modelReasoningEffortSchema),
  defaultReasoningEffort: reasoningLevelSchema,
  supportedServiceTiers: z17.array(modelServiceTierSchema).optional(),
  sessionOptions: z17.array(threadSessionOptionSchema).max(64).optional(),
  isDefault: z17.boolean()
});
var providerModelCatalogScopeSchema = z17.enum(["host", "workspace"]);
var providerCapabilitiesSchema = z17.object({
  supportsThreadArchive: z17.boolean(),
  supportsThreadRename: z17.boolean(),
  supportsServiceTier: z17.boolean(),
  supportsNativeUserQuestion: z17.boolean(),
  supportsFork: z17.boolean(),
  supportsSessionRewind: z17.boolean(),
  permissionModes: z17.array(permissionModeSchema).min(1),
  modelCatalogScope: providerModelCatalogScopeSchema,
  reportsTokenUsage: z17.boolean().optional(),
  supportsNativeTerminal: z17.boolean().optional()
});
var providerComposerCommandSchema = z17.object({
  trigger: promptMentionCommandTriggerSchema,
  name: z17.string().min(1).regex(/^[^\s/$]+$/u),
  trailingText: z17.string().regex(/^\s*$/u)
});
var providerComposerActionSchema = z17.discriminatedUnion("kind", [
  z17.object({
    kind: z17.literal("skills"),
    trigger: promptMentionCommandTriggerSchema
  }),
  z17.object({
    kind: z17.literal("plan"),
    command: providerComposerCommandSchema
  }),
  z17.object({
    kind: z17.literal("goal"),
    command: providerComposerCommandSchema
  })
]);
var providerStringsSchema = z17.object({
  signInHint: z17.string().min(1),
  expiredHint: z17.string().min(1),
  installUrl: z17.string().min(1),
  brandPrefix: z17.string().min(1).optional(),
  planModeCopy: z17.string().min(1).optional(),
  iconTint: z17.object({ light: z17.string().min(1), dark: z17.string().min(1) }).optional()
});
var providerOptionDescriptorSchema = z17.object({
  id: z17.string().min(1),
  label: z17.string().min(1),
  description: z17.string().min(1).optional()
});
var providerExtensionKindInfoSchema = z17.object({
  item: z17.boolean(),
  state: z17.boolean()
});
var providerExtensionKindsSchema = z17.record(
  extensionKindSchema,
  providerExtensionKindInfoSchema
);
var providerInfoSchema = z17.object({
  id: z17.string(),
  pluginId: z17.string().min(1),
  displayName: z17.string(),
  family: z17.string().min(1).optional(),
  icon: z17.object({ glyph: z17.string().min(1) }).optional(),
  logoUrl: z17.string().min(1).nullable(),
  maintenance: z17.object({
    health: z17.boolean(),
    usage: z17.boolean(),
    installation: z17.boolean()
  }),
  capabilities: providerCapabilitiesSchema,
  composerActions: z17.array(providerComposerActionSchema),
  completedTurnDisplay: completedTurnDisplaySchema,
  available: z17.boolean(),
  strings: providerStringsSchema.optional(),
  serviceTiers: z17.array(providerOptionDescriptorSchema).optional(),
  reasoningLevels: z17.array(providerOptionDescriptorSchema).optional(),
  extensionKinds: providerExtensionKindsSchema.optional()
});
var providerRecoveryKindValues = [
  "sessionArchived",
  "authRequired",
  "restartRecommended",
  "staleTurn",
  "rateLimited"
];
var providerRecoveryKindSchema = z17.enum(providerRecoveryKindValues);
var toolCallOutputItemSchema = z17.discriminatedUnion("type", [
  z17.object({
    type: z17.literal("inputText"),
    text: z17.string()
  }),
  z17.object({
    type: z17.literal("inputImage"),
    imageUrl: z17.string()
  })
]);
var toolCallRequestSchema = z17.object({
  requestId: z17.union([z17.string().min(1), z17.number()]),
  threadId: z17.string().min(1),
  providerThreadId: z17.string().min(1),
  turnId: z17.string().min(1),
  callId: z17.string().min(1),
  tool: z17.string().min(1),
  arguments: z17.unknown().optional()
});
var toolCallResponseSchema = z17.object({
  contentItems: z17.array(toolCallOutputItemSchema),
  success: z17.boolean()
});
var dynamicToolSchema = z17.object({
  name: z17.string(),
  description: z17.string(),
  inputSchema: z17.unknown(),
  presentation: threadEventItemPresentationSchema.optional(),
  /** A tool awaiting a user-owned interaction may outlive turn completion. */
  waitsForUserInput: z17.boolean().optional()
});

// ../provider-bridge-protocol/src/thread-delta.ts
import { z as z18 } from "zod";
var THREAD_DELTA_NOTIFICATION_METHOD = "thread/delta";
var deltaPresentationSchema = threadEventItemPresentationSchema;
var THREAD_DELTA_KEY_SEPARATOR = "";
var deltaKeyPartSchema = z18.string().min(1).refine((value) => !value.includes(THREAD_DELTA_KEY_SEPARATOR), {
  message: "provider keys must not contain the internal key separator (\\u001f)"
});
var deltaItemKeySchema = z18.object({
  providerItemId: deltaKeyPartSchema.optional(),
  channel: deltaKeyPartSchema.optional(),
  parentRef: deltaKeyPartSchema.optional()
});
var providerTurnIdSchema = deltaKeyPartSchema;
var deltaFileChangeSchema = z18.object({
  path: z18.string(),
  kind: z18.enum(["add", "update", "delete"]),
  movePath: z18.string().optional(),
  diff: z18.string().optional(),
  oldText: z18.string().optional(),
  newText: z18.string().optional()
});
var deltaBackgroundTaskShapeSchema = z18.object({
  type: z18.literal("backgroundTask"),
  familyId: z18.string().min(1),
  taskType: z18.string(),
  description: z18.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z18.boolean(),
  workflowName: z18.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z18.string().optional(),
  error: z18.string().optional(),
  outputFile: z18.string().optional()
});
var deltaFileReadShapeSchema = z18.object({
  type: z18.literal("fileRead"),
  path: z18.string(),
  cmd: z18.string().optional()
});
var deltaSearchShapeSchema = z18.object({
  type: z18.literal("search"),
  mode: threadEventSearchModeSchema,
  query: z18.string(),
  path: z18.string().optional(),
  cmd: z18.string().optional()
});
var deltaDelegationShapeSchema = z18.object({
  type: z18.literal("delegation"),
  childRef: deltaKeyPartSchema,
  label: z18.string(),
  background: z18.boolean(),
  summary: z18.string().optional()
});
var deltaPlanStepsShapeSchema = z18.object({
  type: z18.literal("planSteps"),
  steps: z18.array(threadEventPlanStepSchema),
  explanation: z18.string().optional()
});
var deltaExtensionShapeSchema = z18.object({
  type: z18.literal("extension"),
  kind: extensionKindSchema,
  payload: jsonValueSchema
});
var deltaItemShapeSchema = z18.discriminatedUnion("type", [
  z18.object({
    type: z18.literal("command"),
    command: z18.string(),
    cwd: z18.string(),
    aggregatedOutput: z18.string().optional(),
    exitCode: z18.number().optional(),
    durationMs: z18.number().optional()
  }),
  z18.object({
    type: z18.literal("fileChange"),
    changes: z18.array(deltaFileChangeSchema)
  }),
  z18.object({
    type: z18.literal("tool"),
    tool: z18.string(),
    server: z18.string().optional(),
    args: z18.unknown().optional(),
    result: z18.unknown().optional(),
    error: z18.string().optional(),
    durationMs: z18.number().optional()
  }),
  z18.object({ type: z18.literal("compaction") }),
  z18.object({ type: z18.literal("agentMessage"), text: z18.string() }),
  z18.object({
    type: z18.literal("reasoning"),
    summary: z18.array(z18.string()),
    content: z18.array(z18.string())
  }),
  z18.object({ type: z18.literal("plan"), text: z18.string() }),
  z18.object({
    type: z18.literal("webSearch"),
    queries: z18.array(z18.string()).min(1)
  }),
  z18.object({
    type: z18.literal("webFetch"),
    url: z18.string(),
    prompt: z18.string().nullable().optional(),
    pattern: z18.string().nullable()
  }),
  z18.object({ type: z18.literal("imageView"), path: z18.string() }),
  z18.object({
    type: z18.literal("imageGeneration"),
    prompt: z18.string().nullable(),
    path: z18.string().nullable(),
    result: z18.string().optional(),
    error: z18.string().nullable(),
    transparentBackground: z18.boolean()
  }),
  deltaBackgroundTaskShapeSchema,
  deltaFileReadShapeSchema,
  deltaSearchShapeSchema,
  deltaDelegationShapeSchema,
  deltaPlanStepsShapeSchema,
  deltaExtensionShapeSchema
]);
var deltaProgressSnapshotSchema = z18.discriminatedUnion("type", [
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema
]);
var deltaTextChannelSchema = z18.enum([
  "agentMessage",
  "reasoningSummary",
  "reasoningText",
  "plan"
]);
var deltaOutputChannelSchema = z18.enum(["command", "fileChange"]);
var deltaErrorSchema = z18.object({ message: z18.string() });
var deltaAttachSchema = z18.enum(["open", "currentOrLast"]);
var deltaNoTurnFallbackSchema = z18.object({
  raw: providerRawEventSchema,
  rawType: z18.string()
});
function requireExtensionPresentation(delta, ctx) {
  if (delta.item.type === "extension" && delta.presentation === void 0) {
    ctx.addIssue({
      code: "custom",
      message: "extension items require a presentation on item.open/item.close",
      path: ["presentation"]
    });
  }
}
var threadDeltaSchema = z18.discriminatedUnion("kind", [
  z18.object({
    kind: z18.literal("input.accepted"),
    clientRequestId: clientTurnRequestIdSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z18.object({
    kind: z18.literal("input.provider"),
    text: z18.string().min(1),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z18.object({
    kind: z18.literal("turn.open"),
    providerTurnId: providerTurnIdSchema.optional(),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z18.object({
    kind: z18.literal("turn.boundary"),
    status: threadEventTurnStatusSchema,
    error: deltaErrorSchema.optional(),
    providerCheckpointId: z18.string().min(1).optional(),
    claimIfIdle: z18.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z18.object({
    kind: z18.literal("item.open"),
    key: deltaItemKeySchema,
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    attach: deltaAttachSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z18.object({
    kind: z18.literal("item.close"),
    key: deltaItemKeySchema,
    status: threadEventItemStatusSchema,
    resultText: z18.string().optional(),
    exitCode: z18.number().optional(),
    aggregatedOutput: z18.string().optional(),
    approvalStatus: z18.literal("denied").optional(),
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z18.object({
    kind: z18.literal("item.progress"),
    key: deltaItemKeySchema,
    message: z18.string().optional(),
    snapshot: deltaProgressSnapshotSchema.optional(),
    flush: z18.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z18.object({
    kind: z18.literal("item.textDelta"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z18.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z18.object({
    kind: z18.literal("item.textClose"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z18.string().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z18.object({
    kind: z18.literal("item.outputDelta"),
    key: deltaItemKeySchema,
    channel: deltaOutputChannelSchema,
    text: z18.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z18.object({
    kind: z18.literal("command.outputSnapshot"),
    key: deltaItemKeySchema,
    text: z18.string(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z18.object({
    kind: z18.literal("usage"),
    total: threadEventTokenUsageBreakdownSchema,
    last: threadEventTokenUsageBreakdownSchema,
    modelContextWindow: z18.number().nullable(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z18.object({
    kind: z18.literal("contextWindow"),
    snapshot: contextSnapshotSchema.optional(),
    used: z18.number().nullable(),
    size: z18.number().nullable().optional(),
    estimated: z18.boolean(),
    cost: threadUsageCostSchema.optional(),
    attach: deltaAttachSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z18.object({
    kind: z18.literal("context.compacted"),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z18.object({ kind: z18.literal("context.cleared") }),
  z18.object({
    kind: z18.literal("turn.diff"),
    diff: z18.string(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z18.object({ kind: z18.literal("thread.started") }),
  z18.object({
    kind: z18.literal("thread.identity"),
    providerThreadId: z18.string().min(1)
  }),
  z18.object({
    kind: z18.literal("thread.name"),
    name: z18.string().min(1),
    source: z18.literal("agent").optional()
  }),
  z18.object({
    kind: z18.literal("extension.state"),
    extensionKind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z18.object({
    kind: z18.literal("provider.rateLimits"),
    rateLimits: providerRateLimitStateSchema
  }),
  z18.object({
    kind: z18.literal("provider.error"),
    message: z18.string(),
    detail: z18.string().optional(),
    willRetry: z18.boolean().optional(),
    category: providerErrorCategorySchema.optional(),
    errorInfo: providerErrorInfoSchema.optional(),
    settlesTurn: z18.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    threadScoped: z18.boolean().optional()
  }),
  z18.object({
    kind: z18.literal("provider.modelFallback"),
    originalModel: z18.string().min(1),
    fallbackModel: z18.string().min(1),
    reason: z18.enum(["refusal", "provider"]),
    message: z18.string()
  }),
  z18.object({
    kind: z18.literal("thread.execution"),
    execution: threadExecutionReportSchema
  }),
  z18.object({
    kind: z18.literal("provider.warning"),
    summary: z18.string().optional(),
    details: z18.string().optional(),
    category: threadEventWarningCategorySchema.optional(),
    vouchedTurn: z18.boolean().optional()
  }),
  z18.object({
    kind: z18.literal("unhandled"),
    raw: providerRawEventSchema,
    rawType: z18.string(),
    vouchedTurn: z18.boolean(),
    onlyIfNoTurn: z18.boolean().optional(),
    parentRef: deltaKeyPartSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z18.object({ kind: z18.literal("session.ended") }),
  z18.object({ kind: z18.literal("session.reset") })
]);
var threadDeltaNotificationParamsSchema = z18.object({
  threadId: z18.string().min(1),
  deltas: z18.array(threadDeltaSchema)
}).passthrough();

// ../provider-bridge-protocol/src/assembler/delta-assembler.ts
import { randomUUID } from "node:crypto";

// ../provider-bridge-protocol/src/version.ts
var PROVIDER_BRIDGE_PROTOCOL_VERSION = 2;
var THREAD_DELTA_GRAMMAR_V3 = 3;

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
import { z as z20 } from "zod";

// ../provider-bridge-protocol/src/bridge-kit/tool-arg-schemas.ts
import { z as z19 } from "zod";
var bashArgsSchema = z19.object({
  command: z19.string().optional(),
  cwd: z19.string().optional()
}).passthrough();
var textBlockSchema = z19.object({
  type: z19.literal("text"),
  text: z19.string()
});

// ../provider-bridge-protocol/src/bridge-kit/provider-visibility-helpers.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
var contentWrapperSchema = z20.object({
  content: z20.array(z20.unknown())
}).passthrough();
var shellEnvironmentVariableKeySchema = z20.string().regex(/^[A-Z_][A-Z0-9_]*$/i);
var MAX_EXACT_LINE_DIFF_CELLS = 1e6;
function splitComparableLines(text) {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (normalized.length === 0) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
function commonPrefixLength(oldLines, newLines) {
  const limit = Math.min(oldLines.length, newLines.length);
  let index = 0;
  while (index < limit && oldLines[index] === newLines[index]) {
    index += 1;
  }
  return index;
}
function commonSuffixLength(args) {
  let oldIndex = args.oldLines.length - 1;
  let newIndex = args.newLines.length - 1;
  let length = 0;
  while (oldIndex >= args.prefixLength && newIndex >= args.prefixLength && args.oldLines[oldIndex] === args.newLines[newIndex]) {
    length += 1;
    oldIndex -= 1;
    newIndex -= 1;
  }
  return length;
}
function buildReplacementLineDiff(oldLines, newLines) {
  return [
    ...oldLines.map((line) => ({ type: "remove", line })),
    ...newLines.map((line) => ({ type: "add", line }))
  ];
}
function buildExactLineDiff(oldLines, newLines) {
  if (oldLines.length === 0) {
    return newLines.map((line) => ({ type: "add", line }));
  }
  if (newLines.length === 0) {
    return oldLines.map((line) => ({ type: "remove", line }));
  }
  const columnCount = newLines.length + 1;
  const cellCount = (oldLines.length + 1) * columnCount;
  if (cellCount > MAX_EXACT_LINE_DIFF_CELLS) {
    return buildReplacementLineDiff(oldLines, newLines);
  }
  const lcs = new Uint32Array(cellCount);
  for (let oldIndex2 = oldLines.length - 1; oldIndex2 >= 0; oldIndex2 -= 1) {
    const rowOffset = oldIndex2 * columnCount;
    const nextRowOffset = (oldIndex2 + 1) * columnCount;
    for (let newIndex2 = newLines.length - 1; newIndex2 >= 0; newIndex2 -= 1) {
      lcs[rowOffset + newIndex2] = oldLines[oldIndex2] === newLines[newIndex2] ? lcs[nextRowOffset + newIndex2 + 1] + 1 : Math.max(
        lcs[nextRowOffset + newIndex2],
        lcs[rowOffset + newIndex2 + 1]
      );
    }
  }
  const operations = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const removeScore = lcs[(oldIndex + 1) * columnCount + newIndex];
    const addScore = lcs[oldIndex * columnCount + newIndex + 1];
    if (removeScore >= addScore) {
      operations.push({ type: "remove", line: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      operations.push({ type: "add", line: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    operations.push({ type: "remove", line: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    operations.push({ type: "add", line: newLines[newIndex] ?? "" });
    newIndex += 1;
  }
  return operations;
}
function buildChangedLineDiff(oldLines, newLines) {
  const prefixLength = commonPrefixLength(oldLines, newLines);
  const suffixLength = commonSuffixLength({
    oldLines,
    newLines,
    prefixLength
  });
  const oldEnd = oldLines.length - suffixLength;
  const newEnd = newLines.length - suffixLength;
  return buildExactLineDiff(
    oldLines.slice(prefixLength, oldEnd),
    newLines.slice(prefixLength, newEnd)
  );
}
function formatLineDiff(args) {
  const body = args.operations.map(
    (operation) => operation.type === "add" ? `+${operation.line}` : `-${operation.line}`
  );
  return [...args.headers, ...body].join("\n") + "\n";
}
function buildEditDiff(filePath, oldString, newString) {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (oldString === void 0 && newString !== void 0) {
    return formatLineDiff({
      headers: ["--- /dev/null", `+++ b/${normalizedPath}`],
      operations: splitComparableLines(newString).map((line) => ({
        type: "add",
        line
      }))
    });
  }
  if (oldString !== void 0 && newString === void 0) {
    return formatLineDiff({
      headers: [`--- a/${normalizedPath}`, "+++ /dev/null"],
      operations: splitComparableLines(oldString).map((line) => ({
        type: "remove",
        line
      }))
    });
  }
  if (oldString !== void 0 && newString !== void 0) {
    const oldLines = splitComparableLines(oldString);
    const newLines = splitComparableLines(newString);
    const operations = buildChangedLineDiff(oldLines, newLines);
    if (operations.length === 0) {
      return void 0;
    }
    return formatLineDiff({
      headers: [`--- a/${normalizedPath}`, `+++ b/${normalizedPath}`],
      operations
    });
  }
  return void 0;
}
function toOptionalRecord(value) {
  return isRecord(value) ? value : void 0;
}
function withParentToolCallId(item, parentToolCallId) {
  if (!parentToolCallId) {
    return item;
  }
  return {
    ...item,
    parentToolCallId
  };
}

// ../provider-bridge-protocol/src/assembler/delta-assembler.ts
var ASSEMBLER_GRAMMAR_VERSIONS = [
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_GRAMMAR_V3
];
var UNSTAMPED_THREAD_ID = "";
function diffCumulativeText(args) {
  const previousText = args.previousText ?? "";
  if (args.nextText.length === 0 || args.nextText === previousText) {
    return null;
  }
  if (previousText.length === 0) {
    return { delta: args.nextText, nextText: args.nextText, reset: false };
  }
  if (args.nextText.startsWith(previousText)) {
    const delta = args.nextText.slice(previousText.length);
    return delta.length > 0 ? { delta, nextText: args.nextText, reset: false } : null;
  }
  return { delta: args.nextText, nextText: args.nextText, reset: true };
}
var MAX_THREAD_STATES = 256;
var MAX_ID_MAP_ENTRIES = 1024;
var MAX_SETTLED_ITEM_KEYS = 512;
function asTextDeltaEvent(event) {
  switch (event.type) {
    case "item/agentMessage/delta":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      return event;
    default:
      return void 0;
  }
}
function orderTurnStartsBeforeScopedEvents(events) {
  const firstEventByTurn = /* @__PURE__ */ new Map();
  const firstStartByTurn = /* @__PURE__ */ new Map();
  for (const [index, event] of events.entries()) {
    if (event.scope.kind !== "turn") {
      continue;
    }
    const key = JSON.stringify([event.threadId, event.scope.turnId]);
    firstEventByTurn.set(key, firstEventByTurn.get(key) ?? index);
    if (event.type === "turn/started") {
      firstStartByTurn.set(key, firstStartByTurn.get(key) ?? index);
    }
  }
  if (firstStartByTurn.size === 0) {
    return events;
  }
  const startsToMove = /* @__PURE__ */ new Set();
  const startAtFirstEvent = /* @__PURE__ */ new Map();
  for (const [key, startIndex] of firstStartByTurn) {
    const firstEventIndex = firstEventByTurn.get(key);
    if (firstEventIndex === void 0 || startIndex === firstEventIndex) {
      continue;
    }
    const start = events[startIndex];
    if (start !== void 0) {
      startsToMove.add(startIndex);
      startAtFirstEvent.set(firstEventIndex, start);
    }
  }
  if (startsToMove.size === 0) {
    return events;
  }
  const ordered = [];
  for (const [index, event] of events.entries()) {
    if (startsToMove.has(index)) {
      continue;
    }
    const start = startAtFirstEvent.get(index);
    if (start !== void 0) {
      ordered.push(start);
    }
    ordered.push(event);
  }
  return ordered;
}
var SEP = THREAD_DELTA_KEY_SEPARATOR;
function itemKeyString(key) {
  return [
    key.providerItemId ?? "",
    key.channel ?? "",
    key.parentRef ?? ""
  ].join(SEP);
}
function withPresentation(item, presentation) {
  if (presentation === void 0 || item.type === "userMessage") {
    return item;
  }
  return { ...item, presentation };
}
function presentationOf(item) {
  return item !== void 0 && "presentation" in item ? item.presentation : void 0;
}
function trimOldestEntries(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      return;
    }
    map.delete(oldest.value);
  }
}
function createDeltaAssembler(options) {
  const entropyPrefix = options.entropyPrefix ?? `da${randomUUID().slice(0, 8)}`;
  const progressThrottleMs = options.progressThrottleMs ?? 500;
  const textDeltaFlushMs = options.textDeltaFlushMs ?? 100;
  const now = options.now ?? Date.now;
  let turnCounter = 0;
  let itemCounter = 0;
  const states = /* @__PURE__ */ new Map();
  function mintTurnId() {
    turnCounter += 1;
    return `${entropyPrefix}-t${turnCounter}`;
  }
  function mintItemId() {
    itemCounter += 1;
    return `${entropyPrefix}-i${itemCounter}`;
  }
  function stateFor(threadId) {
    const existing = states.get(threadId);
    if (existing) {
      states.delete(threadId);
      states.set(threadId, existing);
      return existing;
    }
    const created = {
      currentTurnId: void 0,
      lastTurnId: void 0,
      pendingAccepted: [],
      openItemsByKey: /* @__PURE__ */ new Map(),
      commandSnapshotsByKey: /* @__PURE__ */ new Map(),
      bbItemIdByProviderItemId: /* @__PURE__ */ new Map(),
      providerItemIdByBbItemId: /* @__PURE__ */ new Map(),
      bbTurnIdByProviderTurnId: /* @__PURE__ */ new Map(),
      providerTurnIdByBbTurnId: /* @__PURE__ */ new Map(),
      settledItemKeys: /* @__PURE__ */ new Set(),
      progressLastEmitByKey: /* @__PURE__ */ new Map(),
      pendingProgressByKey: /* @__PURE__ */ new Map(),
      textLastEmitByStream: /* @__PURE__ */ new Map(),
      pendingTextByStream: /* @__PURE__ */ new Map()
    };
    states.set(threadId, created);
    pruneIdleStates();
    return created;
  }
  function pruneIdleStates() {
    while (states.size > MAX_THREAD_STATES) {
      let removed = false;
      for (const [threadId, state] of states) {
        if (state.currentTurnId !== void 0 || state.openItemsByKey.size > 0 || state.pendingAccepted.length > 0 || state.pendingTextByStream.size > 0) {
          continue;
        }
        states.delete(threadId);
        removed = true;
        break;
      }
      if (!removed) {
        return;
      }
    }
  }
  function registerItemId(state, providerItemId, bbItemId) {
    state.bbItemIdByProviderItemId.set(providerItemId, bbItemId);
    state.providerItemIdByBbItemId.set(bbItemId, providerItemId);
    trimOldestEntries(state.bbItemIdByProviderItemId, MAX_ID_MAP_ENTRIES);
    trimOldestEntries(state.providerItemIdByBbItemId, MAX_ID_MAP_ENTRIES);
  }
  function resolveVouchedTurnId(state, providerTurnId) {
    const existing = state.bbTurnIdByProviderTurnId.get(providerTurnId);
    if (existing !== void 0) {
      return existing;
    }
    const bbTurnId = mintTurnId();
    state.bbTurnIdByProviderTurnId.set(providerTurnId, bbTurnId);
    state.providerTurnIdByBbTurnId.set(bbTurnId, providerTurnId);
    trimOldestEntries(state.bbTurnIdByProviderTurnId, MAX_ID_MAP_ENTRIES);
    trimOldestEntries(state.providerTurnIdByBbTurnId, MAX_ID_MAP_ENTRIES);
    return bbTurnId;
  }
  function rememberProgressEmit(state, key) {
    state.progressLastEmitByKey.set(key, now());
    trimOldestEntries(state.progressLastEmitByKey, MAX_ID_MAP_ENTRIES);
  }
  function flushElapsedPendingProgress(state, events, skipKeys) {
    if (state.pendingProgressByKey.size === 0) {
      return;
    }
    const nowMs = now();
    for (const [key, pending] of [...state.pendingProgressByKey]) {
      if (skipKeys.has(key)) {
        continue;
      }
      const last = state.progressLastEmitByKey.get(key);
      if (last !== void 0 && nowMs - last < progressThrottleMs) {
        continue;
      }
      state.pendingProgressByKey.delete(key);
      state.progressLastEmitByKey.set(key, nowMs);
      events.push(pending.event);
    }
  }
  function flushPendingText(state, out) {
    if (state.pendingTextByStream.size === 0) {
      return;
    }
    const nowMs = now();
    for (const [streamKey, pending] of state.pendingTextByStream) {
      out.push({ ...pending.event, delta: pending.text });
      state.textLastEmitByStream.set(streamKey, nowMs);
    }
    state.pendingTextByStream.clear();
    trimOldestEntries(state.textLastEmitByStream, MAX_ID_MAP_ENTRIES);
  }
  function flushElapsedPendingText(state, out) {
    const nowMs = now();
    for (const streamKey of state.pendingTextByStream.keys()) {
      const last = state.textLastEmitByStream.get(streamKey);
      if (last === void 0 || nowMs - last >= textDeltaFlushMs) {
        flushPendingText(state, out);
        return;
      }
    }
  }
  function bufferTextDelta(state, event, out) {
    const streamKey = `${event.type}${SEP}${event.itemId}`;
    if (event.type === "item/commandExecution/outputDelta" && event.reset === true) {
      flushPendingText(state, out);
      out.push(event);
      state.textLastEmitByStream.set(streamKey, now());
      trimOldestEntries(state.textLastEmitByStream, MAX_ID_MAP_ENTRIES);
      return;
    }
    const last = state.textLastEmitByStream.get(streamKey);
    if (last === void 0) {
      flushPendingText(state, out);
      out.push(event);
      state.textLastEmitByStream.set(streamKey, now());
      trimOldestEntries(state.textLastEmitByStream, MAX_ID_MAP_ENTRIES);
      return;
    }
    const pending = state.pendingTextByStream.get(streamKey);
    if (now() - last >= textDeltaFlushMs) {
      if (pending === void 0) {
        state.pendingTextByStream.set(streamKey, { event, text: event.delta });
      } else {
        pending.text += event.delta;
      }
      flushPendingText(state, out);
      return;
    }
    if (pending === void 0) {
      state.pendingTextByStream.set(streamKey, { event, text: event.delta });
      return;
    }
    pending.text += event.delta;
  }
  function rememberSettledKey(state, key) {
    state.settledItemKeys.add(key);
    while (state.settledItemKeys.size > MAX_SETTLED_ITEM_KEYS) {
      const oldest = state.settledItemKeys.values().next();
      if (oldest.done === true) {
        return;
      }
      state.settledItemKeys.delete(oldest.value);
    }
  }
  function mapParentRef(state, parentRef) {
    if (parentRef === void 0) {
      return void 0;
    }
    const existing = state.bbItemIdByProviderItemId.get(parentRef);
    if (existing !== void 0) {
      return existing;
    }
    const bbItemId = mintItemId();
    registerItemId(state, parentRef, bbItemId);
    return bbItemId;
  }
  function ensureTurnOpen(state, events) {
    if (state.currentTurnId !== void 0) {
      return state.currentTurnId;
    }
    const turnId = mintTurnId();
    state.currentTurnId = turnId;
    events.push({
      type: "turn/started",
      threadId: UNSTAMPED_THREAD_ID,
      providerThreadId: "",
      scope: turnScope(turnId)
    });
    while (state.pendingAccepted.length > 0) {
      const clientRequestId = state.pendingAccepted.shift();
      if (clientRequestId === void 0) {
        break;
      }
      events.push({
        type: "turn/input/accepted",
        threadId: UNSTAMPED_THREAD_ID,
        providerThreadId: "",
        scope: turnScope(turnId),
        clientRequestId
      });
    }
    return turnId;
  }
  function finishTurn(state) {
    state.lastTurnId = state.currentTurnId ?? state.lastTurnId;
    state.currentTurnId = void 0;
    for (const [key, open] of [...state.openItemsByKey]) {
      if (!open.threadAttached) {
        state.openItemsByKey.delete(key);
      }
    }
    for (const [key, pending] of [...state.pendingProgressByKey]) {
      if (pending.turnScoped) {
        state.pendingProgressByKey.delete(key);
      }
    }
    state.commandSnapshotsByKey.clear();
  }
  function currentOrLastTurnId(state) {
    return state.currentTurnId ?? state.lastTurnId;
  }
  function buildFileChanges(shape) {
    return shape.changes.map((change) => {
      const diff = change.diff ?? (change.newText === void 0 ? void 0 : buildEditDiff(change.path, change.oldText, change.newText));
      return {
        path: change.path,
        kind: change.kind,
        ...change.movePath === void 0 ? {} : { movePath: change.movePath },
        ...diff ? { diff } : {}
      };
    });
  }
  function shapeMatchesItem(shape, item) {
    switch (shape.type) {
      case "command":
        return item.type === "commandExecution";
      case "fileChange":
        return item.type === "fileChange";
      case "tool":
        return item.type === "toolCall";
      case "compaction":
        return item.type === "contextCompaction";
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "webSearch":
      case "webFetch":
      case "imageView":
      case "imageGeneration":
      case "backgroundTask":
      case "fileRead":
      case "search":
      case "delegation":
      case "planSteps":
        return item.type === shape.type;
      case "extension":
        return item.type === "extension" && item.kind === shape.kind;
    }
  }
  function buildBackgroundTaskItem(bbItemId, shape, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "backgroundTask",
        id: bbItemId,
        familyId: shape.familyId,
        taskType: shape.taskType,
        description: shape.description,
        status: shape.status,
        taskStatus: shape.taskStatus,
        skipTranscript: shape.skipTranscript,
        ...shape.workflowName === void 0 ? {} : { workflowName: shape.workflowName },
        ...shape.workflow === void 0 ? {} : { workflow: shape.workflow },
        ...shape.usage === void 0 ? {} : { usage: shape.usage },
        ...shape.summary === void 0 ? {} : { summary: shape.summary },
        ...shape.error === void 0 ? {} : { error: shape.error },
        ...shape.outputFile === void 0 ? {} : { outputFile: shape.outputFile }
      },
      parentToolCallId
    );
  }
  function buildFileReadItem(bbItemId, shape, status, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "fileRead",
        id: bbItemId,
        path: shape.path,
        ...shape.cmd === void 0 ? {} : { cmd: shape.cmd },
        status
      },
      parentToolCallId
    );
  }
  function buildSearchItem(bbItemId, shape, status, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "search",
        id: bbItemId,
        mode: shape.mode,
        query: shape.query,
        ...shape.path === void 0 ? {} : { path: shape.path },
        ...shape.cmd === void 0 ? {} : { cmd: shape.cmd },
        status
      },
      parentToolCallId
    );
  }
  function buildDelegationItem(bbItemId, shape, status, parentToolCallId, fallbackSummary) {
    const summary = shape.summary ?? fallbackSummary;
    return withParentToolCallId(
      {
        type: "delegation",
        id: bbItemId,
        childRef: shape.childRef,
        label: shape.label,
        status,
        background: shape.background,
        ...summary === void 0 ? {} : { summary }
      },
      parentToolCallId
    );
  }
  function buildExtensionItem(bbItemId, shape, status, parentToolCallId, presentation) {
    if (presentation === void 0) {
      throw new Error(
        `extension item "${shape.kind}" reached the assembler without a presentation`
      );
    }
    return withParentToolCallId(
      {
        type: "extension",
        id: bbItemId,
        kind: shape.kind,
        payload: shape.payload,
        status,
        presentation
      },
      parentToolCallId
    );
  }
  function buildPlanStepsItem(bbItemId, shape, status, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "planSteps",
        id: bbItemId,
        steps: shape.steps,
        ...shape.explanation === void 0 ? {} : { explanation: shape.explanation },
        status
      },
      parentToolCallId
    );
  }
  function isThreadAttachedShape(shape) {
    switch (shape.type) {
      case "backgroundTask":
        return true;
      case "delegation":
        return shape.background;
      case "command":
      case "fileChange":
      case "tool":
      case "compaction":
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "webSearch":
      case "webFetch":
      case "imageView":
      case "imageGeneration":
      case "fileRead":
      case "search":
      case "planSteps":
      case "extension":
        return false;
    }
  }
  function buildOpenedItem(bbItemId, shape, parentToolCallId, presentation) {
    return withPresentation(
      buildOpenedItemShape(bbItemId, shape, parentToolCallId, presentation),
      presentation
    );
  }
  function buildOpenedItemShape(bbItemId, shape, parentToolCallId, presentation) {
    switch (shape.type) {
      case "command":
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: bbItemId,
            command: shape.command,
            cwd: shape.cwd,
            ...shape.aggregatedOutput === void 0 ? {} : { aggregatedOutput: shape.aggregatedOutput },
            ...shape.exitCode === void 0 ? {} : { exitCode: shape.exitCode },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs },
            status: "pending",
            approvalStatus: null
          },
          parentToolCallId
        );
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: bbItemId,
            changes: buildFileChanges(shape),
            status: "pending",
            approvalStatus: null
          },
          parentToolCallId
        );
      case "tool": {
        const toolArguments = toOptionalRecord(shape.args);
        return withParentToolCallId(
          {
            type: "toolCall",
            id: bbItemId,
            ...shape.server === void 0 ? {} : { server: shape.server },
            tool: shape.tool,
            ...toolArguments ? { arguments: toolArguments } : {},
            status: "pending",
            ...shape.result === void 0 ? {} : { result: shape.result },
            ...shape.error === void 0 ? {} : { error: shape.error },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs }
          },
          parentToolCallId
        );
      }
      case "compaction":
        return withParentToolCallId(
          { type: "contextCompaction", id: bbItemId },
          parentToolCallId
        );
      case "agentMessage":
        return withParentToolCallId(
          { type: "agentMessage", id: bbItemId, text: shape.text },
          parentToolCallId
        );
      case "reasoning":
        return withParentToolCallId(
          {
            type: "reasoning",
            id: bbItemId,
            summary: shape.summary,
            content: shape.content
          },
          parentToolCallId
        );
      case "plan":
        return withParentToolCallId(
          { type: "plan", id: bbItemId, text: shape.text },
          parentToolCallId
        );
      case "webSearch":
        return withParentToolCallId(
          {
            type: "webSearch",
            id: bbItemId,
            queries: shape.queries,
            resultText: null
          },
          parentToolCallId
        );
      case "webFetch":
        return withParentToolCallId(
          {
            type: "webFetch",
            id: bbItemId,
            url: shape.url,
            prompt: shape.prompt ?? null,
            pattern: shape.pattern,
            resultText: null
          },
          parentToolCallId
        );
      case "imageView":
        return withParentToolCallId(
          { type: "imageView", id: bbItemId, path: shape.path },
          parentToolCallId
        );
      case "imageGeneration":
        return withParentToolCallId(
          {
            type: "imageGeneration",
            id: bbItemId,
            status: "pending",
            prompt: shape.prompt,
            path: shape.path,
            ...shape.result === void 0 ? {} : { result: shape.result },
            error: shape.error,
            transparentBackground: shape.transparentBackground
          },
          parentToolCallId
        );
      case "backgroundTask":
        return buildBackgroundTaskItem(bbItemId, shape, parentToolCallId);
      case "fileRead":
        return buildFileReadItem(bbItemId, shape, "pending", parentToolCallId);
      case "search":
        return buildSearchItem(bbItemId, shape, "pending", parentToolCallId);
      case "delegation":
        return buildDelegationItem(
          bbItemId,
          shape,
          "pending",
          parentToolCallId
        );
      case "planSteps":
        return buildPlanStepsItem(bbItemId, shape, "pending", parentToolCallId);
      case "extension":
        return buildExtensionItem(
          bbItemId,
          shape,
          "pending",
          parentToolCallId,
          presentation
        );
    }
  }
  function completeStartedItem(started, close, parentToolCallId) {
    const parent = parentToolCallId ?? started.parentToolCallId;
    switch (started.type) {
      case "commandExecution":
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: started.id,
            command: started.command,
            cwd: started.cwd,
            ...close.aggregatedOutput === void 0 ? {} : { aggregatedOutput: close.aggregatedOutput },
            ...close.exitCode === void 0 ? {} : { exitCode: close.exitCode },
            status: close.status,
            approvalStatus: started.approvalStatus
          },
          parent
        );
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: started.id,
            changes: started.changes,
            status: close.status,
            approvalStatus: started.approvalStatus
          },
          parent
        );
      case "toolCall":
        return withParentToolCallId(
          {
            type: "toolCall",
            id: started.id,
            tool: started.tool,
            ...started.arguments === void 0 ? {} : { arguments: started.arguments },
            status: close.status,
            ...close.resultText === void 0 ? {} : { result: close.resultText }
          },
          parent
        );
      case "contextCompaction":
        return withParentToolCallId(
          { type: "contextCompaction", id: started.id },
          parent
        );
      case "imageGeneration":
        return withParentToolCallId(
          {
            ...started,
            status: close.status
          },
          parent
        );
      case "fileRead":
        return buildFileReadItem(started.id, started, close.status, parent);
      case "search":
        return buildSearchItem(started.id, started, close.status, parent);
      case "delegation":
        return buildDelegationItem(started.id, started, close.status, parent);
      case "planSteps":
        return buildPlanStepsItem(started.id, started, close.status, parent);
      case "extension":
        return buildExtensionItem(
          started.id,
          started,
          close.status,
          parent,
          started.presentation
        );
      default:
        return started;
    }
  }
  function buildClosedItemFromShape(bbItemId, shape, close, parentToolCallId, presentation) {
    return withPresentation(
      buildClosedItemShape(
        bbItemId,
        shape,
        close,
        parentToolCallId,
        presentation
      ),
      presentation
    );
  }
  function buildClosedItemShape(bbItemId, shape, close, parentToolCallId, presentation) {
    switch (shape.type) {
      case "command": {
        const aggregatedOutput = close.aggregatedOutput ?? shape.aggregatedOutput;
        const exitCode = close.exitCode ?? shape.exitCode;
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: bbItemId,
            command: shape.command,
            cwd: shape.cwd,
            ...aggregatedOutput === void 0 ? {} : { aggregatedOutput },
            ...exitCode === void 0 ? {} : { exitCode },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs },
            status: close.status,
            approvalStatus: close.approvalStatus ?? null
          },
          parentToolCallId
        );
      }
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: bbItemId,
            changes: buildFileChanges(shape),
            status: close.status,
            approvalStatus: close.approvalStatus ?? null
          },
          parentToolCallId
        );
      case "tool": {
        const toolArguments = toOptionalRecord(shape.args);
        const result2 = shape.result ?? close.resultText;
        return withParentToolCallId(
          {
            type: "toolCall",
            id: bbItemId,
            ...shape.server === void 0 ? {} : { server: shape.server },
            tool: shape.tool,
            ...toolArguments ? { arguments: toolArguments } : {},
            status: close.status,
            ...result2 === void 0 ? {} : { result: result2 },
            ...shape.error === void 0 ? {} : { error: shape.error },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs }
          },
          parentToolCallId
        );
      }
      case "compaction":
        return withParentToolCallId(
          { type: "contextCompaction", id: bbItemId },
          parentToolCallId
        );
      case "webSearch":
        return withParentToolCallId(
          {
            type: "webSearch",
            id: bbItemId,
            queries: shape.queries,
            resultText: close.resultText ?? null
          },
          parentToolCallId
        );
      case "webFetch":
        return withParentToolCallId(
          {
            type: "webFetch",
            id: bbItemId,
            url: shape.url,
            prompt: shape.prompt ?? null,
            pattern: shape.pattern,
            resultText: close.resultText ?? null
          },
          parentToolCallId
        );
      case "imageGeneration":
        return withParentToolCallId(
          {
            type: "imageGeneration",
            id: bbItemId,
            status: close.status,
            prompt: shape.prompt,
            path: shape.path,
            ...shape.result === void 0 ? {} : { result: shape.result },
            error: shape.error,
            transparentBackground: shape.transparentBackground
          },
          parentToolCallId
        );
      case "backgroundTask":
        return buildBackgroundTaskItem(bbItemId, shape, parentToolCallId);
      case "fileRead":
        return buildFileReadItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId
        );
      case "search":
        return buildSearchItem(bbItemId, shape, close.status, parentToolCallId);
      case "delegation":
        return buildDelegationItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId,
          close.delegationSummary
        );
      case "planSteps":
        return buildPlanStepsItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId
        );
      case "extension":
        return buildExtensionItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId,
          presentation
        );
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "imageView":
        return buildOpenedItemShape(
          bbItemId,
          shape,
          parentToolCallId,
          presentation
        );
    }
  }
  function pushNoTurnFallback(state, fallback, parentRef, events) {
    if (fallback === void 0) {
      return;
    }
    const parentToolCallId = mapParentRef(state, parentRef);
    events.push({
      type: "provider/unhandled",
      threadId: UNSTAMPED_THREAD_ID,
      providerThreadId: "",
      providerId: options.providerId,
      rawType: fallback.rawType,
      rawEvent: fallback.raw,
      scope: threadScope(),
      ...parentToolCallId === void 0 ? {} : { parentToolCallId }
    });
  }
  function detachAssistantStreams(state, parentRef) {
    for (const [keyStr, open] of [...state.openItemsByKey]) {
      if (open.key.providerItemId === void 0 && open.item.type === "agentMessage" && open.key.parentRef === parentRef) {
        state.openItemsByKey.delete(keyStr);
      }
    }
  }
  function settleTextItem(open, finalText, channel) {
    const text = channel === "reasoningSummary" ? open.text : finalText ?? open.text;
    const summaryText = channel === "reasoningSummary" ? finalText ?? open.summaryText : open.summaryText;
    switch (open.item.type) {
      case "agentMessage":
        return withPresentation(
          withParentToolCallId(
            { type: "agentMessage", id: open.bbItemId, text },
            open.item.parentToolCallId
          ),
          open.item.presentation
        );
      case "plan":
        return withPresentation(
          withParentToolCallId(
            { type: "plan", id: open.bbItemId, text },
            open.item.parentToolCallId
          ),
          open.item.presentation
        );
      case "reasoning":
        return withPresentation(
          withParentToolCallId(
            {
              type: "reasoning",
              id: open.bbItemId,
              summary: summaryText.length === 0 ? [] : [summaryText],
              content: text.length === 0 ? [] : [text]
            },
            open.item.parentToolCallId
          ),
          open.item.presentation
        );
      default:
        return void 0;
    }
  }
  function buildTextItemForChannel(bbItemId, channel, text, parentToolCallId) {
    switch (channel) {
      case "agentMessage":
        return withParentToolCallId(
          { type: "agentMessage", id: bbItemId, text },
          parentToolCallId
        );
      case "plan":
        return withParentToolCallId(
          { type: "plan", id: bbItemId, text },
          parentToolCallId
        );
      case "reasoningText":
        return withParentToolCallId(
          { type: "reasoning", id: bbItemId, summary: [], content: [text] },
          parentToolCallId
        );
      case "reasoningSummary":
        return withParentToolCallId(
          { type: "reasoning", id: bbItemId, summary: [text], content: [] },
          parentToolCallId
        );
    }
  }
  function handleDelta(state, delta, events) {
    switch (delta.kind) {
      case "input.accepted": {
        if (delta.providerTurnId !== void 0) {
          events.push({
            type: "turn/input/accepted",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(resolveVouchedTurnId(state, delta.providerTurnId)),
            clientRequestId: delta.clientRequestId
          });
          return;
        }
        if (state.currentTurnId !== void 0) {
          events.push({
            type: "turn/input/accepted",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(state.currentTurnId),
            clientRequestId: delta.clientRequestId
          });
          return;
        }
        state.pendingAccepted.push(delta.clientRequestId);
        return;
      }
      case "input.provider": {
        if (state.currentTurnId === void 0) {
          return;
        }
        const parentToolCallId = mapParentRef(state, delta.parentRef);
        events.push({
          type: "item/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(state.currentTurnId),
          item: {
            type: "userMessage",
            id: mintItemId(),
            content: [{ type: "text", text: delta.text }],
            ...parentToolCallId === void 0 ? {} : { parentToolCallId }
          }
        });
        return;
      }
      case "turn.open": {
        if (delta.providerTurnId !== void 0) {
          const parentToolCallId = mapParentRef(state, delta.parentRef);
          events.push({
            type: "turn/started",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(resolveVouchedTurnId(state, delta.providerTurnId)),
            ...parentToolCallId === void 0 ? {} : { parentToolCallId }
          });
          return;
        }
        ensureTurnOpen(state, events);
        return;
      }
      case "turn.boundary": {
        if (delta.providerTurnId !== void 0) {
          events.push({
            type: "turn/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(resolveVouchedTurnId(state, delta.providerTurnId)),
            status: delta.status,
            ...delta.error === void 0 ? {} : { error: delta.error },
            ...delta.providerCheckpointId === void 0 ? {} : { providerCheckpointId: delta.providerCheckpointId }
          });
          return;
        }
        const turnId = state.currentTurnId ?? (delta.claimIfIdle === true && state.pendingAccepted.length > 0 ? ensureTurnOpen(state, events) : void 0);
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "turn/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          status: delta.status,
          ...delta.error === void 0 ? {} : { error: delta.error },
          ...delta.providerCheckpointId === void 0 ? {} : { providerCheckpointId: delta.providerCheckpointId }
        });
        finishTurn(state);
        return;
      }
      case "item.open": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.attach === "currentOrLast" ? currentOrLastTurnId(state) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        state.settledItemKeys.delete(keyStr);
        if (delta.item.type !== "compaction") {
          detachAssistantStreams(state, delta.key.parentRef);
        }
        const bbItemId = (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? mintItemId();
        if (delta.key.providerItemId !== void 0) {
          registerItemId(state, delta.key.providerItemId, bbItemId);
        }
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        const item = buildOpenedItem(
          bbItemId,
          delta.item,
          parentToolCallId,
          delta.presentation
        );
        state.openItemsByKey.set(keyStr, {
          bbItemId,
          key: delta.key,
          item,
          threadAttached: isThreadAttachedShape(delta.item),
          text: "",
          summaryText: ""
        });
        rememberProgressEmit(state, keyStr);
        events.push({
          type: "item/started",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          item
        });
        return;
      }
      case "item.close": {
        const threadScoped = isThreadAttachedShape(delta.item);
        const turnId = threadScoped ? void 0 : delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (!threadScoped && turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        if (delta.key.providerItemId !== void 0 && state.settledItemKeys.has(keyStr)) {
          return;
        }
        const open = state.openItemsByKey.get(keyStr);
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        const openDelegationSummary = open?.item.type === "delegation" ? open.item.summary : void 0;
        const closeFields = {
          status: delta.status,
          ...delta.resultText === void 0 ? {} : { resultText: delta.resultText },
          ...delta.exitCode === void 0 ? {} : { exitCode: delta.exitCode },
          ...delta.aggregatedOutput === void 0 ? {} : { aggregatedOutput: delta.aggregatedOutput },
          ...delta.approvalStatus === void 0 ? {} : { approvalStatus: delta.approvalStatus },
          ...openDelegationSummary === void 0 ? {} : { delegationSummary: openDelegationSummary }
        };
        if (open !== void 0 && turnId !== void 0 && !shapeMatchesItem(delta.item, open.item)) {
          events.push({
            type: "item/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item: withPresentation(
              completeStartedItem(open.item, closeFields, parentToolCallId),
              presentationOf(open.item)
            )
          });
        }
        const bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? mintItemId();
        if (delta.key.providerItemId !== void 0) {
          registerItemId(state, delta.key.providerItemId, bbItemId);
        }
        const presentation = delta.presentation ?? presentationOf(open?.item);
        const item = buildClosedItemFromShape(
          bbItemId,
          delta.item,
          closeFields,
          parentToolCallId ?? open?.item.parentToolCallId,
          presentation
        );
        state.openItemsByKey.delete(keyStr);
        state.commandSnapshotsByKey.delete(keyStr);
        state.pendingProgressByKey.delete(keyStr);
        state.progressLastEmitByKey.delete(keyStr);
        if (delta.key.providerItemId !== void 0) {
          rememberSettledKey(state, keyStr);
        }
        if (item.type === "backgroundTask") {
          events.push({
            type: "item/backgroundTask/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item
          });
          return;
        }
        if (item.type === "delegation" && item.background) {
          events.push({
            type: "item/delegation/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item
          });
          return;
        }
        if (turnId !== void 0) {
          events.push({
            type: "item/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item
          });
        }
        return;
      }
      case "item.progress": {
        const keyStr = itemKeyString(delta.key);
        const open = state.openItemsByKey.get(keyStr);
        const bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? delta.key.providerItemId ?? mintItemId();
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        let event;
        if (delta.snapshot?.type === "delegation") {
          event = {
            type: "item/delegation/progress",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item: withPresentation(
              buildDelegationItem(
                bbItemId,
                delta.snapshot,
                "pending",
                parentToolCallId ?? open?.item.parentToolCallId,
                open?.item.type === "delegation" ? open.item.summary : void 0
              ),
              presentationOf(open?.item)
            )
          };
        } else if (delta.snapshot !== void 0) {
          event = {
            type: "item/backgroundTask/progress",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item: buildBackgroundTaskItem(
              bbItemId,
              delta.snapshot,
              parentToolCallId
            )
          };
        } else {
          const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
          if (turnId === void 0) {
            pushNoTurnFallback(
              state,
              delta.noTurnFallback,
              delta.key.parentRef,
              events
            );
            return;
          }
          event = {
            type: "item/toolCall/progress",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            itemId: bbItemId,
            ...delta.message === void 0 ? {} : { message: delta.message },
            ...parentToolCallId === void 0 ? {} : { parentToolCallId }
          };
        }
        const lastEmit = state.progressLastEmitByKey.get(keyStr);
        if (delta.flush !== true && lastEmit !== void 0 && now() - lastEmit < progressThrottleMs) {
          state.pendingProgressByKey.set(keyStr, {
            event,
            turnScoped: delta.snapshot === void 0
          });
          return;
        }
        state.pendingProgressByKey.delete(keyStr);
        rememberProgressEmit(state, keyStr);
        events.push(event);
        return;
      }
      case "item.textDelta": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        const open = state.openItemsByKey.get(keyStr);
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        let bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0);
        if (bbItemId === void 0) {
          bbItemId = mintItemId();
          if (delta.key.providerItemId !== void 0) {
            registerItemId(state, delta.key.providerItemId, bbItemId);
          }
          const shape = delta.channel === "agentMessage" ? { type: "agentMessage", text: "" } : delta.channel === "plan" ? { type: "plan", text: "" } : { type: "reasoning", summary: [], content: [] };
          const item = buildOpenedItem(
            bbItemId,
            shape,
            parentToolCallId,
            void 0
          );
          state.openItemsByKey.set(keyStr, {
            bbItemId,
            key: delta.key,
            item,
            threadAttached: false,
            text: "",
            summaryText: ""
          });
          events.push({
            type: "item/started",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item
          });
        }
        const openText = state.openItemsByKey.get(keyStr);
        if (openText !== void 0) {
          if (delta.channel === "reasoningSummary") {
            openText.summaryText += delta.text;
          } else {
            openText.text += delta.text;
          }
        }
        const type = delta.channel === "agentMessage" ? "item/agentMessage/delta" : delta.channel === "reasoningSummary" ? "item/reasoning/summaryTextDelta" : delta.channel === "reasoningText" ? "item/reasoning/textDelta" : "item/plan/delta";
        events.push({
          type,
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          itemId: bbItemId,
          delta: delta.text,
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "item.textClose": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        if (delta.key.providerItemId !== void 0 && state.settledItemKeys.has(keyStr)) {
          return;
        }
        const open = state.openItemsByKey.get(keyStr);
        state.openItemsByKey.delete(keyStr);
        const accumulated = open === void 0 ? void 0 : delta.channel === "reasoningSummary" ? open.summaryText : open.text;
        const finalText = delta.text ?? accumulated;
        if (finalText === void 0 || finalText.length === 0) {
          return;
        }
        if (delta.text === void 0 && finalText.trim().length === 0) {
          return;
        }
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        let item = open === void 0 ? void 0 : settleTextItem(open, delta.text, delta.channel);
        let bbItemId = open?.bbItemId;
        if (item === void 0) {
          bbItemId = bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? mintItemId();
          item = buildTextItemForChannel(
            bbItemId,
            delta.channel,
            finalText,
            parentToolCallId ?? open?.item.parentToolCallId
          );
        }
        if (delta.key.providerItemId !== void 0 && bbItemId !== void 0) {
          registerItemId(state, delta.key.providerItemId, bbItemId);
          rememberSettledKey(state, keyStr);
        }
        events.push({
          type: "item/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          item
        });
        return;
      }
      case "item.outputDelta": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const open = state.openItemsByKey.get(itemKeyString(delta.key));
        let bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0);
        if (bbItemId === void 0) {
          bbItemId = mintItemId();
          if (delta.key.providerItemId !== void 0) {
            registerItemId(state, delta.key.providerItemId, bbItemId);
          }
        }
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        events.push({
          type: delta.channel === "command" ? "item/commandExecution/outputDelta" : "item/fileChange/outputDelta",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          itemId: bbItemId,
          delta: delta.text,
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "command.outputSnapshot": {
        if (state.currentTurnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        const open = state.openItemsByKey.get(keyStr);
        if (open === void 0) {
          return;
        }
        const diffed = diffCumulativeText({
          previousText: state.commandSnapshotsByKey.get(keyStr),
          nextText: delta.text
        });
        if (diffed === null) {
          return;
        }
        state.commandSnapshotsByKey.set(keyStr, diffed.nextText);
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        events.push({
          type: "item/commandExecution/outputDelta",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(state.currentTurnId),
          itemId: open.bbItemId,
          delta: diffed.delta,
          ...diffed.reset ? { reset: true } : {},
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "usage": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : currentOrLastTurnId(state);
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "thread/tokenUsage/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          tokenUsage: {
            total: { ...delta.total },
            last: { ...delta.last },
            modelContextWindow: delta.modelContextWindow
          }
        });
        return;
      }
      case "contextWindow": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.attach === "open" ? state.currentTurnId : currentOrLastTurnId(state);
        events.push({
          type: "thread/contextWindowUsage/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          contextWindowUsage: {
            usedTokens: delta.snapshot?.usedTokens ?? delta.used,
            modelContextWindow: delta.snapshot?.contextWindowTokens ?? delta.size ?? null,
            estimated: delta.snapshot?.estimated ?? delta.estimated,
            ...delta.snapshot ? { snapshot: delta.snapshot } : {},
            ...delta.cost ? { cost: delta.cost } : {}
          }
        });
        return;
      }
      case "context.compacted": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : currentOrLastTurnId(state);
        if (turnId === void 0) {
          pushNoTurnFallback(state, delta.noTurnFallback, void 0, events);
          return;
        }
        events.push({
          type: "thread/compacted",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId)
        });
        return;
      }
      case "context.cleared": {
        const turnId = currentOrLastTurnId(state);
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "thread/context/cleared",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId)
        });
        return;
      }
      case "provider.error": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.threadScoped === true ? void 0 : state.currentTurnId ?? (state.pendingAccepted.length > 0 ? ensureTurnOpen(state, events) : void 0);
        events.push({
          type: "provider/error",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          message: delta.message,
          ...delta.detail === void 0 ? {} : { detail: delta.detail },
          ...delta.willRetry === void 0 ? {} : { willRetry: delta.willRetry },
          ...delta.errorInfo === void 0 ? {} : { errorInfo: delta.errorInfo }
        });
        if (delta.settlesTurn === true && turnId !== void 0) {
          events.push({
            type: "turn/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            status: "failed"
          });
          finishTurn(state);
        }
        return;
      }
      case "provider.modelFallback": {
        const turnId = currentOrLastTurnId(state);
        events.push({
          type: "provider/modelFallback",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          originalModel: delta.originalModel,
          fallbackModel: delta.fallbackModel,
          reason: delta.reason,
          message: delta.message
        });
        return;
      }
      case "thread.execution": {
        events.push({
          type: "thread/execution/reported",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          execution: { ...delta.execution }
        });
        return;
      }
      case "provider.warning": {
        const turnId = delta.vouchedTurn === true ? state.currentTurnId : void 0;
        events.push({
          type: "provider/warning",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          category: delta.category ?? "general",
          ...delta.summary === void 0 ? {} : { summary: delta.summary },
          ...delta.details === void 0 ? {} : { details: delta.details }
        });
        return;
      }
      case "unhandled": {
        if (delta.onlyIfNoTurn === true && state.currentTurnId !== void 0) {
          return;
        }
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.vouchedTurn === true ? state.currentTurnId : void 0;
        const parentToolCallId = mapParentRef(state, delta.parentRef);
        events.push({
          type: "provider/unhandled",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          providerId: options.providerId,
          rawType: delta.rawType,
          rawEvent: delta.raw,
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "turn.diff": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "turn/diff/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          diff: delta.diff
        });
        return;
      }
      case "thread.started": {
        events.push({
          type: "thread/started",
          threadId: UNSTAMPED_THREAD_ID,
          scope: threadScope()
        });
        return;
      }
      case "thread.identity": {
        events.push({
          type: "thread/identity",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: delta.providerThreadId,
          scope: threadScope()
        });
        return;
      }
      case "thread.name": {
        events.push({
          type: "thread/name/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          threadName: delta.name,
          ...delta.source === void 0 ? {} : { source: delta.source }
        });
        return;
      }
      case "provider.rateLimits": {
        events.push({
          type: "provider/rateLimits/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          rateLimits: delta.rateLimits
        });
        return;
      }
      case "extension.state": {
        events.push({
          type: "thread/extensionState/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          kind: delta.extensionKind,
          payload: delta.payload
        });
        return;
      }
      case "session.reset": {
        return;
      }
      case "session.ended": {
        const turnId = state.currentTurnId ?? (state.pendingAccepted.length > 0 ? ensureTurnOpen(state, events) : void 0);
        if (turnId === void 0) {
          return;
        }
        for (const open of state.openItemsByKey.values()) {
          if (open.threadAttached) {
            continue;
          }
          const streamed = open.text.length > 0 || open.summaryText.length > 0;
          const item = (streamed ? settleTextItem(open, void 0, void 0) : void 0) ?? completeStartedItem(
            open.item,
            { status: "interrupted" },
            void 0
          );
          events.push({
            type: "item/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item
          });
        }
        events.push({
          type: "turn/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          status: "interrupted"
        });
        finishTurn(state);
        return;
      }
    }
  }
  return {
    assemble(args) {
      const events = [];
      const sink = {
        push: (...newEvents) => {
          for (const event of newEvents) {
            const textDelta = textDeltaFlushMs > 0 ? asTextDeltaEvent(event) : void 0;
            const state = states.get(args.threadId);
            if (textDelta !== void 0 && state !== void 0) {
              bufferTextDelta(state, textDelta, events);
              continue;
            }
            if (state !== void 0) {
              flushPendingText(state, events);
            }
            events.push(event);
          }
        }
      };
      const existing = args.deltas[0]?.kind === "session.reset" ? void 0 : states.get(args.threadId);
      if (existing !== void 0) {
        flushElapsedPendingText(existing, events);
        const progressKeysInBatch = /* @__PURE__ */ new Set();
        for (const delta of args.deltas) {
          if (delta.kind === "item.progress") {
            progressKeysInBatch.add(itemKeyString(delta.key));
          }
        }
        flushElapsedPendingProgress(existing, sink, progressKeysInBatch);
      }
      for (const delta of args.deltas) {
        if (delta.kind === "session.reset") {
          const state = states.get(args.threadId);
          if (state !== void 0) {
            flushPendingText(state, events);
          }
          states.delete(args.threadId);
          continue;
        }
        if (delta.kind === "item.textClose" || delta.kind === "item.close" || delta.kind === "session.ended") {
          const state = states.get(args.threadId);
          if (state !== void 0) {
            flushPendingText(state, events);
          }
        }
        handleDelta(stateFor(args.threadId), delta, sink);
      }
      return orderTurnStartsBeforeScopedEvents(events);
    },
    seedOpenTurn(args) {
      const state = stateFor(args.threadId);
      state.currentTurnId = args.bbTurnId;
      if (args.providerTurnId !== null) {
        state.bbTurnIdByProviderTurnId.set(args.providerTurnId, args.bbTurnId);
        state.providerTurnIdByBbTurnId.set(args.bbTurnId, args.providerTurnId);
      }
    },
    hasPendingOutput() {
      for (const state of states.values()) {
        if (state.pendingTextByStream.size > 0 || state.pendingProgressByKey.size > 0) {
          return true;
        }
      }
      return false;
    },
    flushPending() {
      const flushed = [];
      for (const [threadId, state] of states) {
        const events = [];
        flushPendingText(state, events);
        for (const [key, pending] of state.pendingProgressByKey) {
          events.push(pending.event);
          state.progressLastEmitByKey.set(key, now());
        }
        state.pendingProgressByKey.clear();
        if (events.length > 0) flushed.push({ threadId, events });
      }
      return flushed;
    },
    getBbItemId(threadId, providerItemId) {
      return states.get(threadId)?.bbItemIdByProviderItemId.get(providerItemId);
    },
    getProviderItemId(threadId, bbItemId) {
      return states.get(threadId)?.providerItemIdByBbItemId.get(bbItemId);
    },
    getBbTurnId(threadId, providerTurnId) {
      return states.get(threadId)?.bbTurnIdByProviderTurnId.get(providerTurnId);
    },
    getProviderTurnId(threadId, bbTurnId) {
      return states.get(threadId)?.providerTurnIdByBbTurnId.get(bbTurnId);
    },
    getOpenTurnId(threadId) {
      return states.get(threadId)?.currentTurnId;
    }
  };
}

// ../provider-bridge-protocol/src/testing/bridge-delta-assembly.ts
function createBridgeDeltaEventCollector(providerId = "pi") {
  const assembler = createDeltaAssembler({
    providerId,
    textDeltaFlushMs: 0,
    now: () => 0
  });
  return {
    assembler,
    assembleMessage(message) {
      if (message.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        return [];
      }
      const parsed = threadDeltaNotificationParamsSchema.safeParse(
        message.params
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid thread/delta notification: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(
            "; "
          )} (params: ${JSON.stringify(message.params)?.slice(0, 400)})`
        );
      }
      return assembler.assemble({
        threadId: parsed.data.threadId,
        deltas: parsed.data.deltas
      });
    }
  };
}
function assembleCapturedThreadEvents(messages, providerId = "pi") {
  const collector = createBridgeDeltaEventCollector(providerId);
  return messages.flatMap((message) => collector.assembleMessage(message));
}

// ../provider-bridge-protocol/src/conformance/client.ts
import { z as z21 } from "zod";
function isWireMessage(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var threadDeltaAddressSchema = z21.object({ threadId: z21.string() }).passthrough();
var ConformanceClient = class {
  constructor(transport, timeoutMs, collector) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.collector = collector;
  }
  transport;
  timeoutMs;
  collector;
  nextId = 1;
  log = [];
  events = [];
  drainIntoLog() {
    for (const raw of this.transport.takeMessages()) {
      if (!isWireMessage(raw)) {
        continue;
      }
      const logIndex = this.log.length;
      this.log.push(raw);
      if (raw.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        continue;
      }
      const events = this.collector.assembleMessage(raw);
      const address = threadDeltaAddressSchema.parse(raw.params);
      for (const event of events) {
        this.events.push({ threadId: address.threadId, event, logIndex });
      }
    }
  }
  sendRaw(line) {
    this.transport.send(line);
  }
  notify(method, params) {
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...params !== void 0 ? { params } : {}
      })
    );
  }
  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...params !== void 0 ? { params } : {}
      })
    );
    return id;
  }
  async waitFor(resolve3) {
    const deadline = Date.now() + this.timeoutMs;
    for (; ; ) {
      this.drainIntoLog();
      const value = resolve3();
      if (value !== void 0) {
        return value;
      }
      if (Date.now() > deadline) {
        return null;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async waitForResponse(id) {
    return this.waitFor(
      () => this.log.find(
        (message) => message.id === id && message.method === void 0
      )
    );
  }
  async settle(quietMs) {
    const deadline = Date.now() + quietMs;
    while (Date.now() < deadline) {
      this.drainIntoLog();
      await new Promise((r) => setTimeout(r, 15));
    }
    this.drainIntoLog();
  }
  responsesFor(id) {
    return this.log.filter(
      (message) => message.id === id && message.method === void 0
    );
  }
  notifications(method) {
    return this.log.filter(
      (message) => message.id === void 0 && typeof message.method === "string" && (method === void 0 || message.method === method)
    );
  }
};
var clientRequestCounter = 0;
function nextConformanceClientRequestId() {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  clientRequestCounter += 1;
  let remaining = clientRequestCounter;
  let suffix = "";
  while (suffix.length < 10) {
    suffix = alphabet[remaining % alphabet.length] + suffix;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return `creq_${suffix}`;
}

// ../provider-bridge-protocol/src/conformance/scenarios.ts
import { z as z29 } from "zod";

// ../provider-bridge-protocol/src/handshake.ts
import { z as z22 } from "zod";
var bridgeGrammarVersionsSchema = z22.tuple([z22.number().int().positive(), z22.number().int().positive()]).refine(([min, max]) => min <= max, {
  message: "grammarVersions must be an ascending [min, max] range"
});
function negotiateGrammarVersion(runtime, bridge) {
  const min = Math.max(runtime[0], bridge[0]);
  const max = Math.min(runtime[1], bridge[1]);
  return min <= max ? max : null;
}
var bridgeSteerModeSchema = z22.enum(["inject", "queue"]);
var bridgeCapabilitiesSchema = z22.object({
  sessionRestore: z22.boolean().default(false),
  threadArchive: z22.boolean().default(false),
  threadRename: z22.boolean().default(false),
  threadGoalClear: z22.boolean().default(false),
  fork: providerForkSchema.default("none"),
  approvalEnforcedBy: z22.enum(["runtime", "provider"]).default("runtime"),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ]),
  steerMode: bridgeSteerModeSchema.default("queue"),
  skills: z22.object({ configure: z22.boolean().default(false) }).default({ configure: false })
}).passthrough();
var initializeParamsSchema = z22.object({
  protocolVersion: z22.number().int().positive(),
  client: z22.object({ name: z22.string().min(1), version: z22.string().min(1) }),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ])
}).passthrough();
var initializeResultSchema = z22.object({
  protocolVersion: z22.number().int().positive(),
  capabilities: z22.preprocess(
    (value) => value ?? {},
    bridgeCapabilitiesSchema
  )
}).passthrough();

// ../provider-bridge-protocol/src/execution-options.ts
import { z as z23 } from "zod";
var bridgeExecutionOptionsSchema = z23.object({
  model: z23.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  instructions: z23.string().optional(),
  envVars: z23.record(z23.string(), z23.string()).optional(),
  providerOptions: z23.record(z23.string(), z23.unknown()).optional()
}).and(runtimePermissionPolicySchema);

// ../provider-bridge-protocol/src/provider-maintenance.ts
import { z as z24 } from "zod";
var providerMaintenanceParamsSchema = z24.object({
  providerId: z24.string().min(1),
  cwd: z24.string().min(1).optional(),
  providerOptions: z24.record(z24.string(), z24.unknown()).optional()
}).passthrough();
var providerInstallationRequirementSchema = z24.enum(["thread_rewind"]);
var providerInstallationStatusParamsSchema = providerMaintenanceParamsSchema.extend({
  requirement: providerInstallationRequirementSchema.optional(),
  checkUpdates: z24.boolean().default(true)
});
var providerHealthSchema = z24.object({
  status: z24.enum([
    "ready",
    "not_installed",
    "unauthenticated",
    "expired",
    "unsupported_version",
    "unknown"
  ]),
  statusMessage: z24.string().min(1).nullable(),
  accountEmail: z24.string().nullable(),
  planLabel: z24.string().min(1).nullable(),
  installedVersion: z24.string().min(1).nullable(),
  minimumSupportedVersion: z24.string().min(1).nullable(),
  canInstall: z24.boolean(),
  canUpdate: z24.boolean(),
  loginCommand: z24.string().min(1).nullable(),
  localLoginCommand: z24.string().min(1).nullable().optional()
}).passthrough();
var providerUsageWindowSchema = z24.object({
  label: z24.string().min(1),
  usedPercent: z24.number().min(0).max(100),
  resetsAt: z24.string().min(1).nullable(),
  cost: z24.object({
    usedUsdCents: z24.number().int().nonnegative(),
    limitUsdCents: z24.number().int().positive()
  }).optional()
}).passthrough();
var providerUsageSchema = z24.discriminatedUnion("status", [
  z24.object({
    status: z24.literal("ok"),
    accountEmail: z24.string().email().nullable(),
    planLabel: z24.string().min(1).nullable(),
    windows: z24.array(providerUsageWindowSchema)
  }).passthrough(),
  z24.object({ status: z24.literal("not_installed") }).passthrough(),
  z24.object({ status: z24.literal("unauthenticated") }).passthrough(),
  z24.object({ status: z24.literal("expired") }).passthrough(),
  z24.object({
    status: z24.literal("error"),
    message: z24.string().min(1),
    planLabel: z24.string().min(1).nullable().default(null),
    accountEmail: z24.string().nullable().default(null)
  }).passthrough()
]);
var providerHealthResultSchema = z24.discriminatedUnion("supported", [
  z24.object({ supported: z24.literal(false) }).passthrough(),
  z24.object({
    supported: z24.literal(true),
    health: providerHealthSchema
  }).passthrough()
]);
var providerUsageResultSchema = z24.discriminatedUnion("supported", [
  z24.object({ supported: z24.literal(false) }).passthrough(),
  z24.object({
    supported: z24.literal(true),
    usage: providerUsageSchema
  }).passthrough()
]);
var providerInstallationActionKindSchema = z24.enum([
  "install",
  "update"
]);
var providerInstallationActionSchema = z24.object({
  kind: providerInstallationActionKindSchema,
  label: z24.enum(["Install", "Update"]),
  command: z24.string().min(1)
}).passthrough();
var providerInstallationSourceSchema = z24.enum([
  "notInstalled",
  "npmGlobal",
  "external"
]);
var providerInstallationStatusSchema = z24.object({
  executableName: z24.string().min(1),
  executablePath: z24.string().min(1).nullable(),
  installed: z24.boolean(),
  installSource: providerInstallationSourceSchema,
  currentVersion: z24.string().min(1).nullable(),
  latestVersion: z24.string().min(1).nullable(),
  minimumSupportedVersion: z24.string().min(1).nullable(),
  npmPackageName: z24.string().min(1).nullable(),
  npmGlobalPackageVersion: z24.string().min(1).nullable(),
  installAction: providerInstallationActionSchema.nullable(),
  needsUpdate: z24.boolean(),
  versionUnsupported: z24.boolean()
}).passthrough();
var providerInstallationRunParamsSchema = providerMaintenanceParamsSchema.extend({
  action: providerInstallationActionKindSchema
});
var providerInstallationCommandSchema = z24.object({
  command: z24.string().min(1),
  args: z24.array(z24.string()).max(64),
  displayCommand: z24.string().min(1)
}).passthrough();
var providerInstallationVerificationSchema = z24.discriminatedUnion(
  "kind",
  [
    z24.object({ kind: z24.literal("installed") }).passthrough(),
    z24.object({
      kind: z24.literal("version_changed"),
      previousVersion: z24.string().min(1)
    }).passthrough(),
    z24.object({
      kind: z24.literal("version_at_least"),
      version: z24.string().min(1)
    }).passthrough()
  ]
);
var providerInstallationRunResultSchema = z24.discriminatedUnion(
  "available",
  [
    z24.object({
      available: z24.literal(false),
      message: z24.string().min(1)
    }).passthrough(),
    z24.object({
      available: z24.literal(true),
      command: providerInstallationCommandSchema,
      verification: providerInstallationVerificationSchema
    }).passthrough()
  ]
);

// ../provider-bridge-protocol/src/requests.ts
import { z as z25 } from "zod";
var BRIDGE_REQUEST_METHODS = {
  initialize: "initialize",
  modelList: "model/list",
  providerHealth: "provider/health",
  providerUsage: "provider/usage",
  providerInstallationStatus: "provider/installation/status",
  providerInstallationRun: "provider/installation/run",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadStop: "thread/stop",
  threadDiscard: "thread/discard",
  threadNameSet: "thread/name/set",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  threadGoalClear: "thread/goal/clear",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  skillsConfigure: "skills/configure"
};
var sessionConstructionFields = {
  threadId: z25.string().min(1),
  cwd: z25.string().min(1),
  options: bridgeExecutionOptionsSchema,
  dynamicTools: z25.array(dynamicToolSchema).optional(),
  disallowedTools: z25.array(z25.string().min(1)).optional(),
  instructionMode: instructionModeSchema
};
var modelListParamsSchema = z25.object({ cwd: z25.string().min(1).optional() }).passthrough();
var threadStartParamsSchema = z25.object({
  ...sessionConstructionFields,
  input: z25.array(promptInputSchema).optional()
}).passthrough();
var threadResumeParamsSchema = z25.object({
  ...sessionConstructionFields,
  providerThreadId: z25.string().min(1)
}).passthrough();
var threadForkParamsSchema = z25.object({
  ...sessionConstructionFields,
  sourceProviderThreadId: z25.string().min(1),
  sourceProviderCheckpointId: z25.string().min(1).optional()
}).passthrough();
var threadStopParamsSchema = z25.object({
  threadId: z25.string().min(1),
  providerThreadId: z25.string().min(1),
  intent: z25.enum(["interrupt", "release"]),
  activeTurnId: z25.string().min(1).nullable()
}).passthrough();
var threadRefParams = z25.object({
  threadId: z25.string().min(1),
  providerThreadId: z25.string().min(1)
}).passthrough();
var threadNameSetParamsSchema = z25.object({
  threadId: z25.string().min(1),
  providerThreadId: z25.string().min(1),
  title: z25.string().min(1)
}).passthrough();
var turnInputFields = {
  threadId: z25.string().min(1),
  providerThreadId: z25.string().min(1),
  input: z25.array(promptInputSchema),
  clientRequestId: clientTurnRequestIdSchema,
  options: bridgeExecutionOptionsSchema
};
var turnStartParamsSchema = z25.object(turnInputFields).passthrough();
var turnSteerParamsSchema = z25.object({
  ...turnInputFields,
  expectedTurnId: z25.string().min(1)
}).passthrough();
var skillsConfigureRootSchema = z25.object({
  id: z25.string().min(1),
  path: z25.string().min(1),
  skills: z25.array(
    z25.object({
      name: z25.string().min(1),
      description: z25.string()
    }).passthrough()
  )
}).passthrough();
var skillsConfigureParamsSchema = z25.object({
  roots: z25.array(skillsConfigureRootSchema)
}).passthrough();
var threadIdentityResultSchema = z25.object({
  providerThreadId: z25.string().min(1),
  sessionRestorable: z25.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
import { z as z27 } from "zod";

// ../provider-bridge-protocol/src/errors.ts
import { z as z26 } from "zod";
var BRIDGE_JSON_RPC_ERRORS = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  BRIDGE_ERROR: -32e3,
  NO_ACTIVE_TURN: -32001,
  SESSION_NOT_RESTORABLE: -32002,
  FORK_CHECKPOINT_UNSUPPORTED: -32003,
  MISSING_EXECUTABLE: -32004
};
var providerRecoveryHintSchema = z26.object({
  kind: providerRecoveryKindSchema,
  message: z26.string().min(1),
  retryable: z26.boolean()
});
var bridgeErrorDataSchema = z26.object({ recovery: providerRecoveryHintSchema.optional() }).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
var BRIDGE_NOTIFICATION_METHODS = {
  threadIdentity: "thread/identity",
  sessionReplaced: "session/replaced",
  providerRaw: "provider/raw",
  providerRecovery: "provider/recovery",
  error: "error"
};
var threadIdentityNotificationSchema = z27.object({
  threadId: z27.string().min(1),
  providerThreadId: z27.string().min(1),
  sessionRestorable: z27.boolean().optional()
}).passthrough();
var sessionReplacedNotificationSchema = z27.object({
  threadId: z27.string().min(1),
  providerThreadId: z27.string().min(1).nullable(),
  reason: z27.string().min(1),
  contextLost: z27.boolean().default(false),
  showRuntimeNote: z27.boolean().default(false)
}).passthrough();
var providerRecoveryNotificationSchema = z27.object({
  threadId: z27.string().min(1).optional(),
  ...providerRecoveryHintSchema.shape
}).passthrough();
var errorNotificationSchema = z27.object({
  threadId: z27.string().min(1).optional(),
  providerThreadId: z27.string().min(1).optional(),
  message: z27.string().min(1)
}).passthrough();

// ../provider-bridge-protocol/src/bridge-requests.ts
import { z as z28 } from "zod";
var toolCallRequestParamsSchema = z28.object({
  providerThreadId: z28.string().min(1),
  threadId: z28.string().min(1).optional(),
  turnId: z28.union([z28.string().min(1), z28.null()]),
  callId: z28.string().min(1),
  tool: z28.string().min(1),
  arguments: z28.unknown(),
  providerNativeIds: z28.boolean().optional()
}).passthrough();
var toolCallResultSchema = z28.object({
  success: z28.boolean(),
  contentItems: z28.array(
    z28.discriminatedUnion("type", [
      z28.object({ type: z28.literal("inputText"), text: z28.string() }),
      z28.object({
        type: z28.literal("inputImage"),
        imageUrl: z28.string().min(1)
      })
    ])
  )
}).passthrough();
var interactionRequestParamsSchema = z28.object({
  providerThreadId: z28.string().min(1),
  threadId: z28.string().min(1).optional(),
  turnId: z28.union([z28.string().min(1), z28.null()]),
  payload: pendingInteractionPayloadSchema,
  providerNativeIds: z28.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/thread-event-grammar.ts
var ITEM_STREAMING_EVENT_TYPES = /* @__PURE__ */ new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/mcpToolCall/progress",
  "item/toolCall/progress"
]);
var MAX_ITEM_IDS_PER_THREAD = 512;
var THREAD_EVENT_GRAMMAR_RULES = {
  itemOpensBeforeDelta: "item/opens-before-delta",
  itemSettlesOnce: "item/settles-once",
  turnStartsOnce: "turn/starts-once",
  turnSettlesOnce: "turn/settles-once",
  turnKnown: "turn/known"
};
var OK = { kind: "ok" };
var ThreadEventGrammar = class {
  #byThreadId = /* @__PURE__ */ new Map();
  clear() {
    this.#byThreadId.clear();
  }
  clearThread(threadId) {
    this.#byThreadId.delete(threadId);
  }
  observe(event) {
    const state = this.#stateFor(event.threadId);
    switch (event.type) {
      case "turn/started": {
        const turnId = turnIdOf(event);
        if (turnId === void 0) {
          return OK;
        }
        if (state.completedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnStartsOnce,
            `turn/started for turn "${turnId}", which already completed`
          );
        }
        if (state.startedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnStartsOnce,
            `turn/started for turn "${turnId}", which is already open`
          );
        }
        state.startedTurnIds.add(turnId);
        return OK;
      }
      case "turn/completed": {
        const turnId = turnIdOf(event);
        if (turnId === void 0) {
          return OK;
        }
        if (state.completedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnSettlesOnce,
            `turn/completed for turn "${turnId}", which already completed`
          );
        }
        if (!state.startedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnKnown,
            `turn/completed for turn "${turnId}", which never started`
          );
        }
        state.startedTurnIds.delete(turnId);
        state.completedTurnIds.add(turnId);
        return OK;
      }
      case "item/started": {
        state.openItemIds.add(event.item.id);
        state.settledItemIds.delete(event.item.id);
        trim(state.openItemIds);
        return OK;
      }
      case "item/completed":
      case "item/backgroundTask/completed":
      case "item/delegation/completed": {
        const itemId = event.item.id;
        if (state.settledItemIds.has(itemId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.itemSettlesOnce,
            `${event.type} for item "${itemId}", which already settled`
          );
        }
        state.openItemIds.delete(itemId);
        state.settledItemIds.add(itemId);
        trim(state.settledItemIds);
        return OK;
      }
      case "item/backgroundTask/progress":
      case "item/delegation/progress": {
        return this.#checkOpenItem(state, event.type, event.item.id);
      }
      default: {
        if (!ITEM_STREAMING_EVENT_TYPES.has(event.type)) {
          return OK;
        }
        if (!("itemId" in event) || typeof event.itemId !== "string") {
          return OK;
        }
        return this.#checkOpenItem(state, event.type, event.itemId);
      }
    }
  }
  #checkOpenItem(state, eventType, itemId) {
    if (state.openItemIds.has(itemId)) {
      return OK;
    }
    return violation(
      THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta,
      `${eventType} for item "${itemId}" arrived before item/started`
    );
  }
  #stateFor(threadId) {
    const existing = this.#byThreadId.get(threadId);
    if (existing !== void 0) {
      return existing;
    }
    const created = {
      openItemIds: /* @__PURE__ */ new Set(),
      settledItemIds: /* @__PURE__ */ new Set(),
      startedTurnIds: /* @__PURE__ */ new Set(),
      completedTurnIds: /* @__PURE__ */ new Set()
    };
    this.#byThreadId.set(threadId, created);
    return created;
  }
};
function violation(rule, reason) {
  return { kind: "violation", rule, reason };
}
function turnIdOf(event) {
  return "scope" in event ? getThreadEventScopeTurnId(event.scope) : void 0;
}
function trim(itemIds) {
  while (itemIds.size > MAX_ITEM_IDS_PER_THREAD) {
    const oldest = itemIds.values().next();
    if (oldest.done === true) {
      return;
    }
    itemIds.delete(oldest.value);
  }
}

// ../provider-bridge-protocol/src/conformance/scenarios.ts
var IDENTITY_RESULT_SHAPE = "{ providerThreadId, sessionRestorable? }";
function identityProblem(parsed, result2) {
  return `the result must be ${IDENTITY_RESULT_SHAPE} \u2014 the runtime adopts no session without providerThreadId on the result (a thread/identity notification does not substitute for it); issues: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")} (got ${JSON.stringify(result2)})`;
}
var identityNotificationParamsSchema = z29.object({ threadId: z29.string(), providerThreadId: z29.string() }).passthrough();
async function checkIdentityAnnounced(context, args) {
  const { client } = context;
  const announced = await client.waitFor(() => {
    const notified = client.notifications(BRIDGE_NOTIFICATION_METHODS.threadIdentity).some((message) => {
      const params = identityNotificationParamsSchema.safeParse(
        message.params
      );
      return params.success && params.data.threadId === args.threadId && params.data.providerThreadId === args.providerThreadId;
    });
    const assembled = threadEvents(context, args.threadId).some(
      (event) => event.type === "thread/identity" && event.providerThreadId === args.providerThreadId
    );
    return notified || assembled ? true : void 0;
  });
  if (announced === null) {
    const named = client.notifications(BRIDGE_NOTIFICATION_METHODS.threadIdentity).flatMap((message) => {
      const params = identityNotificationParamsSchema.safeParse(
        message.params
      );
      return params.success && params.data.threadId === args.threadId ? [params.data.providerThreadId] : [];
    });
    return fail(
      args.id,
      args.title,
      `${args.request} returned providerThreadId "${args.providerThreadId}" for thread "${args.threadId}", but no thread/identity notification or thread.identity delta announced it${named.length === 0 ? "" : ` (thread/identity named ${named.map((id) => `"${id}"`).join(", ")})`}; bb persists and resumes only sessions announced this way, so every later send would start a new session`
    );
  }
  return pass(args.id, args.title);
}
function pass(id, title) {
  return { id, title, status: "pass", detail: "" };
}
function fail(id, title, detail) {
  return { id, title, status: "fail", detail };
}
function skipped(id, title, detail) {
  return { id, title, status: "skipped", detail };
}
function defaultOptions(fixture) {
  return fixture.options ?? {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null
  };
}
function threadEvents(context, threadId) {
  context.client.drainIntoLog();
  return context.client.events.filter((entry) => entry.threadId === threadId).map((entry) => entry.event);
}
var persistedEventSchema = z29.preprocess(
  (event) => JSON.parse(JSON.stringify(event)),
  threadEventSchema
);
function errorCode(message) {
  const code = message?.error?.code;
  return typeof code === "number" ? code : void 0;
}
var ITEM_OPENS_BEFORE_DELTA_TITLE = "every item's first event is item/started";
function checkItemOpensBeforeDelta(events) {
  const grammar = new ThreadEventGrammar();
  for (const event of events) {
    const result2 = grammar.observe(event);
    if (result2.kind === "violation" && result2.rule === THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta) {
      return fail(
        THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta,
        ITEM_OPENS_BEFORE_DELTA_TITLE,
        result2.reason
      );
    }
  }
  if (events.length === 0) {
    return skipped(
      "item/opens-before-delta",
      ITEM_OPENS_BEFORE_DELTA_TITLE,
      "no events to inspect"
    );
  }
  return pass("item/opens-before-delta", ITEM_OPENS_BEFORE_DELTA_TITLE);
}
var PRESENTATION_ICONS_DECLARED_ID = "presentation/icon-namespaced-declared";
var PRESENTATION_ICONS_DECLARED_TITLE = "every namespaced presentation glyph names one of the plugin's declared icons";
function checkPresentationIconsDeclared(events, icons) {
  const declared = new Set(icons.names);
  let inspected = 0;
  for (const event of events) {
    if (!isThreadEventWithItem(event)) {
      continue;
    }
    if (event.item.type === "toolCall" && event.item.server === "bb") {
      continue;
    }
    const glyph = "presentation" in event.item ? event.item.presentation?.icon.glyph : void 0;
    if (glyph === void 0) {
      continue;
    }
    inspected += 1;
    const parsed = parseNamespacedGlyph(glyph);
    if (parsed === null) {
      continue;
    }
    if (parsed.pluginId !== icons.pluginId || !declared.has(parsed.name)) {
      return fail(
        PRESENTATION_ICONS_DECLARED_ID,
        PRESENTATION_ICONS_DECLARED_TITLE,
        `${event.type} ${event.item.type} "${event.item.id}" names presentation.icon "${glyph}", which is not an icon declared by plugin "${icons.pluginId}" (declared: ${icons.names.length === 0 ? "none" : icons.names.join(", ")}); the server would persist it as provider/unhandled`
      );
    }
  }
  if (inspected === 0) {
    return skipped(
      PRESENTATION_ICONS_DECLARED_ID,
      PRESENTATION_ICONS_DECLARED_TITLE,
      "no item carried a presentation to inspect"
    );
  }
  return pass(
    PRESENTATION_ICONS_DECLARED_ID,
    PRESENTATION_ICONS_DECLARED_TITLE
  );
}
async function runRpcHygieneScenarios(client) {
  const results = [];
  let unknownMethodsAnswered = false;
  {
    const id = client.request("bb/conformance/definitely-unknown-method", {});
    const response = await client.waitForResponse(id);
    const title = "unknown method answers METHOD_NOT_FOUND";
    if (response === null) {
      results.push(
        fail("rpc/unknown-method", title, "request was silently dropped")
      );
    } else if (errorCode(response) === BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND) {
      unknownMethodsAnswered = true;
      results.push(pass("rpc/unknown-method", title));
    } else {
      unknownMethodsAnswered = true;
      results.push(
        fail(
          "rpc/unknown-method",
          title,
          `answered with ${JSON.stringify(response.error ?? response.result)}`
        )
      );
    }
  }
  {
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStop, {});
    const response = await client.waitForResponse(id);
    const title = "schema-invalid params answer INVALID_PARAMS, never dropped";
    if (response === null) {
      results.push(
        fail("rpc/invalid-params", title, "request was silently dropped")
      );
    } else if (errorCode(response) === BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS) {
      results.push(pass("rpc/invalid-params", title));
    } else {
      results.push(
        fail(
          "rpc/invalid-params",
          title,
          `answered with ${JSON.stringify(response.error ?? response.result)}`
        )
      );
    }
  }
  {
    const title = "a non-JSON line is ignored and the bridge stays alive";
    if (!unknownMethodsAnswered) {
      results.push(
        skipped(
          "rpc/non-json-ignored",
          title,
          "aliveness probe unavailable: bridge drops unknown methods"
        )
      );
    } else {
      client.sendRaw("this is { not json");
      const probe = client.request("bb/conformance/alive-probe", {});
      const response = await client.waitForResponse(probe);
      results.push(
        response === null ? fail("rpc/non-json-ignored", title, "bridge stopped answering") : pass("rpc/non-json-ignored", title)
      );
    }
  }
  {
    const title = "a response-shaped line is not treated as a request";
    if (!unknownMethodsAnswered) {
      results.push(
        skipped(
          "rpc/response-not-request",
          title,
          "aliveness probe unavailable: bridge drops unknown methods"
        )
      );
    } else {
      client.sendRaw(
        JSON.stringify({ jsonrpc: "2.0", id: 999999, result: {} })
      );
      const probe = client.request("bb/conformance/alive-probe", {});
      const response = await client.waitForResponse(probe);
      const echoed = client.responsesFor(999999).some((message) => message.error !== void 0);
      if (response === null) {
        results.push(
          fail("rpc/response-not-request", title, "bridge stopped answering")
        );
      } else if (echoed) {
        results.push(
          fail(
            "rpc/response-not-request",
            title,
            "bridge answered an unsolicited response with an error"
          )
        );
      } else {
        results.push(pass("rpc/response-not-request", title));
      }
    }
  }
  return results;
}
async function runHandshakeScenario(client) {
  const id = client.request(BRIDGE_REQUEST_METHODS.initialize, {
    protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
    client: { name: "bb-conformance", version: "0.0.1" },
    grammarVersions: ASSEMBLER_GRAMMAR_VERSIONS
  });
  const response = await client.waitForResponse(id);
  const title = "initialize answers a versioned handshake with capabilities";
  const failed = (detail) => ({
    results: [fail("handshake/initialize", title, detail)],
    capabilities: null
  });
  if (response === null) {
    return failed("no response");
  }
  const parsed = initializeResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return failed(
      `result did not parse: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(
        "; "
      )} (got ${JSON.stringify(response.result ?? response.error)})`
    );
  }
  if (parsed.data.protocolVersion !== PROVIDER_BRIDGE_PROTOCOL_VERSION) {
    return failed(
      `bridge answered protocol version ${parsed.data.protocolVersion}; this kit (and the runtime) require ${PROVIDER_BRIDGE_PROTOCOL_VERSION}`
    );
  }
  const [bridgeMin, bridgeMax] = parsed.data.capabilities.grammarVersions;
  if (negotiateGrammarVersion(
    ASSEMBLER_GRAMMAR_VERSIONS,
    parsed.data.capabilities.grammarVersions
  ) === null) {
    const [runtimeMin, runtimeMax] = ASSEMBLER_GRAMMAR_VERSIONS;
    return failed(
      `bridge reported grammarVersions [${bridgeMin}, ${bridgeMax}]; the runtime's assembler speaks [${runtimeMin}, ${runtimeMax}], so the handshake would be refused`
    );
  }
  return {
    results: [
      pass("handshake/initialize", title),
      ...await runSkillsConfigureDeclaredScenario(
        client,
        parsed.data.capabilities.skills.configure
      )
    ],
    capabilities: parsed.data.capabilities
  };
}
var SKILLS_CONFIGURE_DECLARED_ID = "skills/configure-declared";
var SKILLS_CONFIGURE_DECLARED_TITLE = "skills/configure is handled iff the handshake declares skills.configure";
async function runSkillsConfigureDeclaredScenario(client, declared) {
  const id = client.request(BRIDGE_REQUEST_METHODS.skillsConfigure, {
    roots: []
  });
  const response = await client.waitForResponse(id);
  if (response === null) {
    return [
      fail(
        SKILLS_CONFIGURE_DECLARED_ID,
        SKILLS_CONFIGURE_DECLARED_TITLE,
        "skills/configure was not answered"
      )
    ];
  }
  if (declared) {
    return response.error === void 0 ? [pass(SKILLS_CONFIGURE_DECLARED_ID, SKILLS_CONFIGURE_DECLARED_TITLE)] : [
      fail(
        SKILLS_CONFIGURE_DECLARED_ID,
        SKILLS_CONFIGURE_DECLARED_TITLE,
        `the handshake declares skills.configure but the request failed: ${JSON.stringify(response.error)}`
      )
    ];
  }
  return errorCode(response) === BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND ? [pass(SKILLS_CONFIGURE_DECLARED_ID, SKILLS_CONFIGURE_DECLARED_TITLE)] : [
    fail(
      SKILLS_CONFIGURE_DECLARED_ID,
      SKILLS_CONFIGURE_DECLARED_TITLE,
      `the handshake does not declare skills.configure, yet the bridge answered the request with ${JSON.stringify(response.error ?? response.result)}; declare it (the runtime never sends an undeclared request)`
    )
  ];
}
var START_IDENTITY_ANNOUNCED_ID = "session/start-identity-announced";
var START_IDENTITY_ANNOUNCED_TITLE = "thread/start announces the returned session through thread/identity";
async function runSessionLifecycleScenarios(context) {
  const { client, fixture } = context;
  const results = [];
  const threadId = "thr_conformance_1";
  {
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStart, {
      threadId,
      cwd: fixture.cwd,
      options: defaultOptions(fixture),
      instructionMode: "append"
    });
    const response = await client.waitForResponse(id);
    const title = "thread/start returns a provider thread identity";
    if (response === null) {
      results.push(fail("session/start-identity", title, "no response"));
    } else if (response.error !== void 0) {
      results.push(
        fail(
          "session/start-identity",
          title,
          `error: ${JSON.stringify(response.error)}`
        )
      );
    } else {
      const parsed = threadIdentityResultSchema.safeParse(response.result);
      if (!parsed.success) {
        results.push(
          fail(
            "session/start-identity",
            title,
            identityProblem(parsed, response.result)
          )
        );
      } else {
        context.providerThreadId = parsed.data.providerThreadId;
        results.push(pass("session/start-identity", title));
      }
    }
  }
  const startSkipDetail = "prerequisite session/start-identity failed";
  results.push(
    context.providerThreadId === void 0 ? skipped(
      START_IDENTITY_ANNOUNCED_ID,
      START_IDENTITY_ANNOUNCED_TITLE,
      startSkipDetail
    ) : await checkIdentityAnnounced(context, {
      id: START_IDENTITY_ANNOUNCED_ID,
      providerThreadId: context.providerThreadId,
      request: "thread/start",
      threadId,
      title: START_IDENTITY_ANNOUNCED_TITLE
    })
  );
  if (context.providerThreadId === void 0) {
    results.push(
      skipped(
        "turn/lifecycle",
        "an accepted turn starts and settles",
        startSkipDetail
      ),
      skipped(
        "events/schema-valid",
        "every assembled event is a valid ThreadEvent",
        startSkipDetail
      ),
      skipped(
        "item/opens-before-delta",
        "every item's first event is item/started",
        startSkipDetail
      )
    );
  } else {
    const id = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
      threadId,
      providerThreadId: context.providerThreadId,
      input: fixture.promptInput,
      clientRequestId: nextConformanceClientRequestId(),
      options: defaultOptions(fixture)
    });
    const started = await client.waitFor(
      () => threadEvents(context, threadId).find(
        (event) => event.type === "turn/started"
      )
    );
    const completed = await client.waitFor(
      () => threadEvents(context, threadId).find(
        (event) => event.type === "turn/completed"
      )
    );
    await client.waitForResponse(id);
    const title = "an accepted turn starts and settles";
    if (started === void 0 || started === null) {
      results.push(
        fail("turn/lifecycle", title, "no turn/started event arrived")
      );
    } else if (completed === void 0 || completed === null) {
      results.push(
        fail("turn/lifecycle", title, "turn never settled (no turn/completed)")
      );
    } else {
      results.push(pass("turn/lifecycle", title));
    }
    {
      client.drainIntoLog();
      const invalid = client.events.filter(
        (entry) => !persistedEventSchema.safeParse(entry.event).success
      );
      const title2 = "every assembled event is a valid ThreadEvent";
      results.push(
        invalid.length === 0 ? pass("events/schema-valid", title2) : fail(
          "events/schema-valid",
          title2,
          `${invalid.length} assembled event(s) failed validation; first: ${JSON.stringify(invalid[0]?.event).slice(0, 400)}`
        )
      );
    }
    results.push(checkItemOpensBeforeDelta(threadEvents(context, threadId)));
    if (fixture.icons !== void 0) {
      results.push(
        checkPresentationIconsDeclared(
          threadEvents(context, threadId),
          fixture.icons
        )
      );
    }
  }
  if (context.providerThreadId === void 0) {
    results.push(
      skipped(
        "stop/release-not-interrupted",
        "a release stop never fabricates an interruption",
        startSkipDetail
      )
    );
  } else {
    const before = threadEvents(context, threadId).length;
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
      threadId,
      providerThreadId: context.providerThreadId,
      intent: "release",
      activeTurnId: null
    });
    const response = await client.waitForResponse(id);
    await client.settle(150);
    const after = threadEvents(context, threadId).slice(before);
    const fabricated = after.find(
      (event) => event.type === "system/thread/interrupted" || event.type === "turn/completed" && event.status === "interrupted"
    );
    const title = "a release stop never fabricates an interruption";
    if (response === null) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          "no response to thread/stop"
        )
      );
    } else if (response.error !== void 0) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          `error: ${JSON.stringify(response.error)}`
        )
      );
    } else if (fabricated !== void 0) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          `release emitted ${fabricated.type}`
        )
      );
    } else {
      results.push(pass("stop/release-not-interrupted", title));
    }
  }
  const uniquenessTitle = "turn and item ids never repeat across a resume";
  if (context.providerThreadId === void 0) {
    results.push(
      skipped(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE, startSkipDetail),
      skipped("session/resume-id-uniqueness", uniquenessTitle, startSkipDetail)
    );
  } else {
    const resumeId = client.request(BRIDGE_REQUEST_METHODS.threadResume, {
      threadId,
      cwd: fixture.cwd,
      providerThreadId: context.providerThreadId,
      options: defaultOptions(fixture),
      instructionMode: "append"
    });
    const resumeResponse = await client.waitForResponse(resumeId);
    const title = uniquenessTitle;
    const resumed = resumeResponse === null || resumeResponse.error !== void 0 ? null : threadIdentityResultSchema.safeParse(resumeResponse.result);
    if (resumed === null) {
      const detail = resumeResponse === null ? "thread/resume was not answered" : `thread/resume failed: ${JSON.stringify(resumeResponse.error)}`;
      results.push(
        skipped(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE, detail),
        skipped("session/resume-id-uniqueness", title, detail)
      );
    } else if (!resumed.success) {
      results.push(
        fail(
          RESUME_IDENTITY_ID,
          RESUME_IDENTITY_TITLE,
          identityProblem(resumed, resumeResponse?.result)
        ),
        skipped(
          "session/resume-id-uniqueness",
          title,
          "prerequisite session/resume-identity failed"
        )
      );
    } else {
      context.providerThreadId = resumed.data.providerThreadId;
      results.push(pass(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE));
      const turnId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
        threadId,
        providerThreadId: context.providerThreadId,
        input: fixture.promptInput,
        clientRequestId: nextConformanceClientRequestId(),
        options: defaultOptions(fixture)
      });
      const secondCompleted = await client.waitFor(() => {
        const completions = threadEvents(context, threadId).filter(
          (event) => event.type === "turn/completed"
        );
        return completions.length >= 2 ? completions[1] : void 0;
      });
      await client.waitForResponse(turnId);
      if (secondCompleted === null) {
        results.push(
          fail(
            "session/resume-id-uniqueness",
            title,
            "the post-resume turn never settled"
          )
        );
      } else {
        const events = threadEvents(context, threadId);
        const turnIds = [];
        const itemIds = [];
        for (const event of events) {
          if (event.type === "turn/started" && event.scope.kind === "turn") {
            turnIds.push(event.scope.turnId);
          }
          if (event.type === "item/started") {
            itemIds.push(event.item.id);
          }
        }
        const duplicateTurn = turnIds.find(
          (value, index) => turnIds.indexOf(value) !== index
        );
        const duplicateItem = itemIds.find(
          (value, index) => itemIds.indexOf(value) !== index
        );
        if (duplicateTurn !== void 0 || duplicateItem !== void 0) {
          results.push(
            fail(
              "session/resume-id-uniqueness",
              title,
              duplicateTurn !== void 0 ? `turn id reused across resume: ${duplicateTurn}` : `item id reused across resume: ${String(duplicateItem)}`
            )
          );
        } else if (turnIds.length < 2) {
          results.push(
            fail(
              "session/resume-id-uniqueness",
              title,
              `expected two turns, saw ${turnIds.length}`
            )
          );
        } else {
          results.push(pass("session/resume-id-uniqueness", title));
        }
      }
    }
  }
  results.push(...await runForkIdentityScenario(context, threadId));
  results.push(...await runZeroWorkTurnScenario(context, threadId));
  results.push(...await runArchivedResumeRecoveryScenario(context, threadId));
  results.push(...await runThreadsIndependentScenario(context, threadId));
  results.push(...await runInterruptStopScenario(context, threadId));
  if (context.providerThreadId !== void 0) {
    const releaseId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
      threadId,
      providerThreadId: context.providerThreadId,
      intent: "release",
      activeTurnId: null
    });
    await client.waitForResponse(releaseId);
  }
  return results;
}
var RESUME_IDENTITY_ID = "session/resume-identity";
var RESUME_IDENTITY_TITLE = "thread/resume returns a provider thread identity";
var FORK_IDENTITY_ID = "session/fork-identity";
var FORK_IDENTITY_ANNOUNCED_ID = "session/fork-identity-announced";
var FORK_IDENTITY_ANNOUNCED_TITLE = "thread/fork announces the forked session through thread/identity";
var FORK_IDENTITY_TITLE = "thread/fork returns a provider thread identity for the forked session";
async function runForkIdentityScenario(context, threadId) {
  const { client, fixture } = context;
  if (context.fork === "none") {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const forkThreadId = `${threadId}_fork`;
  const forkId = client.request(BRIDGE_REQUEST_METHODS.threadFork, {
    threadId: forkThreadId,
    cwd: fixture.cwd,
    sourceProviderThreadId: context.providerThreadId,
    options: defaultOptions(fixture),
    instructionMode: "append"
  });
  const response = await client.waitForResponse(forkId);
  if (response === null) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        "thread/fork was not answered"
      )
    ];
  }
  if (response.error !== void 0) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        `the handshake declares fork "${context.fork}", yet forking the lifecycle session at its tip failed: ${JSON.stringify(response.error)}`
      )
    ];
  }
  const parsed = threadIdentityResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        identityProblem(parsed, response.result)
      )
    ];
  }
  const announced = await checkIdentityAnnounced(context, {
    id: FORK_IDENTITY_ANNOUNCED_ID,
    providerThreadId: parsed.data.providerThreadId,
    request: "thread/fork",
    threadId: forkThreadId,
    title: FORK_IDENTITY_ANNOUNCED_TITLE
  });
  const releaseId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId: forkThreadId,
    providerThreadId: parsed.data.providerThreadId,
    intent: "release",
    activeTurnId: null
  });
  await client.waitForResponse(releaseId);
  return [pass(FORK_IDENTITY_ID, FORK_IDENTITY_TITLE), announced];
}
var THREADS_INDEPENDENT_ID = "session/threads-independent";
var THREADS_INDEPENDENT_TITLE = "requests on different threads are independent";
async function runThreadsIndependentScenario(context, threadId) {
  const { client, fixture } = context;
  const interruptiblePromptInput = fixture.interruptiblePromptInput;
  if (interruptiblePromptInput === void 0) {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const startedBefore = threadEvents(context, threadId).filter(
    (event) => event.type === "turn/started"
  ).length;
  const holdId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId,
    providerThreadId: context.providerThreadId,
    input: interruptiblePromptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture)
  });
  const held = await client.waitFor(() => {
    const starts = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/started"
    );
    return starts.length > startedBefore ? starts[startedBefore] : void 0;
  });
  await client.waitForResponse(holdId);
  if (held === null) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the interruptible prompt never opened a turn"
      )
    ];
  }
  const otherThreadId = `${threadId}_other`;
  const startId = client.request(BRIDGE_REQUEST_METHODS.threadStart, {
    threadId: otherThreadId,
    cwd: fixture.cwd,
    options: defaultOptions(fixture),
    instructionMode: "append"
  });
  const startResponse = await client.waitForResponse(startId);
  const startResult = threadIdentityResultSchema.safeParse(
    startResponse?.result
  );
  if (startResponse === null || !startResult.success) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        `the second thread did not start while the first held a turn: ${JSON.stringify(startResponse?.error ?? startResponse?.result)}`
      )
    ];
  }
  const turnId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId: otherThreadId,
    providerThreadId: startResult.data.providerThreadId,
    input: fixture.promptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture)
  });
  const completed = await client.waitFor(
    () => threadEvents(context, otherThreadId).find(
      (event) => event.type === "turn/completed"
    )
  );
  await client.waitForResponse(turnId);
  const stopId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId: otherThreadId,
    providerThreadId: startResult.data.providerThreadId,
    intent: "release",
    activeTurnId: null
  });
  await client.waitForResponse(stopId);
  if (completed === null) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the second thread's turn never completed while the first thread held a turn"
      )
    ];
  }
  const firstStillOpen = !threadEvents(context, threadId).some(
    (event) => event.type === "turn/completed" && getThreadEventScopeTurnId(event.scope) === getThreadEventScopeTurnId(held.scope)
  );
  if (!firstStillOpen) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the held turn on the first thread settled while the second thread ran"
      )
    ];
  }
  return [pass(THREADS_INDEPENDENT_ID, THREADS_INDEPENDENT_TITLE)];
}
var INTERRUPT_SETTLES_ID = "stop/interrupt-settles-before-result";
var INTERRUPT_SETTLES_TITLE = "thread/stop {interrupt} settles the turn before it is answered";
async function runInterruptStopScenario(context, threadId) {
  const { client, fixture } = context;
  const interruptiblePromptInput = fixture.interruptiblePromptInput;
  if (interruptiblePromptInput === void 0) {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  let started = openTurnStart(context, threadId);
  if (started === void 0) {
    const startedBefore = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/started"
    ).length;
    const turnRequestId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
      threadId,
      providerThreadId: context.providerThreadId,
      input: interruptiblePromptInput,
      clientRequestId: nextConformanceClientRequestId(),
      options: defaultOptions(fixture)
    });
    started = await client.waitFor(() => {
      const starts = threadEvents(context, threadId).filter(
        (event) => event.type === "turn/started"
      );
      return starts.length > startedBefore ? starts[startedBefore] : void 0;
    }) ?? void 0;
    await client.waitForResponse(turnRequestId);
  }
  if (started === void 0 || started.scope.kind !== "turn") {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "the interruptible prompt never opened a turn"
      )
    ];
  }
  const bbTurnId = started.scope.turnId;
  const providerTurnId = context.resolveProviderTurnId(threadId, bbTurnId) ?? bbTurnId;
  const stopId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId,
    providerThreadId: context.providerThreadId,
    intent: "interrupt",
    activeTurnId: providerTurnId
  });
  const stopResponse = await client.waitForResponse(stopId);
  if (stopResponse === null) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "thread/stop was not answered"
      )
    ];
  }
  if (stopResponse.error !== void 0) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        `thread/stop failed: ${JSON.stringify(stopResponse.error)}`
      )
    ];
  }
  const responseIndex = client.log.indexOf(stopResponse);
  const completedIndex = client.events.find(
    (entry) => entry.threadId === threadId && entry.event.type === "turn/completed" && getThreadEventScopeTurnId(entry.event.scope) === bbTurnId
  )?.logIndex ?? -1;
  if (completedIndex === -1) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "the interrupted turn never reached turn/completed"
      )
    ];
  }
  if (completedIndex > responseIndex) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "turn/completed arrived after the thread/stop response; the runtime had already detached the thread"
      )
    ];
  }
  return [pass(INTERRUPT_SETTLES_ID, INTERRUPT_SETTLES_TITLE)];
}
var SESSION_ARCHIVED_RECOVERY_ID = "recovery/session-archived";
var SESSION_ARCHIVED_RECOVERY_TITLE = "resuming an archived session is rejected with a sessionArchived hint";
async function runArchivedResumeRecoveryScenario(context, threadId) {
  const { client, fixture } = context;
  const providerThreadId = context.providerThreadId;
  if (providerThreadId === void 0) {
    return [
      skipped(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const archiveId = client.request(BRIDGE_REQUEST_METHODS.threadArchive, {
    threadId,
    providerThreadId
  });
  const archiveResponse = await client.waitForResponse(archiveId);
  if (archiveResponse === null) {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "thread/archive was not answered"
      )
    ];
  }
  if (archiveResponse.error !== void 0) {
    return [];
  }
  const resumeParams = {
    threadId,
    cwd: fixture.cwd,
    providerThreadId,
    options: defaultOptions(fixture),
    instructionMode: "append"
  };
  const resumeId = client.request(
    BRIDGE_REQUEST_METHODS.threadResume,
    resumeParams
  );
  const resumeResponse = await client.waitForResponse(resumeId);
  const unarchiveId = client.request(BRIDGE_REQUEST_METHODS.threadUnarchive, {
    threadId,
    providerThreadId
  });
  await client.waitForResponse(unarchiveId);
  if (resumeResponse === null) {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "thread/resume of the archived session was not answered"
      )
    ];
  }
  if (resumeResponse.error === void 0) {
    const resumed = threadIdentityResultSchema.safeParse(resumeResponse.result);
    if (!resumed.success) {
      return [
        fail(
          SESSION_ARCHIVED_RECOVERY_ID,
          SESSION_ARCHIVED_RECOVERY_TITLE,
          `the archived session was resumed with a result the runtime cannot adopt: ${identityProblem(resumed, resumeResponse.result)}`
        )
      ];
    }
    context.providerThreadId = resumed.data.providerThreadId;
    return [];
  }
  const reResumeId = client.request(
    BRIDGE_REQUEST_METHODS.threadResume,
    resumeParams
  );
  const reResumeResponse = await client.waitForResponse(reResumeId);
  const data = bridgeErrorDataSchema.safeParse(resumeResponse.error.data);
  const kind = data.success ? data.data.recovery?.kind : void 0;
  if (kind !== "sessionArchived") {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        `the rejection carried ${kind === void 0 ? "no recovery hint" : `kind "${kind}"`}: ${JSON.stringify(resumeResponse.error)}`
      )
    ];
  }
  const notBack = (detail) => [
    fail(
      SESSION_ARCHIVED_RECOVERY_ID,
      SESSION_ARCHIVED_RECOVERY_TITLE,
      `the session did not come back: ${detail}`
    )
  ];
  if (reResumeResponse === null) {
    return notBack("thread/resume after thread/unarchive was not answered");
  }
  if (reResumeResponse.error !== void 0) {
    return notBack(
      `thread/resume after thread/unarchive failed: ${JSON.stringify(reResumeResponse.error)}`
    );
  }
  const reResumed = threadIdentityResultSchema.safeParse(
    reResumeResponse.result
  );
  if (!reResumed.success) {
    return notBack(identityProblem(reResumed, reResumeResponse.result));
  }
  context.providerThreadId = reResumed.data.providerThreadId;
  return [pass(SESSION_ARCHIVED_RECOVERY_ID, SESSION_ARCHIVED_RECOVERY_TITLE)];
}
var SETTLES_WITHOUT_ACTIVITY_ID = "turn/settles-without-activity";
var SETTLES_WITHOUT_ACTIVITY_TITLE = "a turn the provider completes without activity still settles";
async function runZeroWorkTurnScenario(context, threadId) {
  const { client, fixture } = context;
  const zeroWorkPromptInput = fixture.zeroWorkPromptInput;
  if (zeroWorkPromptInput === void 0) {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const before = threadEvents(context, threadId).filter(
    (event) => event.type === "turn/completed"
  ).length;
  const id = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId,
    providerThreadId: context.providerThreadId,
    input: zeroWorkPromptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture)
  });
  const settled = await client.waitFor(() => {
    const completions = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/completed"
    );
    return completions.length > before ? completions[before] : void 0;
  });
  const response = await client.waitForResponse(id);
  if (response !== null && response.error !== void 0) {
    return [
      skipped(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        `the zero-work prompt was rejected: ${JSON.stringify(response.error)}`
      )
    ];
  }
  if (settled === null) {
    return [
      fail(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        "the accepted zero-work turn never emitted a terminal turn/completed"
      )
    ];
  }
  return [pass(SETTLES_WITHOUT_ACTIVITY_ID, SETTLES_WITHOUT_ACTIVITY_TITLE)];
}
function openTurnStart(context, threadId) {
  const events = threadEvents(context, threadId);
  const completedTurnIds = new Set(
    events.filter((event) => event.type === "turn/completed").map((event) => getThreadEventScopeTurnId(event.scope))
  );
  return [...events].reverse().find(
    (event) => event.type === "turn/started" && !completedTurnIds.has(getThreadEventScopeTurnId(event.scope))
  );
}

// ../provider-bridge-protocol/src/conformance/recorded.ts
var RECORDED_CONFORMANCE_CELLS = [
  "turn-tools",
  "steer",
  "stop-interrupt",
  "approval-allow",
  "approval-deny",
  "user-question",
  "resume",
  "fork"
];
function result(id, title, detail) {
  return detail === null ? { id, title, status: "pass", detail: "" } : { id, title, status: "fail", detail };
}
function countTurns(events) {
  let started = 0;
  let completed = 0;
  for (const event of events) {
    if (event.type === "turn/started") started += 1;
    if (event.type === "turn/completed") completed += 1;
  }
  return { started, completed };
}
function checkRecordedCellReplay(replay) {
  const prefix = `recorded/${replay.cell}`;
  const results = [];
  const recordedTurns = countTurns(replay.recordedEvents);
  const liveTurns = countTurns(replay.events);
  results.push(
    result(
      `${prefix}/replays`,
      "the bridge answers every recorded runtime request and the replay needs no help",
      replay.stalls.length === 0 ? null : replay.stalls.join("; ")
    )
  );
  results.push(
    result(
      `${prefix}/events-schema-valid`,
      "every assembled event is a valid ThreadEvent",
      (() => {
        for (const [index, event] of replay.events.entries()) {
          const parsed = threadEventSchema.safeParse(event);
          if (!parsed.success) {
            return `event ${index} (${event.type}) failed: ${parsed.error.issues[0]?.message ?? "invalid"}`;
          }
        }
        return null;
      })()
    )
  );
  results.push(
    result(
      `${prefix}/grammar`,
      "the event stream breaks no thread-event grammar rule",
      (() => {
        const grammar = new ThreadEventGrammar();
        for (const event of replay.events) {
          const verdict = grammar.observe(event);
          if (verdict.kind === "violation") {
            return `${verdict.rule} on ${event.type}: ${verdict.reason}`;
          }
        }
        return null;
      })()
    )
  );
  results.push(
    result(
      `${prefix}/turn-lifecycle`,
      "the replay opens and settles as many turns as the recording did",
      liveTurns.started === recordedTurns.started && liveTurns.completed === recordedTurns.completed && liveTurns.started === liveTurns.completed ? null : `replay ${liveTurns.started} started/${liveTurns.completed} completed, recording ${recordedTurns.started}/${recordedTurns.completed}`
    )
  );
  results.push(
    result(
      `${prefix}/not-empty`,
      "a recorded session that produced events still does",
      replay.recordedEvents.length === 0 || replay.events.length > 0 ? null : `the recording assembled ${replay.recordedEvents.length} events, the replay none`
    )
  );
  return results;
}

// ../provider-bridge-protocol/src/conformance/types.ts
var CONFORMANCE_ASSEMBLED_EVENT_METHOD = "conformance/assembledEvent";
function reportPassed(results) {
  return results.every((result2) => result2.status === "pass");
}

// ../provider-bridge-protocol/src/conformance/index.ts
async function runBridgeConformance(options) {
  const collector = createBridgeDeltaEventCollector(options.providerId);
  const client = new ConformanceClient(
    options.transport,
    options.timeoutMs ?? 5e3,
    collector
  );
  const results = [];
  results.push(...await runRpcHygieneScenarios(client));
  const handshake = await runHandshakeScenario(client);
  results.push(...handshake.results);
  results.push(
    ...await runSessionLifecycleScenarios({
      client,
      fixture: options.session,
      resolveProviderTurnId: (threadId, bbTurnId) => collector.assembler.getProviderTurnId(threadId, bbTurnId),
      fork: handshake.capabilities?.fork ?? "none"
    })
  );
  await options.transport.close?.();
  return { results, passed: reportPassed(results) };
}
function formatConformanceReport(report) {
  return report.results.map(
    (result2) => `${result2.status.padEnd(7)} ${result2.id}${result2.detail === "" ? "" : ` \u2014 ${result2.detail}`}`
  ).join("\n");
}

// ../provider-bridge-protocol/src/testing/bridge-json-rpc-test-helpers.ts
import { z as z30 } from "zod";
var bridgeJsonRpcValueSchema = z30.lazy(
  () => z30.union([
    z30.string(),
    z30.number(),
    z30.boolean(),
    z30.null(),
    z30.array(bridgeJsonRpcValueSchema),
    z30.record(z30.string(), bridgeJsonRpcValueSchema)
  ])
);
var bridgeJsonRpcOutputSchema = z30.object({
  jsonrpc: z30.literal("2.0"),
  id: z30.union([z30.string(), z30.number()]).optional(),
  method: z30.string().optional(),
  params: bridgeJsonRpcValueSchema.optional(),
  result: bridgeJsonRpcValueSchema.optional(),
  error: z30.object({
    code: z30.number(),
    message: z30.string(),
    data: bridgeJsonRpcValueSchema.optional()
  }).optional()
});
function waitForNextBridgeTick() {
  return new Promise((resolve3) => setTimeout(resolve3, 0));
}
function captureBridgeJsonRpcOutput() {
  const messages = [];
  const originalWrite = process.stdout.write;
  const capturingWrite = (buffer) => {
    const text = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) {
        messages.push(bridgeJsonRpcOutputSchema.parse(JSON.parse(line)));
      }
    }
    return true;
  };
  process.stdout.write = capturingWrite;
  let drained = 0;
  return {
    messages,
    takeMessages() {
      const fresh = messages.slice(drained);
      drained = messages.length;
      return fresh;
    },
    restore() {
      if (process.stdout.write === capturingWrite) {
        process.stdout.write = originalWrite;
      }
    }
  };
}
function sendBridgeJsonRpcRequest(args) {
  args.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      method: args.method,
      params: args.params
    })
  );
}
async function waitForBridgeJsonRpcResponse(args) {
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const response = args.output.messages.find(
      (message) => message.id === args.id
    );
    if (response) {
      return response;
    }
    await waitForNextBridgeTick();
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${String(args.id)}`);
}
function bridgeJsonRpcResponseExists(args) {
  return args.output.messages.some((message) => message.id === args.id);
}
function createBridgeJsonRpcTestHarness(handleLine) {
  const output = captureBridgeJsonRpcOutput();
  return {
    messages: output.messages,
    takeMessages: output.takeMessages,
    flushWork: waitForNextBridgeTick,
    hasResponse(id) {
      return bridgeJsonRpcResponseExists({ id, output });
    },
    restore() {
      output.restore();
    },
    sendRequest(id, method, params) {
      sendBridgeJsonRpcRequest({ handleLine, id, method, params });
    },
    waitForResponse(id) {
      return waitForBridgeJsonRpcResponse({ id, output });
    }
  };
}

// ../provider-bridge-protocol/src/testing/calibration-diff.ts
var DEFAULT_INTERNED_ID_FIELDS = [
  "turnId",
  "itemId",
  "id",
  "parentToolCallId"
];
var BLANKED_FIELDS = /* @__PURE__ */ new Set(["threadId", "providerThreadId"]);
var DROPPED_FIELDS = /* @__PURE__ */ new Set(["providerCheckpointId"]);
var IdInterner = class {
  assigned = /* @__PURE__ */ new Map();
  intern(value) {
    const existing = this.assigned.get(value);
    if (existing !== void 0) {
      return existing;
    }
    const token = `#${this.assigned.size + 1}`;
    this.assigned.set(value, token);
    return token;
  }
};
function normalizeValue(value, interner, idFields) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, interner, idFields));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === void 0 || DROPPED_FIELDS.has(key)) {
      continue;
    }
    if (BLANKED_FIELDS.has(key)) {
      normalized[key] = entry === null ? null : "";
      continue;
    }
    if (idFields.has(key) && typeof entry === "string") {
      normalized[key] = interner.intern(entry);
      continue;
    }
    normalized[key] = normalizeValue(entry, interner, idFields);
  }
  return normalized;
}
function normalizeCalibrationEvents(events, options = {}) {
  const interner = new IdInterner();
  const idFields = new Set(
    options.internedIdFields ?? DEFAULT_INTERNED_ID_FIELDS
  );
  const wireShaped = JSON.parse(JSON.stringify(events));
  const list = Array.isArray(wireShaped) ? wireShaped : [];
  return list.map((event) => normalizeValue(event, interner, idFields));
}
function diffCalibrationStreams(legacy, bridge) {
  const left = legacy.map((event) => JSON.stringify(event));
  const right = bridge.map((event) => JSON.stringify(event));
  const lengths = Array.from(
    { length: left.length + 1 },
    () => new Array(right.length + 1).fill(0)
  );
  for (let i2 = left.length - 1; i2 >= 0; i2 -= 1) {
    for (let j2 = right.length - 1; j2 >= 0; j2 -= 1) {
      lengths[i2][j2] = left[i2] === right[j2] ? lengths[i2 + 1][j2 + 1] + 1 : Math.max(lengths[i2 + 1][j2], lengths[i2][j2 + 1]);
    }
  }
  const onlyInLegacy = [];
  const onlyInBridge = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      onlyInLegacy.push(legacy[i]);
      i += 1;
    } else {
      onlyInBridge.push(bridge[j]);
      j += 1;
    }
  }
  onlyInLegacy.push(...legacy.slice(i));
  onlyInBridge.push(...bridge.slice(j));
  return { onlyInLegacy, onlyInBridge };
}
function describeCalibrationEvents(events) {
  return events.map((event) => {
    if (event === null || typeof event !== "object") {
      return String(event);
    }
    const record = { ...event };
    const type = typeof record.type === "string" ? record.type : "?";
    const item = record.item;
    if (item !== null && typeof item === "object" && "type" in item) {
      return `${type}:${String(item.type)}`;
    }
    return type;
  });
}

// ../provider-bridge-protocol/src/testing/parity.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL } from "node:url";

// ../provider-bridge-protocol/src/bridge-kit/bounded-line-reader.ts
import { StringDecoder } from "node:string_decoder";
var MAX_JSON_RPC_LINE_BYTES = 64 * 1024 * 1024;
function readBoundedLines(args) {
  const maxLineBytes = args.maxLineBytes ?? MAX_JSON_RPC_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  let discardedBytes = 0;
  args.input.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (; ; ) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex === -1) {
        break;
      }
      if (discarding) {
        discarding = false;
        args.onOverflow(discardedBytes);
        discardedBytes = 0;
      } else {
        emit(pending + text.slice(start, newlineIndex));
      }
      pending = "";
      start = newlineIndex + 1;
    }
    const tail = text.slice(start);
    if (discarding) {
      discardedBytes += Buffer.byteLength(tail);
      return;
    }
    pending += tail;
    if (Buffer.byteLength(pending) > maxLineBytes) {
      discarding = true;
      discardedBytes = Buffer.byteLength(pending);
      pending = "";
    }
  });
  args.input.on("end", () => {
    if (!discarding && pending.length > 0) {
      emit(pending);
    }
    pending = "";
    args.onClose?.();
  });
  function emit(line) {
    args.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

// ../provider-bridge-protocol/src/testing/recording.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ../provider-bridge-protocol/src/bridge-kit/bridge-recorder.ts
var BRIDGE_RECORDING_DIRECTIONS = [
  "runtime\u2192bridge",
  "bridge\u2192runtime",
  "provider\u2192bridge",
  "bridge\u2192provider"
];
function bridgeRecordingFileName(direction) {
  return `${direction}.ndjson`;
}

// ../provider-bridge-protocol/src/testing/recording.ts
var COMMITTED_RECORDINGS_ROOT = fileURLToPath(
  new URL("../../recordings", import.meta.url)
);
var RECORDINGS_CHECKOUT_ROOT = resolve(
  COMMITTED_RECORDINGS_ROOT,
  "../../.."
);
function compareRecordingEntries(left, right) {
  return left.run - right.run || left.seq - right.seq;
}
function parseEntry(raw, file, lineNumber) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${file}:${lineNumber}: not JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.line !== "string" || typeof parsed.seq !== "number" || typeof parsed.dir !== "string") {
    throw new Error(`${file}:${lineNumber}: not a recording entry`);
  }
  const entry = parsed;
  return { ...entry, run: typeof entry.run === "number" ? entry.run : 0 };
}
function readLaneEntries(file, direction, laneLabel) {
  const entries = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const entry = parseEntry(raw, file, index + 1);
    if (entry.dir !== direction) {
      throw new Error(
        `${file}:${index + 1}: entry direction ${entry.dir} in the ${laneLabel}`
      );
    }
    entries.push(entry);
  }
  return entries;
}
function readBridgeRecordingLane(dir, direction) {
  const file = join(dir, bridgeRecordingFileName(direction));
  if (!existsSync(file)) {
    return [];
  }
  return readLaneEntries(file, direction, `${direction} lane`);
}
var CURRENT_BRIDGE_LANE_FILE = "bridge\u2192runtime.current.ndjson";
function readCurrentBridgeLane(dir) {
  const file = join(dir, CURRENT_BRIDGE_LANE_FILE);
  if (!existsSync(file)) {
    return null;
  }
  return readLaneEntries(file, "bridge\u2192runtime", "current bridge lane");
}
function withCurrentBridgeLane(recording) {
  const current = readCurrentBridgeLane(recording.dir);
  if (current === null) {
    return recording;
  }
  const entries = [
    ...recording.entries.filter((entry) => entry.dir !== "bridge\u2192runtime"),
    ...current
  ];
  entries.sort(compareRecordingEntries);
  return { ...recording, entries };
}
function readBridgeRecording(dir) {
  const manifestPath = join(dir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) : null;
  const entries = [];
  for (const direction of BRIDGE_RECORDING_DIRECTIONS) {
    entries.push(...readBridgeRecordingLane(dir, direction));
  }
  entries.sort(compareRecordingEntries);
  return { dir, manifest, entries };
}
function listRecordedCells(root) {
  const cells = [];
  if (!existsSync(root)) {
    return cells;
  }
  for (const provider of readdirSync(root).sort()) {
    const providerDir = join(root, provider);
    if (!statSync(providerDir).isDirectory()) continue;
    for (const cell of readdirSync(providerDir).sort()) {
      const dir = join(providerDir, cell);
      if (!statSync(dir).isDirectory()) continue;
      const hasLane = BRIDGE_RECORDING_DIRECTIONS.some(
        (direction) => existsSync(join(dir, bridgeRecordingFileName(direction)))
      );
      if (hasLane) {
        cells.push({ provider, cell, dir });
      }
    }
  }
  return cells;
}

// ../provider-bridge-protocol/src/testing/parity.ts
var REPLAY_CLEANUP_RETRIES = 20;
var REPLAY_CLEANUP_RETRY_DELAY_MS = 100;
var SOURCE_BOOTSTRAP = fileURLToPath2(
  new URL("../bridge-worker-entry.ts", import.meta.url)
);
var BUNDLED_BOOTSTRAP = fileURLToPath2(
  new URL("./provider-bridge-worker-entry.mjs", import.meta.url)
);
function resolveProviderBridgeBootstrapPath() {
  if (existsSync2(SOURCE_BOOTSTRAP)) return SOURCE_BOOTSTRAP;
  if (existsSync2(BUNDLED_BOOTSTRAP)) return BUNDLED_BOOTSTRAP;
  throw new Error(
    `provider-bridge bootstrap not found at ${SOURCE_BOOTSTRAP} or ${BUNDLED_BOOTSTRAP}`
  );
}
function isTypeScriptPath(path) {
  return /\.[cm]?tsx?$/u.test(path);
}
function tsxSpecifier() {
  return import.meta.resolve("tsx");
}
function defaultNodeArgs(bootstrapPath, modulePath) {
  if (isTypeScriptPath(bootstrapPath)) {
    return ["--conditions=source", "--import", tsxSpecifier()];
  }
  return isTypeScriptPath(modulePath) ? ["--import", tsxSpecifier()] : [];
}
function resolveProviderBridgeLaunch(options) {
  if (!isAbsolute(options.modulePath)) {
    throw new Error(
      `bridge module path must be absolute: ${options.modulePath}`
    );
  }
  const bootstrapPath = options.bootstrapPath ?? resolveProviderBridgeBootstrapPath();
  const dataDir = options.dataDir ?? mkdtempSync(join2(tmpdir(), "bb-parity-data-"));
  return {
    command: process.execPath,
    args: [
      ...options.nodeArgs ?? defaultNodeArgs(bootstrapPath, options.modulePath),
      bootstrapPath,
      options.modulePath,
      options.pluginId,
      dataDir
    ],
    cwd: options.cwd ?? process.cwd(),
    env: {}
  };
}
var DEFAULT_REPLAY_PROFILE = {
  dialect: "json-rpc",
  env: () => ({})
};
function rewriteRecordedMachineFacts(line, workspaceDir) {
  if (!line.includes('"PATH"') && !line.includes('"cwd"')) {
    return line;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const params = parsed.params;
  if (params === void 0) {
    return line;
  }
  let changed = false;
  const envVars = params.options?.envVars;
  if (envVars !== void 0 && typeof envVars.PATH === "string") {
    envVars.PATH = process.env.PATH ?? envVars.PATH;
    changed = true;
  }
  if (typeof params.cwd === "string") {
    params.cwd = workspaceDir;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : line;
}
function recordedWorkspaceDir(recording) {
  for (const entry of recording.entries) {
    if (entry.dir !== "runtime\u2192bridge") continue;
    const message = parseWire(entry.line);
    const cwd = message?.params?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return null;
}
function parseWire(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function isRequest(message) {
  return message.id !== void 0 && typeof message.method === "string";
}
function isResponse(message) {
  return message.id !== void 0 && message.method === void 0;
}
function planRuntimeSteps(recording, assembler) {
  const steps = [];
  const assembled = [];
  for (const entry of recording.entries) {
    if (entry.dir === "bridge\u2192runtime") {
      const message = parseWire(entry.line);
      if (message !== null && message.method === THREAD_DELTA_NOTIFICATION_METHOD) {
        try {
          assembled.push(...assembler.assembleMessage(message));
        } catch {
        }
      }
      continue;
    }
    if (entry.dir !== "runtime\u2192bridge") {
      continue;
    }
    steps.push({
      entry,
      message: parseWire(entry.line),
      gate: countTurns(assembled),
      eventsBefore: assembled.length
    });
  }
  return steps;
}
function methodOfRecordedBridgeRequest(recording, response, id) {
  for (const entry of recording.entries) {
    if (entry.dir !== "bridge\u2192runtime" || entry.run !== response.run) continue;
    const message = parseWire(entry.line);
    if (message !== null && isRequest(message) && String(message.id) === String(id)) {
      return message.method;
    }
  }
  return void 0;
}
var REPLAY_CHILD_PATH = fileURLToPath2(
  new URL("./replay-provider-child.mjs", import.meta.url)
);
var PARITY_INITIALIZE_ID = "parity-initialize";
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
var REPLAY_STARTUP_CONCURRENCY = 4;
var replayStartupQueue = [];
var startingReplays = 0;
async function acquireReplayStartup() {
  if (startingReplays < REPLAY_STARTUP_CONCURRENCY) {
    startingReplays += 1;
  } else {
    await new Promise(
      (resolveSlot) => replayStartupQueue.push(resolveSlot)
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = replayStartupQueue.shift();
    if (next === void 0) startingReplays -= 1;
    else next();
  };
}
async function replayRecording(options) {
  const timeoutMs = options.timeoutMs ?? 15e3;
  const orderTimeoutMs = options.orderTimeoutMs ?? 5e3;
  const settleMs = options.settleMs ?? 750;
  const drainMs = options.drainMs ?? 300;
  const providerId = options.providerId;
  const profile = options.profile ?? DEFAULT_REPLAY_PROFILE;
  const recording = readBridgeRecording(options.recordingDir);
  const stateDir = mkdtempSync(join2(tmpdir(), "bb-parity-replay-"));
  const workspaceDir = realpathSync(
    mkdtempSync(join2(tmpdir(), "bb-parity-ws-"))
  );
  const replayCommand = [
    process.execPath,
    REPLAY_CHILD_PATH,
    "--recording",
    resolve2(options.recordingDir),
    "--dialect",
    profile.dialect,
    "--state",
    stateDir
  ];
  const cursorPath = join2(stateDir, "cursor");
  const setCursor = (position) => {
    writeFileSync(
      cursorPath,
      position === "end" ? "end" : `${position.run} ${position.seq}`
    );
  };
  const wrapperPath = join2(stateDir, "replay-provider.mjs");
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env node",
      `process.argv.splice(2, 0, ${JSON.stringify(replayCommand.slice(2)).slice(1, -1)});`,
      `await import(${JSON.stringify(pathToFileURL(REPLAY_CHILD_PATH).href)});`,
      ""
    ].join("\n"),
    { mode: 493 }
  );
  profile.prepareState?.({ recording, stateDir, workspaceDir });
  const launch = options.bridge;
  const releaseStartup = await acquireReplayStartup();
  let spawnedChild;
  let childEnded;
  try {
    let write2 = function(line) {
      if (child.stdin?.writable) {
        child.stdin.write(`${line}
`);
      }
    }, answerBridgeRequest2 = function(message) {
      const method = message.method ?? "?";
      const queue = recordedAnswers.get(method);
      const recorded = queue?.shift();
      if (recorded === void 0) {
        stalls.push(
          `no recorded answer for bridge request ${method} (${String(message.id)})`
        );
        write2(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32e3,
              message: "parity replay: no recorded answer"
            }
          })
        );
        return;
      }
      write2(JSON.stringify({ ...recorded, id: message.id }));
    };
    var write = write2, answerBridgeRequest = answerBridgeRequest2;
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        ...launch.env,
        ...profile.env({ replayCommand, wrapperPath, stateDir })
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    spawnedChild = child;
    childEnded = new Promise((resolveEnded) => {
      const onEnded = () => {
        releaseStartup();
        resolveEnded();
      };
      child.once("exit", onEnded);
      child.once("error", onEnded);
    });
    const recordedCwd = recordedWorkspaceDir(recording);
    const jsonText = (value) => JSON.stringify(value).slice(1, -1);
    const restoreRecordedWorkspace = (line) => recordedCwd === null || recordedCwd === workspaceDir ? line : line.split(jsonText(workspaceDir)).join(jsonText(recordedCwd));
    const initializeId = PARITY_INITIALIZE_ID;
    const startedAt = Date.now();
    const lines = [];
    const lineTimes = [];
    const lineAfter = [];
    let lastSentRuntimeEntry = null;
    const events = [];
    const grammarViolations = [];
    const stalls = [];
    let stderr = "";
    const grammar = new ThreadEventGrammar();
    const liveAssembler = options.createAssembler(providerId);
    const planAssembler = (options.createPlanAssembler ?? options.createAssembler)(providerId);
    const exactPlan = options.planFromCurrentLane === true;
    const planRecording = exactPlan ? withCurrentBridgeLane(recording) : recording;
    const steps = planRuntimeSteps(planRecording, planAssembler);
    const plannedEventCount = exactPlan ? assembleRecordedEvents(
      planRecording,
      options.createPlanAssembler ?? options.createAssembler,
      providerId
    ).events.length : null;
    const answeredIds = /* @__PURE__ */ new Set();
    const pendingBridgeRequests = [];
    const recordedAnswers = /* @__PURE__ */ new Map();
    for (const step of steps) {
      if (step.message !== null && isResponse(step.message)) {
        const method = methodOfRecordedBridgeRequest(
          recording,
          step.entry,
          step.message.id
        ) ?? "?";
        const queue = recordedAnswers.get(method) ?? [];
        queue.push(step.message);
        recordedAnswers.set(method, queue);
      }
    }
    let lastOutputAt = Date.now();
    const exited = new Promise((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
      child.on("error", (error) => {
        stalls.push(`bridge spawn failed: ${error.message}`);
        resolveExit(null);
      });
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    readBoundedLines({
      input: child.stdout,
      onLine: (rawLine) => {
        const line = restoreRecordedWorkspace(rawLine);
        lastOutputAt = Date.now();
        lines.push(line);
        lineTimes.push(lastOutputAt - startedAt);
        lineAfter.push(lastSentRuntimeEntry);
        const message = parseWire(line);
        if (message === null) return;
        if (isResponse(message)) {
          answeredIds.add(String(message.id));
          return;
        }
        if (isRequest(message)) {
          pendingBridgeRequests.push({
            id: message.id,
            method: message.method
          });
          answerBridgeRequest2(message);
          return;
        }
        if (message.method === THREAD_DELTA_NOTIFICATION_METHOD) {
          let assembled;
          try {
            assembled = liveAssembler.assembleMessage(message);
          } catch (error) {
            stalls.push(
              `invalid thread/delta: ${error instanceof Error ? error.message : String(error)}`
            );
            return;
          }
          for (const event of assembled) {
            const result2 = grammar.observe(event);
            if (result2.kind === "violation") {
              grammarViolations.push({
                rule: result2.rule,
                reason: result2.reason,
                eventType: event.type
              });
              continue;
            }
            events.push(event);
          }
        }
      },
      onOverflow: (bytes) => {
        stalls.push(`oversized bridge line (${bytes} bytes)`);
      }
    });
    async function waitFor(label, predicate, limitMs = timeoutMs, reportStall = true) {
      const deadline = Date.now() + limitMs;
      while (!predicate()) {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === void 0) {
          stalls.push(`bridge exited while waiting for ${label}`);
          return;
        }
        if (Date.now() > deadline) {
          if (reportStall) stalls.push(`timed out waiting for ${label}`);
          return;
        }
        await sleep(10);
      }
    }
    const firstStep = steps.find(
      (step) => step.message !== null && isRequest(step.message)
    );
    setCursor(
      firstStep === void 0 ? "end" : { run: firstStep.entry.run, seq: firstStep.entry.seq }
    );
    write2(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
          client: { name: "bb-parity", version: "0" }
        }
      })
    );
    await waitFor("initialize response", () => answeredIds.has(initializeId));
    const initialized = answeredIds.has(initializeId);
    if (!initialized) {
      if (child.pid !== void 0 && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await childEnded;
    }
    releaseStartup();
    const sentRequestIds = [];
    for (const step of initialized ? steps : []) {
      if (step.message === null || !isRequest(step.message)) {
        if (step.message !== null && !isResponse(step.message)) {
          lastSentRuntimeEntry = {
            run: step.entry.run,
            seq: step.entry.seq,
            ts: step.entry.ts
          };
          write2(step.entry.line);
        }
        continue;
      }
      const request = step.message;
      const method = request.method;
      await waitFor(
        `earlier requests before ${method}`,
        () => sentRequestIds.every((id) => answeredIds.has(id))
      );
      await waitFor(
        `${step.gate.started} turn/started and ${step.gate.completed} turn/completed before ${method}`,
        () => {
          const live = countTurns(events);
          return live.started >= step.gate.started && live.completed >= step.gate.completed;
        }
      );
      await waitFor(
        `${step.eventsBefore} events before ${method}`,
        () => events.length >= step.eventsBefore || !exactPlan && Date.now() - lastOutputAt >= orderTimeoutMs,
        timeoutMs,
        exactPlan
      );
      await waitFor(
        `the stream to drain before ${method}`,
        () => Date.now() - lastOutputAt >= drainMs,
        timeoutMs,
        false
      );
      if (child.exitCode !== null) break;
      if (method === "thread/stop" && typeof request.params === "object" && request.params !== null && request.params.intent === "release") {
        const threadId = request.params.threadId;
        if (typeof threadId === "string") grammar.clearThread(threadId);
      }
      const rewritten = rewriteRecordedMachineFacts(
        step.entry.line,
        workspaceDir
      );
      const line = profile.rewriteRuntimeLine === void 0 ? rewritten : profile.rewriteRuntimeLine(rewritten, { replayCommand });
      lastSentRuntimeEntry = {
        run: step.entry.run,
        seq: step.entry.seq,
        ts: step.entry.ts
      };
      write2(line);
      sentRequestIds.push(String(request.id));
      const nextStep = steps.slice(steps.indexOf(step) + 1).find(
        (candidate) => candidate.message !== null && isRequest(candidate.message)
      );
      setCursor(
        nextStep === void 0 ? "end" : { run: nextStep.entry.run, seq: nextStep.entry.seq }
      );
    }
    setCursor("end");
    await waitFor(
      "the last responses",
      () => sentRequestIds.every((id) => answeredIds.has(id))
    );
    if (plannedEventCount !== null) {
      await waitFor(
        `all ${plannedEventCount} planned events before closing the bridge`,
        () => events.length >= plannedEventCount
      );
    }
    await waitFor(
      "the stream to settle",
      () => Date.now() - lastOutputAt >= settleMs
    );
    child.stdin?.end();
    let shutdownTimer;
    const exitCode = await Promise.race([
      exited,
      new Promise((resolveTimeout) => {
        shutdownTimer = setTimeout(() => {
          stalls.push("bridge did not exit after stdin closed; killed");
          child.kill("SIGKILL");
          resolveTimeout(null);
        }, timeoutMs);
      })
    ]);
    clearTimeout(shutdownTimer);
    return {
      providerId,
      recordingDir: options.recordingDir,
      lines,
      lineTimes,
      lineAfter,
      events,
      grammarViolations,
      stalls,
      stderr,
      exitCode
    };
  } finally {
    if (spawnedChild !== void 0 && spawnedChild.pid !== void 0 && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
      spawnedChild.kill("SIGKILL");
      await childEnded;
    }
    releaseStartup();
    for (const directory of [stateDir, workspaceDir]) {
      await rm(directory, {
        force: true,
        maxRetries: REPLAY_CLEANUP_RETRIES,
        recursive: true,
        retryDelay: REPLAY_CLEANUP_RETRY_DELAY_MS
      });
    }
  }
}
function assembleRecordedEvents(recording, createAssembler, providerId) {
  const assembler = createAssembler(providerId);
  const grammar = new ThreadEventGrammar();
  const events = [];
  const grammarViolations = [];
  const invalidDeltas = [];
  for (const entry of recording.entries) {
    if (entry.dir === "runtime\u2192bridge") {
      const message2 = parseWire(entry.line);
      if (message2 !== null && message2.method === "thread/stop" && typeof message2.params === "object" && message2.params !== null && message2.params.intent === "release") {
        const threadId = message2.params.threadId;
        if (typeof threadId === "string") grammar.clearThread(threadId);
      }
      continue;
    }
    if (entry.dir !== "bridge\u2192runtime") continue;
    const message = parseWire(entry.line);
    if (message === null || message.method !== THREAD_DELTA_NOTIFICATION_METHOD)
      continue;
    let assembled;
    try {
      assembled = assembler.assembleMessage(message);
    } catch (error) {
      invalidDeltas.push(
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }
    for (const event of assembled) {
      const result2 = grammar.observe(event);
      if (result2.kind === "violation") {
        grammarViolations.push({
          rule: result2.rule,
          reason: result2.reason,
          eventType: event.type
        });
        continue;
      }
      events.push(event);
    }
  }
  return { events, grammarViolations, invalidDeltas };
}
var TIME_FIELDS = /* @__PURE__ */ new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "startedAtMs",
  "completedAtMs",
  "timestamp",
  "ts",
  "resetsAtMs",
  "resetsAt",
  "expiresAt"
]);
function blankTimeFields(value) {
  if (Array.isArray(value)) {
    return value.map(blankTimeFields);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = TIME_FIELDS.has(key) && (typeof entry === "number" || typeof entry === "string") ? 0 : blankTimeFields(entry);
    }
    return out;
  }
  return value;
}
var ROW_ID_FIELDS = [
  "turnId",
  "itemId",
  "id",
  "parentToolCallId",
  "toolCallId",
  "callId",
  "requestId",
  "messageId",
  "rowId",
  "reasoningId",
  "agentId",
  "taskId",
  "backgroundTaskId",
  "sourceItemId",
  "interactionId"
];
function normalizeParityEvents(events) {
  return blankTimeFields(normalizeCalibrationEvents(events));
}
function normalizeParityRows(rows) {
  return blankTimeFields(
    normalizeCalibrationEvents(rows, {
      internedIdFields: ROW_ID_FIELDS
    })
  );
}
function pointerSegments(path) {
  return path.split("/").filter((segment) => segment.length > 0);
}
function maskPath(value, path) {
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    if (!Array.isArray(value)) return 0;
    const removed2 = value.length;
    value.length = 0;
    return removed2;
  }
  let removed = 0;
  const visit = (node, index) => {
    if (index >= segments.length || node === null || typeof node !== "object") {
      return;
    }
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (segment === "**") {
      visit(node, index + 1);
      for (const child of Object.values(node)) {
        visit(child, index);
      }
      return;
    }
    const keys = segment === "*" ? Object.keys(node) : Object.hasOwn(node, segment) ? [segment] : [];
    for (const key of keys) {
      if (last) {
        if (Array.isArray(node)) {
          node[Number(key)] = null;
        } else {
          delete node[key];
        }
        removed += 1;
      } else {
        visit(node[key], index + 1);
      }
    }
  };
  visit(value, 0);
  return removed;
}
function entryApplies(entry, provider, cell) {
  return (entry.provider === "*" || entry.provider === provider) && (entry.cell === "*" || entry.cell === cell);
}
function compareParity(oldRun, newRun, allowlist, scope) {
  const layers = {
    events: [
      normalizeParityEvents(oldRun.events),
      normalizeParityEvents(newRun.events)
    ],
    rows: [normalizeParityRows(oldRun.rows), normalizeParityRows(newRun.rows)]
  };
  const staleAllowlist = [];
  for (const entry of allowlist) {
    if (!entryApplies(entry, scope.provider, scope.cell)) continue;
    const [oldSide, newSide] = layers[entry.layer];
    const removed = maskPath(oldSide, entry.path) + maskPath(newSide, entry.path);
    if (removed === 0) {
      staleAllowlist.push(entry);
    }
  }
  const events = diffLayer(layers.events[0], layers.events[1]);
  const rows = diffLayer(layers.rows[0], layers.rows[1]);
  const grammar = diffLayer(
    (oldRun.grammarViolations ?? []).map(
      (violation2) => `${violation2.rule}:${violation2.eventType}`
    ),
    (newRun.grammarViolations ?? []).map(
      (violation2) => `${violation2.rule}:${violation2.eventType}`
    )
  );
  const clean = (diff) => diff.onlyInOld.length === 0 && diff.onlyInNew.length === 0;
  return {
    provider: scope.provider,
    cell: scope.cell,
    events,
    rows,
    grammar,
    staleAllowlist,
    passed: clean(events) && clean(rows) && clean(grammar) && staleAllowlist.length === 0
  };
}
function diffLayer(oldSide, newSide) {
  const diff = diffCalibrationStreams(oldSide, newSide);
  return { onlyInOld: diff.onlyInLegacy, onlyInNew: diff.onlyInBridge };
}

// ../provider-bridge-protocol/src/testing/rerecord.ts
import { writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var BRIDGE_TO_RUNTIME = "bridge\u2192runtime";
function parseWireLine(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
async function rerecordCurrentBridgeLane(options) {
  const recording = readBridgeRecording(options.recordingDir);
  const run = await replayRecording({ ...options, planFromCurrentLane: false });
  if (run.stalls.length > 0) {
    return {
      file: null,
      lines: 0,
      events: run.events.length,
      stalls: run.stalls
    };
  }
  const firstRuntime = recording.entries.find(
    (entry) => entry.dir === "runtime\u2192bridge"
  );
  const recordedRequestIds = /* @__PURE__ */ new Map();
  for (const entry of recording.entries) {
    if (entry.dir !== BRIDGE_TO_RUNTIME) continue;
    const message = parseWireLine(entry.line);
    if (message?.method === void 0 || message.id === void 0) continue;
    const queue = recordedRequestIds.get(message.method) ?? [];
    queue.push(message.id);
    recordedRequestIds.set(message.method, queue);
  }
  const entries = [];
  const perAnchor = /* @__PURE__ */ new Map();
  run.lines.forEach((rawLine, index) => {
    let line = rawLine;
    const message = parseWireLine(rawLine);
    if (message?.id === PARITY_INITIALIZE_ID) {
      return;
    }
    if (message?.method !== void 0 && message.id !== void 0) {
      const recordedId = recordedRequestIds.get(message.method)?.shift();
      if (recordedId !== void 0 && recordedId !== message.id) {
        line = JSON.stringify({ ...message, id: recordedId });
      }
    }
    const anchor = run.lineAfter[index] ?? (firstRuntime ? {
      run: firstRuntime.run,
      seq: firstRuntime.seq - 1,
      ts: firstRuntime.ts
    } : { run: 0, seq: 0, ts: 0 });
    const anchorKey = `${anchor.run}:${anchor.seq}`;
    const ordinal = (perAnchor.get(anchorKey) ?? 0) + 1;
    perAnchor.set(anchorKey, ordinal);
    entries.push({
      ts: anchor.ts + ordinal,
      run: anchor.run,
      seq: anchor.seq + ordinal / (run.lines.length + 1),
      dir: BRIDGE_TO_RUNTIME,
      line
    });
  });
  const file = join3(options.recordingDir, CURRENT_BRIDGE_LANE_FILE);
  writeFileSync2(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : "")
  );
  return { file, lines: entries.length, events: run.events.length, stalls: [] };
}
export {
  ASSEMBLER_GRAMMAR_VERSIONS,
  CONFORMANCE_ASSEMBLED_EVENT_METHOD,
  CURRENT_BRIDGE_LANE_FILE,
  DEFAULT_REPLAY_PROFILE,
  PARITY_INITIALIZE_ID,
  RECORDED_CONFORMANCE_CELLS,
  assembleCapturedThreadEvents as experimental_assembleCapturedThreadEvents,
  assembleRecordedEvents as experimental_assembleRecordedEvents,
  captureBridgeJsonRpcOutput as experimental_captureBridgeJsonRpcOutput,
  checkRecordedCellReplay as experimental_checkRecordedCellReplay,
  compareParity as experimental_compareParity,
  createBridgeDeltaEventCollector as experimental_createBridgeDeltaEventCollector,
  createBridgeJsonRpcTestHarness as experimental_createBridgeJsonRpcTestHarness,
  createDeltaAssembler as experimental_createDeltaAssembler,
  describeCalibrationEvents as experimental_describeCalibrationEvents,
  formatConformanceReport as experimental_formatConformanceReport,
  listRecordedCells as experimental_listRecordedCells,
  normalizeCalibrationEvents as experimental_normalizeCalibrationEvents,
  readBridgeRecording as experimental_readBridgeRecording,
  replayRecording as experimental_replayRecording,
  rerecordCurrentBridgeLane as experimental_rerecordCurrentBridgeLane,
  resolveProviderBridgeLaunch as experimental_resolveProviderBridgeLaunch,
  runBridgeConformance as experimental_runBridgeConformance,
  withCurrentBridgeLane as experimental_withCurrentBridgeLane
};
