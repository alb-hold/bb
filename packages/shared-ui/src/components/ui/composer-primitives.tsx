import type { Ref } from "react";
import { Button, type ButtonProps } from "./button";
import { Icon } from "./icon";
import { cn } from "../../lib/utils";

export const COMPOSER_SHELL_CLASS =
  "rounded-xl border border-border bg-background shadow-lift";

export const COMPOSER_SUBMIT_CLASS =
  "size-9 shrink-0 rounded-full p-0 pointer-coarse:size-11 disabled:bg-foreground/5 disabled:text-muted-foreground disabled:opacity-100";

export const COMPOSER_SEND_ICON = "ArrowUp";

export function ComposerSubmitButton({
  className,
  children,
  ref,
  ...props
}: ButtonProps & { ref?: Ref<HTMLButtonElement> }) {
  return (
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
  );
}
