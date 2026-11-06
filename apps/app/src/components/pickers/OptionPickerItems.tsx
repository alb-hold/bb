import type { ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@bb/shared-ui/dropdown-menu";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PickerOption } from "./OptionPicker";
export function OptionPickerItems({
  label,
  notice,
  options,
  onChange,
  value,
}: {
  label: string;
  notice?: ReactNode;
  options: readonly PickerOption<string>[];
  onChange: (value: string) => void;
  value?: string;
}) {
  return (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {notice}
      {options.map((option) => {
        const OptionIcon = option.icon;
        return (
          <DropdownMenuItem
            key={option.value}
            disabled={option.disabled}
            onSelect={() => onChange(option.value)}
            className={cn(
              "flex items-start justify-between gap-3 whitespace-normal",
              LIST_HOVER_TRANSITION,
            )}
          >
            <span
              className={cn(
                "flex min-w-0 flex-1 items-start gap-2",
                option.tone === "warning" && "text-warning-text",
              )}
            >
              {OptionIcon ? (
                <OptionIcon className="size-4 shrink-0 max-md:pointer-coarse:mt-0.5" />
              ) : null}
              <span className="min-w-0 flex-1">
                <span
                  className="block whitespace-normal break-words font-medium"
                  title={option.label}
                >
                  {option.label}
                </span>
                {option.disabled && option.disabledReason ? (
                  <span className="mt-0.5 block whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                    {option.disabledReason}
                  </span>
                ) : option.description ? (
                  <span className="mt-0.5 block whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </span>
            <Icon
              name="Check"
              className={cn(
                COARSE_POINTER_ICON_SIZE_CLASS,
                "shrink-0",
                option.value === value ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
