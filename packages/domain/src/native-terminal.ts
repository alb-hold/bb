import { z } from "zod";

export const PROVIDER_NATIVE_TERMINAL_MAX_ARGS = 16;

const TEMPLATE_TOKEN = /\{([A-Za-z]+)\}/gu;

function templateTokens(value: string): string[] {
  return [...value.matchAll(TEMPLATE_TOKEN)].map((match) => match[1] ?? "");
}

function templateArgsSchema(allowed: readonly string[]) {
  return z
    .array(z.string().min(1).max(256))
    .max(PROVIDER_NATIVE_TERMINAL_MAX_ARGS)
    .superRefine((args, context) => {
      for (const arg of args) {
        for (const token of templateTokens(arg)) {
          if (!allowed.includes(token)) {
            context.addIssue({
              code: "custom",
              message: `may only use ${allowed.map((name) => `{${name}}`).join(", ") || "no tokens"}, not {${token}}`,
            });
          }
        }
      }
    });
}

function requiresToken(args: readonly string[], token: string): boolean {
  return args.some((arg) => templateTokens(arg).includes(token));
}

const environmentVariableNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/u, "must be an environment variable name");

function relativePatternSchema(allowed: readonly string[]) {
  return z
    .string()
    .min(1)
    .max(256)
    .superRefine((value, context) => {
      const segments = value.split("/");
      if (
        value.startsWith("/") ||
        segments.some(
          (segment) =>
            segment.length === 0 || segment === "." || segment === "..",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "must be a relative path without empty or dot segments",
        });
      }
      for (const token of templateTokens(value)) {
        if (!allowed.includes(token)) {
          context.addIssue({
            code: "custom",
            message: `may only use ${allowed.map((name) => `{${name}}`).join(", ")}, not {${token}}`,
          });
        }
      }
    });
}

const headerFieldPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u,
    "must be a dotted field path",
  );

const recordFieldPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+))*$/u,
    "must be a dotted field path",
  );

const providerNativeTerminalRecordMatchSchema = z
  .object({
    equals: z.record(recordFieldPathSchema, z.string().min(1).max(256)),
    startsWith: z
      .record(recordFieldPathSchema, z.string().min(1).max(256))
      .optional(),
  })
  .strict();

const hookEventNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u, "must be a hook event name");

export const providerNativeTerminalActivitySchema = z
  .object({
    hooks: z
      .object({
        args: templateArgsSchema(["settings"]),
        working: z.array(hookEventNameSchema).min(1).max(8),
        idle: z.array(hookEventNameSchema).min(1).max(8),
        promptField: recordFieldPathSchema,
      })
      .strict()
      .superRefine((hooks, context) => {
        if (!requiresToken(hooks.args, "settings")) {
          context.addIssue({
            code: "custom",
            path: ["args"],
            message: "must pass {settings}",
          });
        }
      })
      .optional(),
    transcript: z
      .object({
        working: z.array(providerNativeTerminalRecordMatchSchema).max(8),
        idle: z.array(providerNativeTerminalRecordMatchSchema).max(8),
        prompt: z
          .array(
            z
              .object({
                match: providerNativeTerminalRecordMatchSchema,
                text: recordFieldPathSchema,
              })
              .strict(),
          )
          .max(8),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderNativeTerminalActivity = z.infer<
  typeof providerNativeTerminalActivitySchema
>;
export type ProviderNativeTerminalRecordMatch = z.infer<
  typeof providerNativeTerminalRecordMatchSchema
>;

export const providerNativeTerminalSessionRootSchema = z
  .object({
    env: environmentVariableNameSchema.nullable(),
    home: relativePatternSchema([]),
  })
  .strict();

export const providerNativeTerminalAssignedSessionSchema = z
  .object({
    kind: z.literal("assigned"),
    startArgs: templateArgsSchema(["sessionId"]),
    resumeArgs: templateArgsSchema(["sessionId"]),
    transcript: relativePatternSchema(["sessionId"]),
  })
  .strict()
  .superRefine((session, context) => {
    for (const field of ["startArgs", "resumeArgs"] as const) {
      if (!requiresToken(session[field], "sessionId")) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "must pass {sessionId}",
        });
      }
    }
    if (!templateTokens(session.transcript).includes("sessionId")) {
      context.addIssue({
        code: "custom",
        path: ["transcript"],
        message: "must name the {sessionId} file",
      });
    }
  });

export const providerNativeTerminalDiscoveredSessionSchema = z
  .object({
    kind: z.literal("discovered"),
    resumeArgs: templateArgsSchema(["sessionId"]),
    transcripts: relativePatternSchema(["yyyy", "mm", "dd"]),
    header: z
      .object({
        match: z.record(headerFieldPathSchema, z.string().min(1)),
        id: headerFieldPathSchema,
        cwd: headerFieldPathSchema,
        startedAt: headerFieldPathSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((session, context) => {
    if (!requiresToken(session.resumeArgs, "sessionId")) {
      context.addIssue({
        code: "custom",
        path: ["resumeArgs"],
        message: "must pass {sessionId}",
      });
    }
  });

export const providerNativeTerminalSchema = z
  .object({
    executable: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
        "must be a bare executable name",
      ),
    launchArgs: templateArgsSchema([]),
    modelArgs: templateArgsSchema(["model"]),
    pastePlaceholders: z.array(z.string().trim().min(4).max(64)).max(4),
    sessionRoot: providerNativeTerminalSessionRootSchema,
    session: z.discriminatedUnion("kind", [
      providerNativeTerminalAssignedSessionSchema,
      providerNativeTerminalDiscoveredSessionSchema,
    ]),
    activity: providerNativeTerminalActivitySchema.optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.modelArgs.length > 0 && !requiresToken(spec.modelArgs, "model")) {
      context.addIssue({
        code: "custom",
        path: ["modelArgs"],
        message: "must pass {model} when not empty",
      });
    }
  });
export type ProviderNativeTerminal = z.infer<
  typeof providerNativeTerminalSchema
>;

export function fillNativeTerminalTemplate(
  value: string,
  values: Readonly<Record<string, string>>,
): string {
  return value.replace(TEMPLATE_TOKEN, (whole, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? whole) : whole,
  );
}
