import type {
  ExperimentalComposerAction,
  ExperimentalComposerSubmission,
} from "@get-bb/plugin-sdk";
import { flushPendingPromptDraftPersists } from "@/hooks/usePromptDraftStorage";
import type {
  ComposerBoxProps,
  PromptBoxSubmissionConfig,
} from "./ComposerBox";
import {
  modifierSubmitShortcutAria,
  modifierSubmitShortcutLabel,
} from "./modifier-submit-shortcut";

const ignoreReportedSubmitError = () => {};

const ENTER_SHORTCUT = { label: "Enter", ariaKeyshortcuts: "Enter" };

export function composerSubmission(
  submission: PromptBoxSubmissionConfig | undefined,
  onSubmit: ComposerBoxProps["onSubmit"],
): ExperimentalComposerSubmission {
  const {
    onModifierSubmit,
    queuesDraft = false,
    swapSubmitActions = false,
    showModifierSubmitAction = false,
    ...state
  } = submission ?? {};
  const runReported =
    (handler: () => void | Promise<void>): ExperimentalComposerAction["run"] =>
    () => {
      flushPendingPromptDraftPersists();
      void Promise.resolve(handler()).catch(ignoreReportedSubmitError);
    };
  const draft = {
    kind: queuesDraft || swapSubmitActions ? "queue" : "send",
    requiresInput: true,
    run: runReported(() => onSubmit()),
  } as const;
  const steer =
    onModifierSubmit === undefined
      ? null
      : ({
          kind: "steer",
          requiresInput: false,
          run: runReported(() => onModifierSubmit()),
        } as const);
  const [enter, modifier] =
    swapSubmitActions && steer !== null ? [steer, draft] : [draft, steer];
  return {
    ...state,
    enter: { ...enter, shortcut: ENTER_SHORTCUT },
    modifier:
      modifier === null
        ? null
        : {
            ...modifier,
            shortcut: {
              label: modifierSubmitShortcutLabel(),
              ariaKeyshortcuts: modifierSubmitShortcutAria(),
            },
          },
    showModifierInMenu: showModifierSubmitAction,
  };
}
