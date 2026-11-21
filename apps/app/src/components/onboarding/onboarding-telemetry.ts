import { BbRequestTimeoutError } from "@bb/sdk/browser";
import { asHttpError } from "@/lib/http-error";
import type { RecordTelemetryEventRequest } from "@bb/server-contract";
import type { SystemRecordTelemetryEventOptions } from "@bb/sdk/browser";
import { sdk } from "@/lib/sdk";

export type OnboardingEntry = "first_run" | "replay";

export function recordTelemetryEvent(
  event: RecordTelemetryEventRequest,
  options?: SystemRecordTelemetryEventOptions,
): void {
  void sdk.system
    .experimental_recordTelemetryEvent(event, options)
    .catch(() => undefined);
}

export type OperationFailureReason =
  "host_unavailable" | "timed_out" | "not_found" | "permission" | "other";

export function operationFailureReason(error: unknown): OperationFailureReason {
  if (error instanceof BbRequestTimeoutError) return "timed_out";
  const httpError = asHttpError(error);
  if (httpError === null) return "other";
  if (httpError.code === "host_unavailable") return "host_unavailable";
  if (httpError.code === "command_timeout" || httpError.status === 504) {
    return "timed_out";
  }
  if (httpError.status === 404) return "not_found";
  if (httpError.status === 401 || httpError.status === 403) {
    return "permission";
  }
  return "other";
}
