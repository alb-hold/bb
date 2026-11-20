import { useEffect, useRef, useState, type ReactNode } from "react";

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
  const submitted = useRef<PendingIntent | null>(null);
  const cancelled = useRef<PendingIntent | null>(null);
  const [pending, setPending] = useState<PendingIntent | null>(null);
  const cancel = () => {
    if (pending !== null) cancelled.current = pending;
    setPending(null);
  };
  useEffect(() => {
    if (pending === null) return;
    if (pending.text !== text || pending.resetKey !== resetKey || failed) {
      cancelled.current = pending;
      queueMicrotask(() =>
        setPending((current) => (current === pending ? null : current)),
      );
      return;
    }
    if (loading || disabled || isSubmitting || pendingUploads) return;
    if (submitted.current === pending || cancelled.current === pending) return;
    submitted.current = pending;
    void Promise.resolve()
      .then(onSubmit)
      .catch(() => {})
      .finally(() =>
        setPending((current) => (current === pending ? null : current)),
      );
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
        setPending({ text, resetKey });
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

type PendingIntent = {
  text: string;
  resetKey?: string | number;
};
