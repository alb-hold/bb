import { useMemo, useRef } from "react";
import type { PermissionMode } from "@bb/domain";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import { OptionPicker, type PickerOption } from "./OptionPicker";

type PermissionModeOption = PickerOption<PermissionMode>;

function getPermissionModeCompactLabel(value: PermissionMode): string {
  switch (value) {
    case "full":
      return "Full Access";
    case "accept-edits":
      return "Edits";
    case "auto":
      return "Approve";
  }
}

function addPermissionModeCompactLabels(
  options: readonly PermissionModeOption[],
): PermissionModeOption[] {
  return options.map((option) => ({
    ...option,
    label: option.compactLabel ?? getPermissionModeCompactLabel(option.value),
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
  pending,
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
  const compactOptions = useMemo(
    () => addPermissionModeCompactLabels(options),
    [options],
  );
  const lastValue = useRef<PermissionMode | undefined>(value);
  if (value !== undefined) lastValue.current = value;
  const displayValue = value ?? lastValue.current ?? "auto";
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
      label="Permission mode"
      value={displayValue}
      options={compactOptions}
      onChange={onChange}
      className={cn(LIST_HOVER_TRANSITION, className)}
      caretClassName="text-subtle-foreground/75"
      contentClassName="max-w-72"
      muted={muted}
      defaultOpen={defaultOpen}
      modal={modal}
      align={align}
      displayOverride={
        displayOverride ??
        (pending
          ? {
              label:
                compactOptions.find((option) => option.value === displayValue)
                  ?.label ?? getPermissionModeCompactLabel(displayValue),
            }
          : undefined)
      }
      disabled={disabled || pending || options.length <= 1}
      showChevronWhenDisabled={showChevronWhenDisabled ?? true}
    />
  );
}
