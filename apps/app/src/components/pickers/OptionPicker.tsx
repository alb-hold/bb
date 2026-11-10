import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { OptionPickerItems } from "./OptionPickerItemsSplit";

const OPTION_WARNING_TEXT_CLASS_NAME = "text-warning-text";
const OPTION_WARNING_INTERACTIVE_CLASS_NAME =
  "hover:text-warning-text data-[state=open]:text-warning-text";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  compactLabel?: string;
  description?: string;
  tone?: "default" | "warning";
  icon?: ComponentType<{ className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}

interface OptionPickerProps<T extends string> {
  label: string;
  iconOnly?: boolean;
  notice?: ReactNode;
  leading?: ReactNode;
  value?: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  caretClassName?: string;
  contentClassName?: string;
  muted?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
  align?: "start" | "end" | "center";
  displayOverride?: {
    label: string;
    compactLabel?: string;
    description?: string;
    title?: string;
  };
  disabled?: boolean;
  showChevronWhenDisabled?: boolean;
  trigger?: ReactElement;
}

export function OptionPicker<T extends string>({
  label,
  iconOnly = false,
  notice,
  leading,
  value,
  options,
  onChange,
  className,
  caretClassName,
  contentClassName,
  muted,
  defaultOpen,
  modal,
  align = "start",
  displayOverride,
  disabled,
  showChevronWhenDisabled,
  trigger: customTrigger,
}: OptionPickerProps<T>) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedTone = displayOverride ? "default" : selectedOption?.tone;
  const selectedIsWarning = selectedTone === "warning";
  const SelectedIcon = selectedOption?.icon;
  const selectedLabel =
    displayOverride?.label ?? selectedOption?.label ?? value;
  const selectedCompactLabel =
    displayOverride?.compactLabel ?? selectedOption?.compactLabel;
  const selectedDescription =
    displayOverride?.description ?? selectedOption?.description;
  const selectedTitle = displayOverride?.title
    ? displayOverride.title
    : selectedDescription
      ? `${label}: ${selectedLabel} - ${selectedDescription}`
      : `${label}: ${selectedLabel}`;

  const trigger = customTrigger ?? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={iconOnly ? `${label}: ${selectedLabel}` : label}
      data-compact-touch={iconOnly ? "picker" : undefined}
      disabled={disabled}
      className={cn(
        OPTION_BASE_CLASS_NAME,
        OPTION_INTERACTIVE_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        muted && OPTION_MUTED_CLASS_NAME,
        selectedIsWarning && OPTION_WARNING_TEXT_CLASS_NAME,
        selectedIsWarning && OPTION_WARNING_INTERACTIVE_CLASS_NAME,
        disabled && "cursor-default disabled:opacity-100",
        className,
      )}
    >
      <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME} title={selectedTitle}>
        {leading ??
          (SelectedIcon ? (
            <SelectedIcon className="size-3.5 shrink-0" />
          ) : null)}
        {iconOnly ? null : selectedCompactLabel ? (
          <>
            <span className="min-w-0 truncate" data-promptbox-full-label="">
              {selectedLabel}
            </span>
            <span className="min-w-0 truncate" data-promptbox-compact-label="">
              {selectedCompactLabel}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate">{selectedLabel}</span>
        )}
      </span>
      {iconOnly || (disabled && !showChevronWhenDisabled) ? null : (
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            caretClassName,
          )}
        />
      )}
    </Button>
  );

  if (disabled) {
    return trigger;
  }

  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
      <DropdownMenuTrigger asChild {...OptionPickerItems.intentProps}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, contentClassName)}
        mobileTitle={label}
      >
        <OptionPickerItems
          label={label}
          notice={notice}
          options={options}
          onChange={(next) => {
            const option = options.find((option) => option.value === next);
            if (option) onChange(option.value);
          }}
          value={value}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
