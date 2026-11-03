import { useEffect, useState } from "react";
import {
  getTerminalLatencyDiagnostics,
  type TerminalLatencyDiagnosticsSnapshot,
} from "@/components/thread/terminal/terminal-latency-diagnostics.js";

function metricText(
  count: number,
  totalCount: number,
  p50Ms: number | null,
  p95Ms: number | null,
) {
  if (count === 0 || p50Ms === null || p95Ms === null) return "No samples yet";
  return `n=${count} (total ${totalCount}) · p50 ${p50Ms.toFixed(1)} ms · p95 ${p95Ms.toFixed(1)} ms`;
}

export function TerminalLatencyDiagnostics() {
  const [snapshot, setSnapshot] = useState<TerminalLatencyDiagnosticsSnapshot>(
    getTerminalLatencyDiagnostics,
  );

  useEffect(() => {
    const timer = window.setInterval(
      () => setSnapshot(getTerminalLatencyDiagnostics()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="space-y-2 text-sm"
      aria-label="Terminal latency diagnostics"
    >
      {(["desktop", "phone"] as const).map((formFactor) => (
        <div key={formFactor}>
          <div className="font-medium capitalize">{formFactor}</div>
          <div>
            Keystroke → JSON ready (serialized):{" "}
            {metricText(
              snapshot[formFactor].inputEventToSerializationMs.count,
              snapshot[formFactor].inputEventToSerializationMs.totalCount,
              snapshot[formFactor].inputEventToSerializationMs.p50Ms,
              snapshot[formFactor].inputEventToSerializationMs.p95Ms,
            )}
          </div>
          <div>
            JSON ready → accepted (queued or send returned):{" "}
            {metricText(
              snapshot[formFactor].inputSerializationToAcceptanceMs.count,
              snapshot[formFactor].inputSerializationToAcceptanceMs.totalCount,
              snapshot[formFactor].inputSerializationToAcceptanceMs.p50Ms,
              snapshot[formFactor].inputSerializationToAcceptanceMs.p95Ms,
            )}
          </div>
          <div>
            Accepted → sent (queued flush; immediate same moment):{" "}
            {metricText(
              snapshot[formFactor].inputAcceptanceToWebSocketSendMs.count,
              snapshot[formFactor].inputAcceptanceToWebSocketSendMs.totalCount,
              snapshot[formFactor].inputAcceptanceToWebSocketSendMs.p50Ms,
              snapshot[formFactor].inputAcceptanceToWebSocketSendMs.p95Ms,
            )}
          </div>
          <div>
            Sent → first output after send:{" "}
            {metricText(
              snapshot[formFactor].inputSendToFirstOutputAfterSendMs.count,
              snapshot[formFactor].inputSendToFirstOutputAfterSendMs.totalCount,
              snapshot[formFactor].inputSendToFirstOutputAfterSendMs.p50Ms,
              snapshot[formFactor].inputSendToFirstOutputAfterSendMs.p95Ms,
            )}
          </div>
          <div>
            Accepted → first output after send:{" "}
            {metricText(
              snapshot[formFactor].inputAcceptedToFirstOutputAfterSendMs.count,
              snapshot[formFactor].inputAcceptedToFirstOutputAfterSendMs
                .totalCount,
              snapshot[formFactor].inputAcceptedToFirstOutputAfterSendMs.p50Ms,
              snapshot[formFactor].inputAcceptedToFirstOutputAfterSendMs.p95Ms,
            )}
          </div>
          <div>
            First output after send → parsed:{" "}
            {metricText(
              snapshot[formFactor].firstOutputAfterSendToParseMs.count,
              snapshot[formFactor].firstOutputAfterSendToParseMs.totalCount,
              snapshot[formFactor].firstOutputAfterSendToParseMs.p50Ms,
              snapshot[formFactor].firstOutputAfterSendToParseMs.p95Ms,
            )}
          </div>
          <div>
            Keystroke → parse of first output after send:{" "}
            {metricText(
              snapshot[formFactor].inputEventToFirstOutputAfterSendParseMs
                .count,
              snapshot[formFactor].inputEventToFirstOutputAfterSendParseMs
                .totalCount,
              snapshot[formFactor].inputEventToFirstOutputAfterSendParseMs
                .p50Ms,
              snapshot[formFactor].inputEventToFirstOutputAfterSendParseMs
                .p95Ms,
            )}
          </div>
          <div>
            Output receive → parsed:{" "}
            {metricText(
              snapshot[formFactor].outputParseMs.count,
              snapshot[formFactor].outputParseMs.totalCount,
              snapshot[formFactor].outputParseMs.p50Ms,
              snapshot[formFactor].outputParseMs.p95Ms,
            )}
          </div>
          <div>
            First output after send → next render:{" "}
            {metricText(
              snapshot[formFactor].firstOutputAfterSendToNextRenderMs.count,
              snapshot[formFactor].firstOutputAfterSendToNextRenderMs
                .totalCount,
              snapshot[formFactor].firstOutputAfterSendToNextRenderMs.p50Ms,
              snapshot[formFactor].firstOutputAfterSendToNextRenderMs.p95Ms,
            )}
          </div>
          <div>
            Keystroke → next render after first output after send:{" "}
            {metricText(
              snapshot[formFactor].inputEventToFirstOutputAfterSendNextRenderMs
                .count,
              snapshot[formFactor].inputEventToFirstOutputAfterSendNextRenderMs
                .totalCount,
              snapshot[formFactor].inputEventToFirstOutputAfterSendNextRenderMs
                .p50Ms,
              snapshot[formFactor].inputEventToFirstOutputAfterSendNextRenderMs
                .p95Ms,
            )}
          </div>
          <div>
            Output receive → next render:{" "}
            {metricText(
              snapshot[formFactor].outputNextRenderMs.count,
              snapshot[formFactor].outputNextRenderMs.totalCount,
              snapshot[formFactor].outputNextRenderMs.p50Ms,
              snapshot[formFactor].outputNextRenderMs.p95Ms,
            )}
          </div>
        </div>
      ))}
      <p className="text-muted-foreground">
        Timings are sampled in memory. Terminal input and output contents are
        not recorded. The first-output-after-send sample is the first output on
        that terminal after the key was sent; it may be unrelated to that key.
      </p>
    </div>
  );
}
