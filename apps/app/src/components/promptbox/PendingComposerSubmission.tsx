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
  const queued = useRef<{ text: string; resetKey?: string | number } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const cancel = () => {
    queued.current = null;
    setPending(false);
  };
  useEffect(() => {
    const intent = queued.current;
    if (!intent) return;
    if (intent.text !== text || intent.resetKey !== resetKey || failed) {
      queued.current = null;
      setPending(false);
      return;
    }
    if (loading || disabled || isSubmitting || pendingUploads) return;
    queued.current = null;
    setPending(false);
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
        queued.current ??= { text, resetKey };
        setPending(true);
      })}
      {pending && (
        <p role="status" className="px-3.5 pt-1 text-xs text-muted-foreground">
          {disabledReason ?? "Loading model and options."} Your message will
          send when ready. Edit it or press Escape to cancel.
        </p>
      )}
    </div>
  );
}
