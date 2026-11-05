import { forwardRef } from "react";
import { Button, type ButtonProps } from "./button";
import { Icon } from "./icon";
import { cn } from "../../lib/utils";

export const COMPOSER_SHELL_CLASS =
  "rounded-xl border border-border bg-background shadow-lift";

export const COMPOSER_SUBMIT_CLASS =
  "size-9 shrink-0 rounded-full p-0 pointer-coarse:size-11 disabled:opacity-50";

export const COMPOSER_SEND_ICON = "ArrowUp";

export const ComposerSubmitButton = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, children, ...props }, ref) => (
    <Button
      ref={ref}
      type="submit"
      variant="default"
      size="icon"
      {...props}
      className={cn(COMPOSER_SUBMIT_CLASS, className)}
    >
      {children ?? <Icon name={COMPOSER_SEND_ICON} className="size-4" />}
    </Button>
  ),
);
ComposerSubmitButton.displayName = "ComposerSubmitButton";
