import { z } from "zod";

export const DEVICE_HANDOFF_TEXT_MAX_BYTES = 1024 * 1024;
export const DEVICE_HANDOFF_URL_MAX_LENGTH = 8 * 1024;
export const DEVICE_HANDOFF_CLIENT_TOKEN_HEADER =
  "x-bb-device-handoff-client-token";
export const deviceHandoffClientTokenSignalSchema = z
  .object({
    type: z.literal("device-handoff-client-token"),
    token: z
      .string()
      .length(22)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();
export const deviceHandoffClientTokenSignalLenientSchema = z.object({
  type: z.literal("device-handoff-client-token"),
  token: z.string(),
});

const deviceHandoffOriginSchema = z
  .object({
    threadId: z.string().min(1).max(128).optional(),
    terminalSessionId: z.string().min(1).max(128).optional(),
    turnId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (origin) =>
      origin.threadId !== undefined || origin.terminalSessionId !== undefined,
    "A thread or terminal session origin is required",
  );

export const deviceHandoffRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("copy-text"),
      text: z.string().max(DEVICE_HANDOFF_TEXT_MAX_BYTES),
      origin: deviceHandoffOriginSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-url"),
      url: z.string().min(1).max(DEVICE_HANDOFF_URL_MAX_LENGTH),
      origin: deviceHandoffOriginSchema,
    })
    .strict()
    .superRefine((request, context) => {
      try {
        const parsed = new URL(request.url);
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.username.length > 0 ||
          parsed.password.length > 0
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "URL must use http or https and cannot include credentials",
          });
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "URL must be a valid http or https URL",
        });
      }
    }),
]);

export type DeviceHandoffRequest = z.infer<typeof deviceHandoffRequestSchema>;

export const deviceHandoffSignalSchema = z
  .object({
    type: z.literal("device-handoff"),
    id: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    request: deviceHandoffRequestSchema,
    originLabel: z.string().max(256),
  })
  .strict();

export type DeviceHandoffSignal = z.infer<typeof deviceHandoffSignalSchema>;

export const deviceHandoffSignalLenientSchema = z.object({
  type: z.literal("device-handoff"),
  id: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  request: deviceHandoffRequestSchema,
  originLabel: z.string(),
});

export const deviceHandoffNoticeSignalSchema = z
  .object({
    type: z.literal("device-handoff-notice"),
    id: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    kind: z.enum(["copy-text", "open-url"]),
    threadId: z.string().min(1),
    hostLabel: z.string().max(256),
  })
  .strict();

export type DeviceHandoffNoticeSignal = z.infer<
  typeof deviceHandoffNoticeSignalSchema
>;

export const deviceHandoffNoticeSignalLenientSchema =
  deviceHandoffNoticeSignalSchema;

export const deviceHandoffShownSignalSchema = z
  .object({
    type: z.literal("device-handoff-shown"),
    id: z.string().min(1),
    deviceLabel: z.string().min(1).max(64),
  })
  .strict();

export type DeviceHandoffShownSignal = z.infer<
  typeof deviceHandoffShownSignalSchema
>;

export const deviceHandoffShownSignalLenientSchema =
  deviceHandoffShownSignalSchema;

export const deviceHandoffClaimRequestSchema = z
  .object({ id: z.string().min(1) })
  .strict();

export type DeviceHandoffClaimRequest = z.infer<
  typeof deviceHandoffClaimRequestSchema
>;

export const deviceHandoffExpiredSignalSchema = z
  .object({
    type: z.literal("device-handoff-expired"),
    id: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    terminalSessionId: z.string().min(1).nullable(),
  })
  .strict();

export type DeviceHandoffExpiredSignal = z.infer<
  typeof deviceHandoffExpiredSignalSchema
>;

export const deviceHandoffExpiredSignalLenientSchema = z.object({
  type: z.literal("device-handoff-expired"),
  id: z.string(),
  threadId: z.string().nullable(),
  terminalSessionId: z.string().nullable(),
});

export const deviceHandoffAcknowledgedSignalSchema = z
  .object({
    type: z.literal("device-handoff-acknowledged"),
    id: z.string().min(1),
  })
  .strict();

export const deviceHandoffAcknowledgedSignalLenientSchema = z.object({
  type: z.literal("device-handoff-acknowledged"),
  id: z.string(),
});

export type DeviceHandoffAcknowledgedSignal = z.infer<
  typeof deviceHandoffAcknowledgedSignalSchema
>;
