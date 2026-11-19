import { useEffect, useState, type ReactNode } from "react";

export function PendingComposerSubmission({
  children,
  text,
  resetKey,
  loading,
  disabled,
  failed,
  isSubmitting,
  pendingUploads,
  disabledReason,
  onSubmit,
}: {
  children: (onBlockedSubmit: () => void) => ReactNode;
  text: string;
  resetKey?: string | number;
  loading: boolean;
  disabled: boolean;
  failed: boolean;
  isSubmitting: boolean;
  pendingUploads: boolean;
  disabledReason?: string;
  onSubmit: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState<{
    attempt: number;
    text: string;
    resetKey?: string | number;
  } | null>(null);
  const cancel = () => {
    setPending(null);
  };
  useEffect(() => {
    if (pending === null) return;
    if (pending.text !== text || pending.resetKey !== resetKey || failed) return;
    if (loading || disabled || isSubmitting || pendingUploads) return;
    void Promise.resolve(onSubmit()).catch(() => {});
  }, [
    text,
    resetKey,
    loading,
    disabled,
    failed,
    isSubmitting,
    pendingUploads,
    onSubmit,
    pending,
  ]);
  return (
    <div
      className="w-full"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      {children(() => {
        if (!loading || failed || isSubmitting || !text.trim()) return;
        setPending((current) => ({
          attempt: (current?.attempt ?? 0) + 1,
          text,
          resetKey,
        }));
      })}
      {pending !== null &&
        pending.text === text &&
        pending.resetKey === resetKey &&
        loading &&
        !failed && (
          <p role="status" className="px-3.5 pt-1 text-xs text-muted-foreground">
            {disabledReason ?? "Loading model and options."} Your message will
            send when ready. Edit it or press Escape to cancel.
          </p>
        )}
    </div>
  );
}
