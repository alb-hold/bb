import {
  useAppCommandHandler,
  useAppCommandShortcut,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { usePromptBoxModelPreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { formatModelLabel as formatFallbackModelLabel } from "@/hooks/thread-creation-options/selection-state";
import { isEditableKeyboardTarget } from "@/lib/app-keybindings";
import {
  APP_COMPOSER_SELECTOR,
  resolveComposerCommandScope,
} from "@/lib/composer-command-ownership";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { Button } from "@bb/shared-ui/button";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { Tooltip, TooltipTrigger, TooltipContent } from "@bb/shared-ui/tooltip";
import { Popover, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
} from "react";
import { stripModelBrandPrefix } from "./model-brand-prefix";
import { formatModelLoadErrorText } from "./model-load-error-message";
import { splitModelLabelTag } from "./model-picker-menu";
import {
  cycleReasoningValue,
  nextCycleValue,
  previousCycleValue,
} from "./modelPickerCycle";
import {
  ownsModelPickerCycleChord,
  resolveModelPickerToggle,
  type ModelPickerScope,
} from "./modelPickerToggle";

import type { ModelReasoningPickerProps } from "./model-reasoning-contract";
import { ModelReasoningPickerBody } from "./ModelReasoningPickerBodySplit";
import { ModelReasoningMenu } from "./ModelReasoningMenuSplit";

const warmPicker = () => {
  void ModelReasoningPickerBody.preload();
  void ModelReasoningMenu.preload();
};
export {
  buildModelNavRows,
  type ModelNavRow,
  type ModelReasoningPickerHandoff,
  type ModelReasoningPickerHandoffSelection,
} from "./model-reasoning-contract";
const FAILED_TO_LOAD_MODELS_LABEL = "Failed to load models";

export function ModelReasoningPicker(props: ModelReasoningPickerProps) {
  const {
    providerOptions,
    selectedProviderId,
    onSelectedProviderChange,
    hasMultipleProviders,
    unavailableModel,
    modelValue,
    modelOptions,
    modelIsLoading = false,
    modelLoadFailed = false,
    modelLoadError,
    onModelChange,
    formatModelLabel,
    reasoningValue,
    reasoningOptions,
    onReasoningChange,
    serviceTierValue,
    serviceTierOptions,
    commandShortcutsEnabled = true,
    className,
    compactIconOnly = false,
    muted,
    modal = true,
    disabled,
    handoff,
  } = props;
  const isCompactViewport = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  const [realized, setRealized] = useState(false);
  const [startupProvider, setStartupProvider] = useState<string | null>(null);
  const [startupReasoning, setStartupReasoning] = useState<
    typeof reasoningValue | null
  >(null);
  const onRealized = useCallback(() => setRealized(true), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyDownRef = useRef<KeyboardEventHandler<HTMLElement> | null>(null);
  const registeredToggleShortcut = useAppCommandShortcut("modelPicker.toggle");
  const toggleShortcut = commandShortcutsEnabled
    ? registeredToggleShortcut
    : null;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void ModelReasoningPickerBody.preload();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);
  const selectedProvider = providerOptions.find(
    (p) => p.value === selectedProviderId,
  );
  const ProviderIcon = selectedProvider?.icon;
  const { value: rememberedModel } =
    usePromptBoxModelPreference(selectedProviderId);
  const displayModel = modelValue || (modelIsLoading ? rememberedModel : "");
  const selectedModelOption = modelOptions.find(
    (m) => m.value === displayModel,
  );
  const selectedModelLabel = (formatModelLabel ?? formatFallbackModelLabel)(
    selectedModelOption?.label ?? displayModel,
  );
  const modelSubstitutionNote = unavailableModel
    ? `${unavailableModel} isn't available; using ${selectedModelLabel}`
    : undefined;
  const hasSelectedModel = selectedModelLabel.trim().length > 0;
  const showLoadingTrigger = modelIsLoading && !hasSelectedModel;
  const selectedProviderLabel = selectedProvider?.label ?? selectedProviderId;
  const selectedModelLoadErrorMatches =
    modelLoadError?.providerId === selectedProviderId;
  const selectedModelLoadFailed =
    modelLoadFailed || selectedModelLoadErrorMatches;
  const canSwitchProviders =
    hasMultipleProviders &&
    onSelectedProviderChange !== undefined &&
    providerOptions.length > 1;
  const hasAlternateSelectionPath =
    modelOptions.length > 0 ||
    (selectedModelLoadErrorMatches && canSwitchProviders);
  const selectedModelLoadErrorText =
    selectedModelLoadErrorMatches && modelLoadError
      ? formatModelLoadErrorText({
          error: modelLoadError,
          providerLabel: selectedProviderLabel,
        })
      : "Could not load models.";
  const triggerModelLabel = showLoadingTrigger
    ? "Model"
    : hasSelectedModel
      ? stripModelBrandPrefix(
          selectedModelLabel,
          selectedProvider?.brandPrefix ??
            (selectedProviderId === "codex" ? "GPT-" : undefined),
        )
      : selectedModelLoadFailed
        ? hasAlternateSelectionPath
          ? "Select model"
          : FAILED_TO_LOAD_MODELS_LABEL
        : modelOptions.length === 0
          ? canSwitchProviders
            ? "Select model"
            : "No models available"
          : "Select model";
  const triggerModelValueIsDestructive =
    triggerModelLabel === FAILED_TO_LOAD_MODELS_LABEL;
  const { base: triggerModelBase, tag: triggerModelTag } =
    splitModelLabelTag(triggerModelLabel);

  const selectedReasoningOption = reasoningOptions.find(
    (r) => r.value === reasoningValue,
  );
  const triggerReasoningLabel = hasSelectedModel
    ? (selectedReasoningOption?.label ??
      (modelIsLoading ? reasoningLevelLabel(reasoningValue, undefined) : null))
    : null;

  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const isSplitPane = paneContext?.isSplitPane ?? false;
  const resolveCommandScope = useCallback(
    (target: EventTarget | null): ModelPickerScope => {
      const scope = resolveComposerCommandScope({
        composer: triggerRef.current?.closest(APP_COMPOSER_SELECTOR) ?? null,
        target,
        isFocusedPane,
      });
      return {
        ...scope,
        disabled: disabled ?? false,
        isSplitPane,
        editableOutsideComposer:
          !scope.caretInThisComposer &&
          !scope.caretInOtherComposer &&
          isEditableKeyboardTarget(target),
      };
    },
    [disabled, isFocusedPane, isSplitPane],
  );

  useAppCommandHandler(
    "modelPicker.toggle",
    ({ target }) => {
      if (realized || !commandShortcutsEnabled) return false;
      const action = resolveModelPickerToggle({
        open,
        ...resolveCommandScope(target),
      });
      if (action === "ignore") return false;
      setOpen(action === "open");
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  const ownsCycle = (target: EventTarget | null) =>
    !realized &&
    commandShortcutsEnabled &&
    ownsModelPickerCycleChord({ open, ...resolveCommandScope(target) });
  useIndexedAppCommandHandlers(
    ["modelPicker.cycleModel", "modelPicker.cycleModelBackward"],
    (index, { target }) => {
      if (!ownsCycle(target)) return false;
      if (
        handoff?.active &&
        startupProvider !== null &&
        startupProvider !== selectedProviderId
      )
        return true;
      const options = modelOptions.filter((option) => option.disabled !== true);
      const next =
        index === 0
          ? nextCycleValue(options, modelValue)
          : previousCycleValue(options, modelValue);
      if (next !== null) {
        if (handoff?.active)
          handoff.onSelect({
            providerId: selectedProviderId,
            model: next,
            reasoningLevel: startupReasoning ?? reasoningValue,
          });
        else onModelChange(next);
      }
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    ["modelPicker.cycleProvider", "modelPicker.cycleProviderBackward"],
    (index, { target }) => {
      if (!ownsCycle(target)) return false;
      if (handoff?.active) {
        const next =
          index === 0
            ? nextCycleValue(
                providerOptions,
                startupProvider ?? selectedProviderId,
              )
            : previousCycleValue(
                providerOptions,
                startupProvider ?? selectedProviderId,
              );
        if (next !== null) {
          handoff.onStart();
          setStartupProvider(next === selectedProviderId ? null : next);
          setStartupReasoning(null);
        }
        return true;
      }
      if (canSwitchProviders) {
        const next =
          index === 0
            ? nextCycleValue(providerOptions, selectedProviderId)
            : previousCycleValue(providerOptions, selectedProviderId);
        if (next !== null) onSelectedProviderChange?.(next);
      }
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    ["modelPicker.cycleReasoning", "modelPicker.cycleReasoningBackward"],
    (index, { target }) => {
      if (!ownsCycle(target)) return false;
      if (
        handoff?.active &&
        startupProvider !== null &&
        startupProvider !== selectedProviderId
      )
        return true;
      const next = cycleReasoningValue(
        reasoningOptions,
        startupReasoning ?? reasoningValue,
        index === 0 ? "forward" : "backward",
      );
      if (next !== null) {
        if (handoff?.active) setStartupReasoning(next);
        onReasoningChange(next);
      }
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  const handleReasoningArrowKeyDown: KeyboardEventHandler<HTMLElement> = (
    event,
  ) => {
    if (realized) {
      keyDownRef.current?.(event);
      return;
    }
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      disabled ||
      !hasSelectedModel ||
      modelIsLoading ||
      selectedModelLoadFailed ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const index = reasoningOptions.findIndex(
      (option) => option.value === reasoningValue,
    );
    const next =
      reasoningOptions[index + (event.key === "ArrowRight" ? 1 : -1)];
    if (index >= 0 && next) onReasoningChange(next.value);
  };
  const selectedServiceTierOption =
    hasSelectedModel && modelOptions.length > 0
      ? serviceTierOptions.find((option) => option.id === serviceTierValue)
      : undefined;
  const TriggerIcon = ProviderIcon;
  const showCompactIconOnly = compactIconOnly && isCompactViewport;
  const triggerTitleModelLabel = showLoadingTrigger
    ? "Model"
    : selectedModelLoadFailed
      ? selectedModelLoadErrorText
      : triggerModelLabel;
  const triggerTitle = [
    [selectedProviderLabel, triggerTitleModelLabel]
      .filter((label) => label.trim().length > 0)
      .join(": "),
    triggerReasoningLabel ? ` · ${triggerReasoningLabel} reasoning` : "",
    selectedServiceTierOption
      ? ` (${selectedServiceTierOption.label} mode)`
      : "",
  ].join("");
  const compactSelectionLabel = [
    selectedProviderLabel,
    selectedModelLabel || "Model",
  ]
    .filter((label) => label.trim().length > 0)
    .join(": ");
  const compactReasoningLabel =
    triggerReasoningLabel ?? reasoningLevelLabel(reasoningValue, undefined);
  const compactAccessibleLabel =
    !selectedProviderLabel.trim() && !hasSelectedModel
      ? "Model"
      : `Provider, model and reasoning: ${[
          compactSelectionLabel,
          compactReasoningLabel ? `${compactReasoningLabel} reasoning` : "",
        ]
          .filter(Boolean)
          .join(" · ")}`;
  const triggerAccessibleLabel = showCompactIconOnly
    ? compactAccessibleLabel
    : toggleShortcut
      ? `Provider, model and reasoning (${toggleShortcut.label})`
      : "Provider, model and reasoning";
  const trigger = (
    <Button
      ref={triggerRef}
      data-model-reasoning-trigger=""
      data-model-loading={showLoadingTrigger ? "" : undefined}
      type="button"
      variant="ghost"
      size="sm"
      aria-label={triggerAccessibleLabel}
      aria-description={modelSubstitutionNote ?? triggerTitle}
      aria-keyshortcuts={toggleShortcut?.ariaKeyshortcuts}
      disabled={disabled}
      onPointerEnter={warmPicker}
      onPointerDown={warmPicker}
      onFocus={warmPicker}
      onKeyDown={handleReasoningArrowKeyDown}
      className={cn(
        OPTION_BASE_CLASS_NAME,
        OPTION_INTERACTIVE_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        muted && OPTION_MUTED_CLASS_NAME,
        muted && "font-normal",
        disabled && "cursor-default disabled:opacity-100",
        showLoadingTrigger &&
          "w-44 [&>span]:invisible animate-pulse bg-state-hover",
        className,
      )}
    >
      <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
        {selectedServiceTierOption ? (
          <Icon
            name={selectedServiceTierOption.icon ?? "Zap"}
            className="size-3.5 shrink-0 fill-current text-subtle-foreground"
          />
        ) : TriggerIcon ? (
          <TriggerIcon className="size-4 shrink-0" />
        ) : (
          <Icon name="Bot" className="size-4 shrink-0" />
        )}
        {showCompactIconOnly ? null : (
          <>
            <span
              data-model-name=""
              className={cn(
                "min-w-0 truncate",
                triggerModelValueIsDestructive && "text-destructive-text",
              )}
            >
              {triggerModelBase}
            </span>
            {triggerModelTag ? (
              <span
                data-model-tag=""
                className="shrink-0 text-subtle-foreground"
              >
                {triggerModelTag}
              </span>
            ) : null}
            {triggerReasoningLabel ? (
              <span
                className="shrink-0 text-subtle-foreground"
                data-promptbox-hide-compact=""
              >
                {triggerReasoningLabel}
              </span>
            ) : null}
          </>
        )}
      </span>
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5 shrink-0",
          muted ? "text-subtle-foreground/75" : "text-muted-foreground",
        )}
      />
      <AppCommandShortcutHint
        shortcut={disabled ? null : toggleShortcut}
        className="ml-1"
      />
    </Button>
  );

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen} modal={modal}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {modelSubstitutionNote ?? triggerTitle}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ModelReasoningPickerBody
        initialPreviewProviderId={startupProvider}
        initialReasoningLevel={startupReasoning}
        {...props}
        open={open}
        setOpen={setOpen}
        triggerRef={triggerRef}
        onRealized={onRealized}
        keyDownRef={keyDownRef}
      />
    </Popover>
  );
}
