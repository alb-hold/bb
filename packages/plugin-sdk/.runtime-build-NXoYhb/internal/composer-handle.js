// src/internal/composer-draft-transforms.ts
function removeComposerMentions(draft, matches) {
  const removed = draft.mentions.filter(matches).sort((a, b) => a.from - b.from);
  if (removed.length === 0) return draft;
  let text = "";
  let cursor = 0;
  for (const mention of removed) {
    text += draft.text.slice(cursor, mention.from);
    cursor = mention.to;
  }
  const removedSet = new Set(removed);
  const mentions = draft.mentions.filter((mention) => !removedSet.has(mention)).map((mention) => {
    const offset = removed.reduce(
      (sum, item) => sum + (item.to <= mention.from ? item.to - item.from : 0),
      0
    );
    return offset === 0 ? mention : { ...mention, from: mention.from - offset, to: mention.to - offset };
  });
  return { ...draft, text: text + draft.text.slice(cursor), mentions };
}
function setComposerText(draft, text) {
  if (text === draft.text) return draft;
  return {
    ...draft,
    text,
    mentions: reconcileComposerMentions(draft.text, text, draft.mentions)
  };
}
function reconcileComposerMentions(currentText, nextText, mentions) {
  if (currentText === nextText) return [...mentions];
  let unchangedPrefixLength = 0;
  const maximumPrefixLength = Math.min(currentText.length, nextText.length);
  while (unchangedPrefixLength < maximumPrefixLength && currentText[unchangedPrefixLength] === nextText[unchangedPrefixLength]) {
    unchangedPrefixLength += 1;
  }
  let unchangedSuffixLength = 0;
  while (unchangedSuffixLength < currentText.length - unchangedPrefixLength && unchangedSuffixLength < nextText.length - unchangedPrefixLength && currentText[currentText.length - unchangedSuffixLength - 1] === nextText[nextText.length - unchangedSuffixLength - 1]) {
    unchangedSuffixLength += 1;
  }
  const replacedCurrentEnd = currentText.length - unchangedSuffixLength;
  const replacementDelta = nextText.length - currentText.length;
  return mentions.flatMap((mention) => {
    if (mention.to <= unchangedPrefixLength) return [mention];
    if (mention.from >= replacedCurrentEnd) {
      return [
        {
          ...mention,
          from: mention.from + replacementDelta,
          to: mention.to + replacementDelta
        }
      ];
    }
    return [];
  });
}

// src/internal/composer-draft-actions.ts
import { z } from "zod";
var range = {
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  label: z.string()
};
var mentionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...range,
    kind: z.literal("thread"),
    threadId: z.string(),
    projectId: z.string().optional()
  }),
  z.object({ ...range, kind: z.literal("project"), projectId: z.string() }),
  z.object({ ...range, kind: z.literal("section"), sectionId: z.string() }),
  z.object({
    ...range,
    kind: z.literal("path"),
    path: z.string(),
    source: z.enum(["workspace", "thread-storage"]),
    entryKind: z.enum(["file", "directory"])
  }),
  z.object({
    ...range,
    kind: z.literal("command"),
    trigger: z.enum(["/", "$"]),
    name: z.string(),
    source: z.enum(["skill", "command"]),
    origin: z.enum(["builtin", "project", "user"]),
    argumentHint: z.string().nullable()
  }),
  z.object({ ...range, kind: z.literal("attachment"), path: z.string() }),
  z.object({
    ...range,
    kind: z.literal("plugin"),
    pluginId: z.string(),
    provider: z.string().min(1).refine((value) => !value.includes(":")),
    id: z.string(),
    icon: z.string().nullable().optional()
  })
]);
var attachmentFields = {
  type: z.enum(["localImage", "localFile"]),
  path: z.string().min(1),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().nonnegative().optional()
};
var attachmentsSchema = z.array(
  z.union([
    z.object({
      ...attachmentFields,
      hostId: z.string().min(1),
      sourceProjectId: z.undefined().optional()
    }),
    z.object({
      ...attachmentFields,
      sourceProjectId: z.string().min(1).optional(),
      hostId: z.undefined().optional()
    })
  ])
);
var replacementSchema = z.object({
  text: z.string(),
  mentions: z.array(mentionSchema),
  attachments: attachmentsSchema.optional()
}).superRefine((draft, context) => {
  let end = 0;
  for (const mention of [...draft.mentions].sort((a, b) => a.from - b.from)) {
    if (mention.from < end || mention.to <= mention.from || mention.to > draft.text.length) {
      context.addIssue({
        code: "custom",
        message: "Mention ranges must be non-overlapping and inside the draft text."
      });
    }
    end = mention.to;
  }
});
function createComposerDraftActions(target) {
  let cached = null;
  const snapshotOf = (current) => {
    const content = current.getDraft();
    if (cached?.content === content) return cached.snapshot;
    const snapshot = Object.freeze({
      text: content.text,
      mentions: Object.freeze(
        content.mentions.map((mention) => Object.freeze({ ...mention }))
      ),
      attachments: Object.freeze(
        content.attachments.map(
          (attachment) => Object.freeze({ ...attachment })
        )
      )
    });
    cached = { content, snapshot };
    return snapshot;
  };
  const requireAvailable = (current) => {
    if (!current.isAvailable())
      throw new Error("This composer is no longer available.");
  };
  return {
    get draft() {
      return snapshotOf(target());
    },
    replace(next) {
      const current = target();
      requireAvailable(current);
      const snapshot = snapshotOf(current);
      const result = typeof next === "function" ? next(snapshot) : next;
      requireAvailable(current);
      if (result === snapshot) return;
      const parsed = replacementSchema.safeParse(result);
      if (!parsed.success)
        throw new Error(
          "Invalid composer draft: text, mention ranges, or attachments are invalid."
        );
      current.setDraft(parsed.data);
    },
    focus() {
      const current = target();
      requireAvailable(current);
      current.focus();
    }
  };
}

// src/internal/composer-handle.ts
var UNAVAILABLE_MESSAGE = "This composer is no longer available.";
var OFF_SCREEN_MESSAGE = "This composer isn't on screen.";
var OFF_SCREEN_EDITOR_STATE = {
  layout: "expanded",
  isRunning: false,
  isSubmitting: false,
  isSubmittingBlocked: true,
  submittingBlockedReason: OFF_SCREEN_MESSAGE,
  isAttaching: false,
  attachmentError: null
};
var warnedAliases = /* @__PURE__ */ new Set();
function warnDeprecatedComposerMember(oldName, newName) {
  if (warnedAliases.has(oldName)) return;
  warnedAliases.add(oldName);
  console.warn(
    `useComposer().${oldName} is deprecated; use useComposer().${newName}.`
  );
}
function appendComposerDraft(current, value, block) {
  const base = block ? current.text.replace(/\s+$/u, "") : current.text;
  const separator = block && base.length > 0 ? "\n\n" : "";
  const offset = base.length + separator.length;
  return {
    text: `${base}${separator}${value.text}`,
    mentions: [
      ...current.mentions.filter((mention) => mention.to <= base.length),
      ...value.mentions.map((mention) => ({
        ...mention,
        from: mention.from + offset,
        to: mention.to + offset
      }))
    ]
  };
}
function validProviderId(provider) {
  const trimmed = provider.trim();
  return trimmed.length === 0 || trimmed.includes(":") ? null : trimmed;
}
function insertValue(parts, controller) {
  const list = Array.isArray(parts) ? parts : [parts];
  let text = "";
  const mentions = [];
  for (const part of list) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    let mention;
    if ("kind" in part) {
      mention = part;
    } else {
      const provider = validProviderId(part.provider);
      if (provider === null) {
        throw new Error(`Invalid mention provider id "${part.provider}".`);
      }
      mention = {
        from: 0,
        to: 0,
        label: part.label.trim() || part.id,
        kind: "plugin",
        pluginId: controller.pluginId,
        provider,
        id: part.id,
        icon: null
      };
    }
    const serialized = controller.mentionText(mention);
    mentions.push({
      ...mention,
      from: text.length,
      to: text.length + serialized.length
    });
    text += serialized;
  }
  return { text, mentions };
}
function isDraftEmpty(draft, attachmentCount) {
  return draft.text.trim().length === 0 && draft.mentions.length === 0 && attachmentCount === 0;
}
var legacyDrafts = /* @__PURE__ */ new WeakMap();
function withLegacyDraftFields(draft, attachmentCount) {
  const cached = legacyDrafts.get(draft);
  if (cached) return cached;
  const snapshot = { ...draft };
  Object.defineProperties(snapshot, {
    isEmpty: { value: isDraftEmpty(draft, attachmentCount), enumerable: false },
    attachmentCount: { value: attachmentCount, enumerable: false }
  });
  Object.freeze(snapshot);
  legacyDrafts.set(draft, snapshot);
  return snapshot;
}
function waitForUploads(target) {
  return new Promise((resolve) => {
    if (!target.getEditorState().isAttaching) {
      resolve();
      return;
    }
    const unsubscribe = target.subscribeEditorState(() => {
      if (target.getEditorState().isAttaching) return;
      unsubscribe();
      resolve();
    });
  });
}
function createComposerHandleBinding(key, initial) {
  let controller = initial;
  const target = () => controller.target;
  const editorState = () => target().getEditorState();
  const requireAvailable = () => {
    if (!target().isAvailable()) throw new Error(UNAVAILABLE_MESSAGE);
  };
  const legacyAvailable = (method) => {
    if (target().isAvailable()) return true;
    console.warn(
      `[plugin:${controller.pluginId}] useComposer().${method}: ${UNAVAILABLE_MESSAGE}`
    );
    return false;
  };
  const replaceText = (nextText) => {
    const current = target().getDraft();
    if (nextText === current.text) return;
    target().setDraft(setComposerText(current, nextText));
  };
  const insertMention = (mention) => {
    warnDeprecatedComposerMember("insertMention", "insert");
    const provider = validProviderId(mention.provider);
    if (provider === null) {
      console.warn(
        `[plugin:${controller.pluginId}] useComposer().insertMention: invalid provider id "${mention.provider}"`
      );
      return;
    }
    if (!legacyAvailable("insertMention")) return;
    const label = mention.label.trim() || mention.id;
    const current = target().getDraft();
    const separator = current.text.length === 0 || /\s$/u.test(current.text) ? "" : " ";
    const from = current.text.length + separator.length;
    target().setDraft({
      text: `${current.text}${separator}${label} `,
      mentions: [
        ...current.mentions,
        {
          from,
          to: from + label.length,
          label,
          kind: "plugin",
          pluginId: controller.pluginId,
          provider,
          id: mention.id,
          icon: null
        }
      ]
    });
    target().focus();
  };
  const removeMentionFrom = (mention) => {
    const current = target().getDraft();
    const next = removeComposerMentions(
      current,
      (item) => item.kind === "plugin" && item.pluginId === controller.pluginId && item.provider === mention.provider && item.id === mention.id
    );
    if (next !== current) target().setDraft(next);
  };
  const removeMention = (mention) => {
    warnDeprecatedComposerMember("removeMention", "replace");
    requireAvailable();
    removeMentionFrom(mention);
  };
  const insert = (parts, options = {}) => {
    requireAvailable();
    const value = insertValue(parts, controller);
    const block = options.block === true;
    if ((options.at ?? "cursor") === "cursor") {
      if (!target().insertAtCursor(value, block)) {
        throw new Error(OFF_SCREEN_MESSAGE);
      }
      return;
    }
    target().setDraft(appendComposerDraft(target().getDraft(), value, block));
  };
  const submit = async (options) => {
    requireAvailable();
    const hostSubmit = target().submit;
    if (hostSubmit === void 0) {
      throw new Error("This composer cannot submit programmatically.");
    }
    if (options.sendAt !== void 0 && (!Number.isFinite(options.sendAt) || options.sendAt <= Date.now())) {
      throw new Error("Pick a time in the future.");
    }
    const errorBefore = editorState().attachmentError;
    await waitForUploads(target());
    const state = editorState();
    if (state.attachmentError !== null && state.attachmentError !== errorBefore) {
      throw new Error(state.attachmentError);
    }
    if (state.isSubmittingBlocked) {
      throw new Error(
        state.submittingBlockedReason ?? "This composer can't submit right now."
      );
    }
    await hostSubmit(
      options,
      options.experimental_data === void 0 ? void 0 : { pluginId: controller.pluginId, data: options.experimental_data }
    );
  };
  const setSelection = async (selection) => {
    requireAvailable();
    const hostSetSelection = target().setSelection;
    if (hostSetSelection === void 0) {
      throw new Error("This composer has no pickers to set.");
    }
    return hostSetSelection(selection);
  };
  const submittedListeners = /* @__PURE__ */ new Set();
  let submittedSubscription = null;
  const syncSubmittedSubscription = () => {
    const scope = submittedListeners.size === 0 ? null : JSON.stringify(target().scope);
    if (submittedSubscription?.scope === scope) return;
    submittedSubscription?.unsubscribe();
    submittedSubscription = scope === null ? null : {
      scope,
      unsubscribe: controller.onSubmitted(() => {
        for (const listener of [...submittedListeners]) {
          try {
            listener();
          } catch (error) {
            console.error("Composer submission listener failed", error);
          }
        }
      })
    };
  };
  const onSubmitted = (listener) => {
    const entry = () => listener();
    submittedListeners.add(entry);
    syncSubmittedSubscription();
    return () => {
      submittedListeners.delete(entry);
      syncSubmittedSubscription();
    };
  };
  const draftActions = createComposerDraftActions(target);
  const handle = {
    replace: draftActions.replace,
    get scope() {
      return target().scope;
    },
    get key() {
      return target().key;
    },
    get layout() {
      return editorState().layout;
    },
    get isRunning() {
      return editorState().isRunning;
    },
    get isSubmitting() {
      return editorState().isSubmitting;
    },
    get isSubmittingBlocked() {
      return editorState().isSubmittingBlocked;
    },
    get submittingBlockedReason() {
      return editorState().submittingBlockedReason;
    },
    get isEmpty() {
      return isDraftEmpty(target().getDraft(), target().getAttachmentCount());
    },
    get attachmentCount() {
      return target().getAttachmentCount();
    },
    get text() {
      return target().getDraft().text;
    },
    get draft() {
      return withLegacyDraftFields(
        draftActions.draft,
        target().getAttachmentCount()
      );
    },
    get selection() {
      return target().getSelection();
    },
    setText: (next) => {
      warnDeprecatedComposerMember("setText", "replace");
      if (legacyAvailable("setText")) replaceText(next);
    },
    updateText: (updater) => {
      warnDeprecatedComposerMember("updateText", "replace");
      if (legacyAvailable("updateText")) {
        replaceText(updater(target().getDraft().text));
      }
    },
    clear: () => {
      warnDeprecatedComposerMember("clear", "replace");
      if (legacyAvailable("clear")) replaceText("");
    },
    insert,
    setTextEffect: (effect) => controller.setTextEffect(effect),
    setInputLock: (locked) => controller.setInputLock(locked),
    addQuote: (text) => {
      warnDeprecatedComposerMember("addQuote", "replace");
      if (!legacyAvailable("addQuote")) return;
      target().addQuote(text);
      target().focus();
    },
    insertMention,
    removeMention,
    onSubmitted,
    focus: () => target().focus(),
    experimental_openPopup: (id) => target().openPopup?.(controller.pluginId, id) ?? false,
    experimental_closePopup: () => target().closePopup?.(controller.pluginId) ?? false,
    submit,
    get experimental_createData() {
      return target().getCreateData?.(controller.pluginId) ?? null;
    },
    experimental_setCreateData: (data) => {
      const current = target();
      if (current.scope.kind !== "new-thread" || current.setCreateData === void 0) {
        throw new Error("Creation data requires a new-thread composer.");
      }
      current.setCreateData(controller.pluginId, data);
    },
    setSelection,
    experimental_removeMention: (mention) => {
      warnDeprecatedComposerMember("experimental_removeMention", "replace");
      if (!legacyAvailable("experimental_removeMention")) return;
      removeMentionFrom(mention);
    },
    experimental_onSubmitted: (listener) => {
      warnDeprecatedComposerMember("experimental_onSubmitted", "onSubmitted");
      return onSubmitted(listener);
    },
    experimental_submit: (options) => {
      warnDeprecatedComposerMember("experimental_submit", "submit");
      return submit(options);
    },
    experimental_setSelection: (selection) => {
      warnDeprecatedComposerMember("experimental_setSelection", "setSelection");
      return setSelection(selection);
    }
  };
  Object.defineProperties(handle, {
    run: {
      enumerable: false,
      get: () => {
        const state = editorState();
        return { isRunning: state.isRunning, isSubmitting: state.isSubmitting };
      }
    },
    setThreadRowStatus: { enumerable: false, value: () => {
    } }
  });
  return {
    key,
    handle,
    update(next) {
      controller = next;
      syncSubmittedSubscription();
    }
  };
}
export {
  OFF_SCREEN_EDITOR_STATE,
  appendComposerDraft,
  createComposerDraftActions,
  createComposerHandleBinding,
  reconcileComposerMentions
};
