import { extractErrorMessage } from "@bb/core-ui";
import { BbHttpError, BbRequestTimeoutError } from "@bb/sdk/browser";
import { HttpError } from "./api";

const HTTP_STATUS_PREFIX_PATTERN = /^HTTP \d{3}:\s*/u;

export function asHttpError(error: unknown): HttpError | BbHttpError | null {
  return error instanceof HttpError || error instanceof BbHttpError
    ? error
    : null;
}

export function getHttpErrorMessage(
  error: HttpError | BbHttpError,
): string | null {
  const bodyMessage = extractErrorMessage(error.body);
  if (bodyMessage) {
    return bodyMessage;
  }

  const normalizedMessage = extractErrorMessage(error.message);
  if (normalizedMessage === null) {
    return null;
  }
  const strippedMessage = normalizedMessage.replace(
    HTTP_STATUS_PREFIX_PATTERN,
    "",
  );
  return strippedMessage.length > 0 ? strippedMessage : null;
}

export type OperationFailureReason =
  | "host_unavailable"
  | "timed_out"
  | "not_found"
  | "permission"
  | "other";

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
