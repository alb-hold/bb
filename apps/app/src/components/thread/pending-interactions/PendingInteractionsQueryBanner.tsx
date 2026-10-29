import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";

export type PendingInteractionsQueryBannerProps =
  | { state: "loading" }
  | { state: "error"; isRetrying: boolean; onRetry: () => void };

export function PendingInteractionsQueryBanner(
  props: PendingInteractionsQueryBannerProps,
) {
  const isError = props.state === "error";
  return (
    <div
      className={cn(
        "mb-2 flex min-w-0 max-w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-recessed px-4 py-3 text-xs text-muted-foreground",
        isError &&
          "border-surface-destructive-border bg-surface-destructive text-destructive-text",
      )}
      role={isError ? "alert" : "status"}
    >
      <span>
        {isError
          ? "Couldn't check pending interactions."
          : "Checking pending interactions…"}
      </span>
      {props.state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.isRetrying}
          onClick={props.onRetry}
          className="h-7 cursor-pointer px-2"
        >
          {props.isRetrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}
