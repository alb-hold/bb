import {
  createRefusalLogOnce,
  ProjectAttachmentError,
  type RefusalLogOnce,
} from "@bb/domain";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ThreadEventScopeKind, ThreadEventType } from "@bb/domain";
import type { ServerLogger } from "./types.js";

interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

interface ApiErrorOptions {
  details?: unknown;
  retryable?: boolean;
}

interface TurnStartGuardFailureDetails {
  eventType: ThreadEventType;
  scopeKind: ThreadEventScopeKind;
  threadId: string;
  turnId: string;
}

export class ApiError extends HTTPException {
  readonly body: ApiErrorBody;

  constructor(
    status: ConstructorParameters<typeof HTTPException>[0],
    code: string,
    message: string,
    options?: boolean | ApiErrorOptions,
  ) {
    super(status, { message });
    const resolvedOptions = normalizeApiErrorOptions(options);
    this.body = { code, message };
    if (resolvedOptions.details !== undefined) {
      this.body.details = resolvedOptions.details;
    }
    if (resolvedOptions.retryable !== undefined) {
      this.body.retryable = resolvedOptions.retryable;
    }
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.body), {
      status: this.status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
}

export class TerminalInputInterruptedError extends ApiError {
  constructor(interrupted: unknown) {
    if (interrupted instanceof ApiError) {
      super(
        interrupted.status,
        interrupted.body.code,
        interrupted.body.message,
      );
    } else {
      super(500, "internal_error", "Internal server error");
    }
    this.cause = interrupted;
  }
}

function normalizeApiErrorOptions(
  options: boolean | ApiErrorOptions | undefined,
): ApiErrorOptions {
  if (typeof options === "boolean") {
    return { retryable: options };
  }
  return options ?? {};
}

export class TurnStartGuardError extends ApiError {
  readonly details: TurnStartGuardFailureDetails;

  constructor(details: TurnStartGuardFailureDetails) {
    super(
      409,
      "invalid_request",
      `Cannot append ${details.eventType} for turn ${details.turnId} before turn/started is stored`,
    );
    this.name = "TurnStartGuardError";
    this.details = details;
  }
}

interface FailedRequest {
  method: string;
  path: string;
}

export function apiErrorRefusalKey(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.body.code !== "path_in_use")
    return undefined;
  const details = error.body.details;
  if (typeof details !== "object" || details === null) return undefined;
  const refusalKey = (details as { refusalKey?: unknown }).refusalKey;
  return typeof refusalKey === "string" ? refusalKey : undefined;
}

export function createServerErrorHandler(logger: ServerLogger): ErrorHandler {
  const refusalLog = createRefusalLogOnce();
  return (error, context) =>
    errorToResponse(error, logger, refusalLog, {
      method: context.req.method,
      path: context.req.path,
    });
}

function errorToResponse(
  error: unknown,
  logger: ServerLogger,
  refusalLog: RefusalLogOnce,
  request: FailedRequest,
): Response {
  if (error instanceof ProjectAttachmentError) {
    return new ApiError(400, "invalid_request", error.message).toResponse();
  }
  if (error instanceof TurnStartGuardError) {
    logger.warn(
      { err: error, ...error.details },
      "Rejected turn-scoped server event before turn/started",
    );
    return error.toResponse();
  }
  if (error instanceof HTTPException && error.status >= 500) {
    const fields = {
      err: error,
      ...request,
      status: error.status,
      ...(error instanceof ApiError ? { body: error.body } : {}),
    };
    const refusalKey = apiErrorRefusalKey(error);
    if (refusalKey === undefined) {
      logger.error(fields, "Server error response");
    } else if (refusalLog.isNewRefusal(refusalKey)) {
      logger.warn(fields, "Server error response");
    } else {
      logger.debug(fields, "Server error response");
    }
  }
  if (error instanceof ApiError) {
    return error.toResponse();
  }
  if (error instanceof HTTPException) {
    return new Response(
      JSON.stringify({
        code: "internal_error",
        message: error.message,
      }),
      {
        status: error.status,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }
  logger.error({ err: error, ...request }, "Unhandled server error");
  return new Response(
    JSON.stringify({
      code: "internal_error",
      message: "Internal server error",
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
