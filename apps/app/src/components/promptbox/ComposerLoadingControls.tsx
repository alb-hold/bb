import type { HTMLAttributes } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { COMPOSER_SHELL_CLASS } from "@bb/shared-ui/composer-primitives";

export type ComposerLoadingShape = "thread" | "thread-compact" | "new-thread";

const COMPOSER_LOADING_SHAPE_CLASS: Record<ComposerLoadingShape, string> = {
  thread: "h-[151px]",
  "thread-compact": "h-[50px]",
  "new-thread": "h-[132px] max-md:pointer-coarse:h-44",
};

export function ComposerLoadingControls({
  shape,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { shape: ComposerLoadingShape }) {
  return (
    <Button
      {...props}
      disabled
      variant="outline"
      aria-busy="true"
      className={cn(
        "w-full shrink-0 items-end justify-start p-3 text-muted-foreground",
        COMPOSER_SHELL_CLASS,
        COMPOSER_LOADING_SHAPE_CLASS[shape],
      )}
    >
      {shape === "new-thread" ? "Model · Chat / Terminal" : "Composer"}
    </Button>
  );
}
