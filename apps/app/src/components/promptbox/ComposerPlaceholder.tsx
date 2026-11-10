import { Button } from "@bb/shared-ui/button";
import {
  ComposerLoadingControls,
  type ComposerLoadingShape,
} from "./ComposerLoadingControls";

export type ComposerPlaceholderState =
  | { kind: "loading"; shape: ComposerLoadingShape; placeholder?: string }
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
        placeholder={state.placeholder}
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
