import { Button } from "@bb/shared-ui/button";
import { useMemo } from "react";
import type { PermissionMode } from "@bb/domain";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import { OptionPicker, type PickerOption } from "./OptionPicker";

type PermissionModeOption = PickerOption<PermissionMode>;

function getPermissionModeCompactLabel(value: PermissionMode): string {
  switch (value) {
    case "full":
      return "Full";
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
    compactLabel:
      option.compactLabel ?? getPermissionModeCompactLabel(option.value),
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
  if (pending && value === undefined) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        aria-label="Permission mode"
        className={className}
      >
        Permissions
      </Button>
    );
  }
  if (
    value === undefined ||
    (!pending &&
      (!supported ||
        value === undefined ||
        (!showWhenSingleOption && options.length <= 1)))
  ) {
    return null;
  }
  return (
    <OptionPicker
      label="Permission mode"
      value={value}
      options={compactOptions}
      onChange={onChange}
      className={cn(
        LIST_HOVER_TRANSITION,
        value === "full" &&
          !pending &&
          !displayOverride &&
          "rounded-md border border-solid border-attention/60 text-muted-foreground hover:text-muted-foreground data-[state=open]:text-muted-foreground",
        className,
      )}
      caretClassName="text-subtle-foreground/75"
      contentClassName="max-w-72"
      muted={muted}
      defaultOpen={defaultOpen}
      modal={modal}
      align={align}
      displayOverride={
        pending && !displayOverride
          ? { label: "Permissions", compactLabel: "Permissions" }
          : displayOverride
      }
      disabled={disabled || pending || options.length <= 1}
      showChevronWhenDisabled={showChevronWhenDisabled}
    />
  );
}
