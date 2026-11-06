import { memo } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { Icon } from "@bb/shared-ui/icon";
import { ToggleGroup, ToggleGroupItem } from "@bb/shared-ui/toggle-group";
import type {
  PermissionMode,
  ProviderOptionDescriptor,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@bb/server-contract";
import { formatModelLabel } from "@/hooks/thread-creation-options/selection-state";
import {
  ModelReasoningPicker,
  type ModelReasoningPickerHandoff,
} from "@/components/pickers/ModelReasoningPicker";
import { type PickerOption } from "@/components/pickers/OptionPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { ProviderPickerOption } from "@/components/pickers/model-brand-prefix";
import type {
  SessionOptionChoice,
  SessionOptionMenuSection,
} from "@/components/pickers/SessionOptionsMenu";

const EMPTY_SERVICE_TIER_OPTIONS: readonly ProviderOptionDescriptor[] = [];

interface ExecutionProviderConfig {
  options?: readonly ProviderPickerOption[];
  selectedId?: string;
  onChange?: (value: string) => void;
  hasMultiple?: boolean;
}

interface ExecutionModelConfig {
  unavailableModel?: string;
  active?: { model: string } | null;
  selected: string;
  options: readonly ModelPickerOption[];
  moreOptions: readonly ModelPickerOption[];
  isLoading: boolean;
  loadFailed: boolean;
  loadError?: SystemExecutionOptionsModelLoadError | null;
  onChange: (value: string) => void;
}

interface ExecutionServiceTierConfig {
  value?: ServiceTier;
  onChange: (value: ServiceTier | undefined) => void;
  supported: boolean;
  supportByProvider?: Record<string, boolean>;
  options: readonly ProviderOptionDescriptor[];
}

interface ExecutionReasoningConfig {
  value: ReasoningLevel;
  options: readonly PickerOption<ReasoningLevel>[];
  onChange: (value: ReasoningLevel) => void;
}

const NATIVE_TERMINAL_CHOICES = [
  {
    value: "chat",
    label: "Chat",
    icon: "MessageSquare",
    title: "bb renders the conversation",
  },
  {
    value: "terminal",
    label: "Terminal",
    icon: "Terminal",
    title: "Runs the provider's own CLI",
  },
] as const;

export interface ExecutionPermissionConfig {
  pending?: boolean;
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
}

export interface ExecutionNativeTerminalConfig {
  enabled: boolean;
  disabled?: boolean;
  unavailableReason?: string;
  onChange: (enabled: boolean) => void;
}

export interface ExecutionAgentOptionsConfig {
  sections: readonly SessionOptionMenuSection[];
  onChange: (optionId: string, value: SessionOptionChoice) => void;
}

export interface ExecutionControlsProps {
  pending?: boolean;
  nativeTerminal?: ExecutionNativeTerminalConfig;
  providerRouting?: SystemProvidersQuery;
  provider: ExecutionProviderConfig;
  model: ExecutionModelConfig;
  serviceTier?: ExecutionServiceTierConfig;
  agentOptions?: ExecutionAgentOptionsConfig;
  reasoning: ExecutionReasoningConfig;
  handoff?: ModelReasoningPickerHandoff;
  disabled?: boolean;
}

export const ExecutionControls = memo(function ExecutionControls({
  pending,
  nativeTerminal,
  provider,
  providerRouting,
  model,
  serviceTier,
  agentOptions,
  reasoning,
  handoff,
  disabled,
}: ExecutionControlsProps) {
  const handleServiceTierChange = serviceTier?.onChange ?? (() => {});
  const selectedProviderId = provider.selectedId ?? "";

  const canSwitchProviders = Boolean(
    provider.hasMultiple &&
    provider.onChange &&
    provider.options &&
    provider.options.length > 1,
  );
  const showModelPicker =
    model.isLoading ||
    model.loadFailed ||
    model.options.length > 0 ||
    canSwitchProviders ||
    selectedProviderId.length > 0 ||
    handoff !== undefined;

  return (
    <div
      data-execution-controls-layout={nativeTerminal ? "stacked" : undefined}
      className={cn(
        "flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-2",
      )}
    >
      {showModelPicker || pending ? (
        <ModelReasoningPicker
          providerOptions={provider.options ?? []}
          providerRouting={providerRouting}
          selectedProviderId={selectedProviderId}
          onSelectedProviderChange={provider.onChange}
          hasMultipleProviders={provider.hasMultiple ?? false}
          modelValue={model.active?.model ?? model.selected}
          unavailableModel={model.unavailableModel}
          modelOptions={model.options}
          moreModelOptions={model.moreOptions}
          modelIsLoading={model.isLoading}
          modelLoadFailed={model.loadFailed}
          modelLoadError={model.loadError}
          onModelChange={model.onChange}
          formatModelLabel={formatModelLabel}
          reasoningValue={reasoning.value}
          reasoningOptions={reasoning.options}
          onReasoningChange={reasoning.onChange}
          serviceTierValue={serviceTier?.value}
          serviceTierOptions={
            serviceTier?.supported
              ? serviceTier.options
              : EMPTY_SERVICE_TIER_OPTIONS
          }
          onServiceTierChange={handleServiceTierChange}
          serviceTierSupportByProvider={serviceTier?.supportByProvider}
          agentSections={agentOptions?.sections}
          onAgentOptionChange={agentOptions?.onChange}
          muted
          compactIconOnly={false}
          className="min-w-0 overflow-hidden"
          disabled={disabled}
          handoff={handoff}
        />
      ) : null}
      {nativeTerminal === undefined ? null : (
        <ToggleGroup
          type="single"
          aria-label="Run this thread in"
          data-native-terminal-toggle=""
          value={nativeTerminal.enabled ? "terminal" : "chat"}
          onValueChange={(value) => {
            if (value === "terminal" || value === "chat") {
              nativeTerminal.onChange(value === "terminal");
            }
          }}
          disabled={disabled || pending || nativeTerminal.disabled}
          className="h-7 shrink-0 gap-0.5 rounded-md p-0.5"
        >
          {NATIVE_TERMINAL_CHOICES.map((choice) => (
            <ToggleGroupItem
              key={choice.value}
              value={choice.value}
              title={nativeTerminal.unavailableReason ?? choice.title}
              aria-description={
                nativeTerminal.unavailableReason ?? choice.title
              }
              aria-label={choice.label}
              className={cn(
                "h-6 min-w-0 gap-1 whitespace-nowrap rounded-sm px-1.5 text-xs font-normal text-muted-foreground shadow-none hover:bg-state-hover hover:text-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground data-[state=on]:font-medium data-[state=on]:hover:bg-accent",
                "relative max-md:h-11 max-md:min-w-11 max-md:text-sm max-md:data-[state=on]:bg-transparent max-md:data-[state=on]:text-foreground max-md:data-[state=on]:hover:bg-transparent max-md:before:absolute max-md:before:inset-x-0 max-md:before:inset-y-1.5 max-md:before:rounded-md max-md:data-[state=on]:before:bg-state-hover",
                LIST_HOVER_TRANSITION,
              )}
            >
              <Icon name={choice.icon} className="relative size-3.5" />
              <span className="relative">{choice.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
});
