import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createServerErrorHandler } from "./errors.js";

function createApp(error: ApiError) {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const app = new Hono();
  app.onError(createServerErrorHandler(logger));
  app.post("/api/v1/threads/:threadId/messages", () => {
    throw error;
  });
  return { app, logger };
}

describe("createServerErrorHandler", () => {
  it("logs deliberate 5xx API errors with the failing request", async () => {
    const error = new ApiError(500, "internal_error", "Thread changed twice");
    const { app, logger } = createApp(error);

    const response = await app.request("/api/v1/threads/thr_x/messages", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "internal_error",
      message: "Thread changed twice",
    });
    expect(logger.error).toHaveBeenCalledWith(
      {
        err: error,
        method: "POST",
        path: "/api/v1/threads/thr_x/messages",
        status: 500,
        body: { code: "internal_error", message: "Thread changed twice" },
      },
      "Server error response",
    );
  });

  it("warns once for a repeated holder refusal key and logs the repeats at debug", async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    let next: ApiError = new ApiError(502, "path_in_use", "Refusing", {
      retryable: false,
      details: { refusalKey: "64769:131|holders:799:1234" },
    });
    const app = new Hono();
    app.onError(createServerErrorHandler(logger));
    app.post("/api/v1/files/remove", () => {
      throw next;
    });
    const send = async () => {
      const response = await app.request("/api/v1/files/remove", {
        method: "POST",
      });
      expect(response.status).toBe(502);
      return response.json();
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await send()).toMatchObject({
        code: "path_in_use",
        details: { refusalKey: "64769:131|holders:799:1234" },
      });
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.error).not.toHaveBeenCalled();

    next = new ApiError(502, "path_in_use", "Refusing", {
      retryable: false,
      details: { refusalKey: "64769:131|holders:799:1234,801:1300" },
    });
    await send();
    expect(logger.warn).toHaveBeenCalledTimes(2);

    next = new ApiError(502, "path_in_use", "Refusing without a key", false);
    await send();
    await send();
    expect(logger.error).toHaveBeenCalledTimes(2);

    next = new ApiError(502, "host_unavailable", "Host is not connected", {
      retryable: false,
      details: { refusalKey: "64769:131|holders:799:1234,801:1300" },
    });
    await send();
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("does not log client errors", async () => {
    const { app, logger } = createApp(
      new ApiError(404, "thread_not_found", "Thread not found"),
    );

    const response = await app.request("/api/v1/threads/thr_x/messages", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
