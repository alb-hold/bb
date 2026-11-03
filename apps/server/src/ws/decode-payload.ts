import type { z } from "zod";

function decodeSocketPayload(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
      "utf8",
    );
  }
  return String(raw);
}

export function socketMessageType(raw: unknown): string | null {
  try {
    const decoded: unknown = JSON.parse(decodeSocketPayload(raw));
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "type" in decoded &&
      typeof decoded.type === "string"
    ) {
      return decoded.type;
    }
  } catch {
    return null;
  }
  return null;
}

export type SocketMessageDecodeFailure =
  | { reason: "invalid-json" }
  | { reason: "invalid-schema"; issuePaths: string[] };

export type SocketMessageDecode<T> =
  | { ok: true; message: T }
  | { ok: false; failure: SocketMessageDecodeFailure };

export function decodeSocketMessage<T>(
  raw: unknown,
  schema: z.ZodType<T>,
): SocketMessageDecode<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeSocketPayload(raw));
  } catch {
    return { ok: false, failure: { reason: "invalid-json" } };
  }

  const result = schema.safeParse(decoded);
  if (!result.success) {
    return {
      ok: false,
      failure: {
        reason: "invalid-schema",
        issuePaths: result.error.issues.map(
          (issue) => `${issue.code}:${issue.path.join(".")}`,
        ),
      },
    };
  }
  return { ok: true, message: result.data };
}

export function parseSocketMessage<T>(
  socket: { close(code?: number, reason?: string): void },
  raw: unknown,
  schema: z.ZodType<T>,
): T | null {
  const decoded = decodeSocketMessage(raw, schema);
  if (!decoded.ok) {
    socket.close(1008, "invalid-message");
    return null;
  }
  return decoded.message;
}
