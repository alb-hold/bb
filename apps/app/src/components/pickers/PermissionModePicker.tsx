import { useMemo, useState } from "react";
import { PERMISSION_MODE_OPTIONS } from "@bb/client-core";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { PermissionMode } from "@bb/domain";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { OptionPicker, type PickerOption } from "./OptionPicker";

type PermissionModeOption = PickerOption<PermissionMode>;

const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> =
  Object.fromEntries(
    PERMISSION_MODE_OPTIONS.map((option) => [option.value, option.description]),
  ) as Record<PermissionMode, string>;

export function getPermissionModeCompactLabel(value: PermissionMode): string {
  switch (value) {
    case "full":
      return "Full Access";
    case "accept-edits":
      return "Edits";
    case "auto":
      return "Ask first";
  }
}

export function getPermissionModeDescription(value: PermissionMode): string {
  return PERMISSION_MODE_DESCRIPTIONS[value];
}

function addPermissionModeCompactLabels(
  options: readonly PermissionModeOption[],
): PermissionModeOption[] {
  return options.map((option) => ({
    ...option,
    label: option.compactLabel ?? getPermissionModeCompactLabel(option.value),
    description: option.description ?? getPermissionModeDescription(option.value),
    compactLabel: undefined,
  }));
}

export interface PermissionModePickerProps {
  pending?: boolean;
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
  className?: string;
  muted?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
  align?: "start" | "center" | "end";
  displayOverride?: {
    label: string;
    compactLabel?: string;
    description?: string;
    title?: string;
  };
  disabled?: boolean;
  showChevronWhenDisabled?: boolean;
  showWhenSingleOption?: boolean;
}

export function PermissionModePicker({
  pending = false,
  value,
  options,
  onChange,
  supported,
  className,
  muted = true,
  defaultOpen,
  modal,
  align = "end",
  displayOverride,
  disabled,
  showChevronWhenDisabled,
  showWhenSingleOption = false,
}: PermissionModePickerProps) {
  const isCompactViewport = useIsCompactViewport();
  const compactOptions = useMemo(
    () => addPermissionModeCompactLabels(options),
    [options],
  );
  const [lastValue, setLastValue] = useState<PermissionMode | undefined>(value);
  if (!pending && value !== undefined && value !== lastValue) {
    setLastValue(value);
  }
  const displayValue = pending ? lastValue : (value ?? lastValue);
  const modeLabel =
    compactOptions.find((option) => option.value === displayValue)?.label ??
    (displayValue === undefined
      ? "Permissions"
      : getPermissionModeCompactLabel(displayValue));
  const modeDescription = displayOverride
    ? displayOverride.description
    : (compactOptions.find((option) => option.value === displayValue)
        ?.description ??
      (displayValue === undefined
        ? undefined
        : getPermissionModeDescription(displayValue)));
  const compactLabel =
    displayOverride?.compactLabel ?? displayOverride?.label ?? modeLabel;
  const showFullAccessWarning = displayValue === "full" && !displayOverride;
  const pickerDisabled = disabled || pending || options.length <= 1;
  if (
    !pending &&
    (value === undefined ||
      !supported ||
      (!showWhenSingleOption && options.length <= 1))
  ) {
    return null;
  }
  return (
    <OptionPicker
      iconOnly={isCompactViewport}
      label="Permissions"
      tooltip={modeDescription}
      value={displayValue}
      options={compactOptions}
      onChange={onChange}
      className={cn(
        LIST_HOVER_TRANSITION,
        "permission-mode-picker",
        isCompactViewport
          ? "h-8 w-auto min-w-0 shrink-0 justify-center px-1.5"
          : "w-max min-w-0 shrink-0 justify-start",
        pending &&
          displayValue === undefined &&
          !isCompactViewport &&
          "[&>span]:invisible animate-pulse bg-state-hover",
        showFullAccessWarning &&
          "text-warning-text hover:text-warning-text data-[state=open]:text-warning-text",
        className,
      )}
      leading={
        <>
          <Icon name="SecurityCheck" className="size-3.5 shrink-0" />
          <span data-permission-label="">
            {isCompactViewport ? compactLabel : "Permissions:"}
          </span>
        </>
      }
      caretClassName={cn(
        "text-subtle-foreground/75",
        !isCompactViewport &&
          pickerDisabled &&
          showChevronWhenDisabled === false &&
          "invisible",
      )}
      contentClassName="max-w-72"
      muted={muted}
      defaultOpen={defaultOpen}
      modal={modal}
      align={align}
      displayOverride={
        displayOverride ??
        (pending
          ? {
              label: modeLabel,
              description: modeDescription,
            }
          : undefined)
      }
      disabled={pickerDisabled}
      showChevronWhenDisabled={
        isCompactViewport ? (showChevronWhenDisabled ?? true) : true
      }
    />
  );
}
