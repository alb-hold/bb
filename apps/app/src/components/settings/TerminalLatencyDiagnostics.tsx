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
            Sent → first output received (echo):{" "}
            {metricText(
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .count,
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .totalCount,
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .p50Ms,
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .p95Ms,
            )}
          </div>
          <div>
            Accepted → first output received:{" "}
            {metricText(
              snapshot[formFactor].inputToFirstOutputReceivedMs.count,
              snapshot[formFactor].inputToFirstOutputReceivedMs.totalCount,
              snapshot[formFactor].inputToFirstOutputReceivedMs.p50Ms,
              snapshot[formFactor].inputToFirstOutputReceivedMs.p95Ms,
            )}
          </div>
          <div>
            First output → rendered:{" "}
            {metricText(
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs.count,
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs
                .totalCount,
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs.p50Ms,
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs.p95Ms,
            )}
          </div>
          <div>
            Keystroke → first output rendered:{" "}
            {metricText(
              snapshot[formFactor].inputToFirstOutputRenderMs.count,
              snapshot[formFactor].inputToFirstOutputRenderMs.totalCount,
              snapshot[formFactor].inputToFirstOutputRenderMs.p50Ms,
              snapshot[formFactor].inputToFirstOutputRenderMs.p95Ms,
            )}
          </div>
          <div>
            Output receive to render:{" "}
            {metricText(
              snapshot[formFactor].outputRenderMs.count,
              snapshot[formFactor].outputRenderMs.totalCount,
              snapshot[formFactor].outputRenderMs.p50Ms,
              snapshot[formFactor].outputRenderMs.p95Ms,
            )}
          </div>
        </div>
      ))}
      <p className="text-muted-foreground">
        Timings are sampled in memory. Terminal input and output contents are
        not recorded.
      </p>
    </div>
  );
}
