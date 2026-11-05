import type { HTMLAttributes } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import { COMPOSER_SHELL_CLASS } from "@bb/shared-ui/composer-primitives";

export type ComposerLoadingShape = "thread" | "thread-compact" | "new-thread";

const COMPOSER_LOADING_SHAPE_CLASS: Record<ComposerLoadingShape, string> = {
  thread: "h-[151px]",
  "thread-compact": "h-[50px]",
  "new-thread": "h-32 max-md:pointer-coarse:h-[180px]",
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

export type ComposerPlaceholderState =
  | { kind: "loading"; shape: ComposerLoadingShape }
  | { kind: "missing" }
  | { kind: "failed"; onRetry: () => void }
  | { kind: "crashed"; pluginTitle: string; onReload: () => void };

export function ComposerPlaceholder({
  state,
}: {
  state: ComposerPlaceholderState;
}) {
  if (state.kind === "loading") {
    return (
      <ComposerLoadingControls
        shape={state.shape}
        aria-label="Loading composer"
        data-composer-placeholder="loading"
      />
    );
  }
  if (state.kind === "missing") {
    return (
      <div
        role="status"
        data-composer-placeholder="missing"
        className="px-1 py-2 text-sm text-muted-foreground"
      >
        No composer plugin is enabled.
      </div>
    );
  }
  return (
    <div
      role="alert"
      data-composer-placeholder={state.kind}
      className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted-foreground"
    >
      <span>
        {state.kind === "failed"
          ? "The composer couldn't load."
          : `${state.pluginTitle} stopped working.`}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={state.kind === "failed" ? state.onRetry : state.onReload}
      >
        {state.kind === "failed" ? "Retry" : "Reload"}
      </Button>
    </div>
  );
}
