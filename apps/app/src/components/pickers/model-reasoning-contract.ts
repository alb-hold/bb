import {
  type ProviderOptionDescriptor,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@bb/server-contract";
import { type ProviderPickerOption } from "./model-brand-prefix";
import type { ModelPickerOption } from "./model-picker-option";
import type { PickerOption } from "./OptionPicker";
import type {
  SessionOptionChoice,
  SessionOptionMenuSection,
} from "./SessionOptionsMenu";

interface ResolvedProviderPreview {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  supportsServiceTier: boolean;
  serviceTierOptions: readonly ProviderOptionDescriptor[];
}

export interface ModelReasoningPickerHandoffSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
}

export interface ModelReasoningPickerHandoff {
  sourceProviderId: string;
  active: boolean;
  onStart: () => void;
  onExit: () => void;
  onSelect: (selection: ModelReasoningPickerHandoffSelection) => void;
}

export type ModelNavRow =
  | { kind: "model"; option: ModelPickerOption }
  | { kind: "more-toggle" }
  | { kind: "more-submenu" };

export function buildModelNavRows({
  modelOptions,
  moreModelOptions,
  isCompactViewport,
  isSearching,
  showMoreModels,
}: {
  modelOptions: readonly ModelPickerOption[];
  moreModelOptions: readonly ModelPickerOption[];
  isCompactViewport: boolean;
  isSearching: boolean;
  showMoreModels: boolean;
}): ModelNavRow[] {
  const rows: ModelNavRow[] = modelOptions.map((option): ModelNavRow => ({
    kind: "model",
    option,
  }));
  if (moreModelOptions.length === 0) return rows;

  if (isSearching) {
    for (const option of moreModelOptions) rows.push({ kind: "model", option });
    return rows;
  }

  if (!isCompactViewport) {
    rows.push({ kind: "more-submenu" });
    return rows;
  }
  if (isCompactViewport) {
    rows.push({ kind: "more-toggle" });
    if (showMoreModels) {
      for (const option of moreModelOptions) {
        rows.push({ kind: "model", option });
      }
    }
  }

  return rows;
}

export interface ModelReasoningPickerProps {
  providerRouting?: SystemProvidersQuery;
  providerOptions: readonly ProviderPickerOption[];
  selectedProviderId: string;
  onSelectedProviderChange?: (value: string) => void;
  onProviderPreviewResolved?: (value: ResolvedProviderPreview) => void;
  requireVerifiedProviderPreview?: boolean;
  hasMultipleProviders: boolean;
  unavailableModel?: string;
  modelValue: string;
  modelOptions: readonly ModelPickerOption[];
  moreModelOptions?: readonly ModelPickerOption[];
  modelIsLoading?: boolean;
  modelLoadFailed?: boolean;
  modelLoadError?: SystemExecutionOptionsModelLoadError | null;
  onModelChange: (value: string) => void;
  formatModelLabel?: (displayName: string) => string;
  reasoningValue: ReasoningLevel;
  reasoningOptions: readonly PickerOption<ReasoningLevel>[];
  onReasoningChange: (value: ReasoningLevel) => void;
  serviceTierValue: ServiceTier | undefined;
  serviceTierOptions: readonly ProviderOptionDescriptor[];
  onServiceTierChange: (value: ServiceTier) => void;
  agentSections?: readonly SessionOptionMenuSection[];
  onAgentOptionChange?: (optionId: string, value: SessionOptionChoice) => void;
  commandShortcutsEnabled?: boolean;
  serviceTierSupportByProvider?: Record<string, boolean>;
  className?: string;
  compactIconOnly?: boolean;
  muted?: boolean;
  modal?: boolean;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  handoff?: ModelReasoningPickerHandoff;
}
