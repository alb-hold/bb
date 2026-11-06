import { useMemo, useRef } from "react";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { PermissionMode } from "@bb/domain";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { OptionPicker, type PickerOption } from "./OptionPicker";

type PermissionModeOption = PickerOption<PermissionMode>;

export function getPermissionModeCompactLabel(value: PermissionMode): string {
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
  const lastValue = useRef<PermissionMode | undefined>(value);
  if (!pending && value !== undefined) lastValue.current = value;
  const displayValue = pending ? lastValue.current : value ?? lastValue.current;
  const showFullAccessWarning = displayValue === "full" && !displayOverride;
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
      value={displayValue}
      options={compactOptions}
      onChange={onChange}
      className={cn(
        LIST_HOVER_TRANSITION,
        isCompactViewport ? "size-8 min-w-0 justify-center p-0" : "min-w-28 justify-between",
        pending && displayValue === undefined && !isCompactViewport && "w-40 [&>span]:invisible animate-pulse bg-state-hover",
        showFullAccessWarning && "text-warning-text hover:text-warning-text data-[state=open]:text-warning-text",
        className,
      )}
      leading={<><Icon name="SecurityCheck" className="size-3.5 shrink-0" />{isCompactViewport ? null : <span>Permissions:</span>}</>}
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
              label: displayValue === undefined
                ? "Permissions"
                : compactOptions.find((option) => option.value === displayValue)
                    ?.label ?? getPermissionModeCompactLabel(displayValue),
            }
          : undefined)
      }
      disabled={disabled || pending || options.length <= 1}
      showChevronWhenDisabled={showChevronWhenDisabled ?? true}
    />
  );
}
