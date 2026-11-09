import type { HTMLAttributes } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { COMPOSER_SHELL_CLASS } from "@bb/shared-ui/composer-primitives";
import { Icon } from "@bb/shared-ui/icon";

export type ComposerLoadingShape = "thread" | "thread-compact" | "new-thread";

const COMPOSER_LOADING_SHAPE_CLASS: Record<ComposerLoadingShape, string> = {
  thread: "h-[151px]",
  "thread-compact": "h-[50px]",
  "new-thread": "h-[132px] max-md:pointer-coarse:h-44",
};

export function ComposerLoadingControls({
  shape,
  placeholder,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { shape: ComposerLoadingShape; placeholder?: string }) {
  return (
    <Button
      {...props}
      disabled
      variant="outline"
      aria-busy="true"
      className={cn(
        "relative w-full shrink-0 items-start justify-between p-3 text-left text-muted-foreground",
        COMPOSER_SHELL_CLASS,
        COMPOSER_LOADING_SHAPE_CLASS[shape],
      )}
    >
      <span>{placeholder ?? (shape === "new-thread" ? "Ask anything. @ to mention files, folders, or sections" : "Ask a follow-up")}</span>
      {shape === "new-thread" ? <span className="absolute bottom-3 left-3">Model · Chat / Terminal</span> : null}
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center self-end rounded-full pointer-coarse:size-11"><Icon name="Mic" className="size-4" /></span>
    </Button>
  );
}
