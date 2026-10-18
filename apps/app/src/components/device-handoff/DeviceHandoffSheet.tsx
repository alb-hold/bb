import type {
  DeviceHandoffExpiredSignal,
  DeviceHandoffNoticeSignal,
  DeviceHandoffSignal,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  PersistentResponsiveDrawerShell,
  useResponsiveDrawerRealization,
} from "@bb/shared-ui/responsive-overlay";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

interface DeviceHandoffSheetProps {
  signal:
    | DeviceHandoffSignal
    | DeviceHandoffExpiredSignal
    | DeviceHandoffNoticeSignal
    | null;
  position: number;
  count: number;
  onDismiss(): void;
  onAcknowledge(id: string): void;
  onShowHere?(id: string): void;
  shownOn?: string;
}

export function DeviceHandoffSheet({
  signal,
  position,
  count,
  onDismiss,
  onAcknowledge,
  onShowHere = () => {},
  shownOn,
}: DeviceHandoffSheetProps) {
  const open = signal !== null;
  const { isContentRealized } = useResponsiveDrawerRealization({ open });

  const copy = () => {
    if (
      signal?.type !== "device-handoff" ||
      signal.request.kind !== "copy-text"
    )
      return;
    void copyToClipboardWithToast(signal.request.text, {
      successMessage: "Copied on this device",
      errorMessage: "Could not copy text",
    }).then((copied) => {
      if (copied) {
        onAcknowledge(signal.id);
        onDismiss();
      }
    });
  };

  const openUrl = () => {
    if (signal?.type !== "device-handoff" || signal.request.kind !== "open-url")
      return;
    openUrlInExternalBrowser(signal.request.url);
    onAcknowledge(signal.id);
    onDismiss();
  };

  const dismiss = () => {
    if (signal?.type === "device-handoff") onAcknowledge(signal.id);
    onDismiss();
  };

  const content =
    signal?.type === "device-handoff-expired" ? (
      <>
        <p className="text-sm text-muted-foreground">
          A link or copied text from this terminal expired before you opened it.
          Run the command again.
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </>
    ) : signal?.type === "device-handoff-notice" ? (
      <>
        <p className="text-sm text-muted-foreground">
          {signal.kind === "copy-text" ? "Text" : "Link"} from{" "}
          {signal.hostLabel} is waiting.
          {shownOn ? ` Shown on ${shownOn}.` : ""}
        </p>
        <p className="text-sm text-muted-foreground">
          {new Date(signal.createdAt).toLocaleString()}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={() => onShowHere(signal.id)}>
            Show here
          </Button>
        </div>
      </>
    ) : signal?.type === "device-handoff" &&
      signal.request.kind === "copy-text" ? (
      <>
        <p className="text-sm text-muted-foreground">{signal.originLabel}</p>
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-words">
          {signal.request.text.slice(0, 1_000)}
          {signal.request.text.length > 1_000 ? "…" : ""}
        </pre>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={copy}>
            Copy
          </Button>
        </div>
      </>
    ) : signal?.type === "device-handoff" &&
      signal.request.kind === "open-url" ? (
      <>
        <p className="text-sm text-muted-foreground">{signal.originLabel}</p>
        <p className="break-all text-sm">{new URL(signal.request.url).host}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={openUrl}>
            Open
          </Button>
        </div>
      </>
    ) : null;

  return (
    <PersistentResponsiveDrawerShell
      contentClassName="max-h-[min(80dvh,42rem)]"
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      srLabel="Device handoff"
    >
      {isContentRealized && signal !== null ? (
        <section className="flex max-h-[min(80dvh,42rem)] flex-col gap-3 overflow-y-auto px-4 pb-4">
          <h2 className="text-base font-semibold">
            {signal.type === "device-handoff-expired"
              ? "Handoff expired"
              : signal.type === "device-handoff-notice"
                ? signal.kind === "copy-text"
                  ? "Text waiting"
                  : "Link waiting"
                : signal.request.kind === "copy-text"
                  ? "Text ready to copy"
                  : "URL ready to open"}
          </h2>
          {count > 0 ? (
            <p className="text-sm text-muted-foreground">
              {position} of {count}
            </p>
          ) : null}
          {content}
        </section>
      ) : null}
    </PersistentResponsiveDrawerShell>
  );
}
