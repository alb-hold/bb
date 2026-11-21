import { BbRequestTimeoutError } from "@bb/sdk/browser";
import { asHttpError } from "@/lib/http-error";

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
