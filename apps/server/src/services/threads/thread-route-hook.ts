import { z } from "zod";
import type { PluginHookSignatures } from "@get-bb/plugin-sdk";
import {
  pluginHookProvider,
  type PluginHookRegistration,
} from "../plugins/plugin-hook-registry.js";
import { decideWithinBox } from "./dispatch-hooks.js";

type RouteContext =
  PluginHookSignatures["experimental_thread.route"]["context"];

export const THREAD_ROUTE_HOOK_TIMEOUT_MS = 2_000;
export const THREAD_ROUTE_INPUT_TEXT_MAX_LENGTH = 4_000;

const routeDecisionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().nullable().optional(),
    reason: z.string().optional(),
  })
  .nullable();

export interface ThreadRouteDecision {
  pluginId: string;
  providerId: string;
  model: string | null;
  reason: string | null;
}

export type ThreadRouteFailureKind =
  | "timeout"
  | "threw"
  | "invalid_decision"
  | "host_error";

export interface ThreadRouteFailure {
  pluginId: string;
  kind: ThreadRouteFailureKind;
  errorName: string | null;
}

export interface ThreadRouteOutcome {
  decision: ThreadRouteDecision | null;
  failures: ThreadRouteFailure[];
}

const SAFE_LOG_TOKEN = /^[a-z0-9_.:-]{1,64}$/i;

export function safeHookLogToken(value: string): string {
  return SAFE_LOG_TOKEN.test(value) ? value : `[redacted len=${value.length}]`;
}

const BUILT_IN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
]);

export function builtInErrorLabel(name: string): string {
  return BUILT_IN_ERROR_NAMES.has(name) ? name : "other";
}

type HandlerResult =
  | { threw: false; value: unknown }
  | { threw: true; errorName: string };

type HookEvaluation =
  | { type: "failure"; failure: ThreadRouteFailure }
  | { type: "pass" }
  | { type: "decision"; decision: ThreadRouteDecision };

type RouteHookProvider = NonNullable<ReturnType<typeof pluginHookProvider>>;
type RouteHook = PluginHookRegistration<"experimental_thread.route">;

async function evaluateHook(
  provider: RouteHookProvider,
  hook: RouteHook,
  context: RouteContext,
): Promise<HookEvaluation> {
  const pluginId = hook.pluginId;
  const failure = (
    kind: ThreadRouteFailureKind,
    errorName: string | null = null,
  ): HookEvaluation => ({
    type: "failure",
    failure: { pluginId, kind, errorName },
  });
  const invocation = await provider.invokeHook(hook, "thread route", () =>
    decideWithinBox(
      async (): Promise<HandlerResult> => {
        try {
          const raw = hook.handler(context);
          return {
            threw: false,
            value: raw instanceof Promise ? await raw : raw,
          };
        } catch (error) {
          return {
            threw: true,
            errorName: builtInErrorLabel(
              error instanceof Error ? error.name : "NonError",
            ),
          };
        }
      },
      Math.min(provider.decisionTimeoutMs, THREAD_ROUTE_HOOK_TIMEOUT_MS),
    ),
  );
  if (!invocation.ok) return failure("host_error");
  if (!invocation.value.ok) return failure("timeout");
  if (invocation.value.value.threw) {
    return failure("threw", invocation.value.value.errorName);
  }
  let parsed: ReturnType<typeof routeDecisionSchema.safeParse>;
  try {
    parsed = routeDecisionSchema.safeParse(invocation.value.value.value);
  } catch {
    return failure("invalid_decision");
  }
  if (!parsed.success) return failure("invalid_decision");
  if (parsed.data === null) return { type: "pass" };
  return {
    type: "decision",
    decision: {
      pluginId,
      providerId: parsed.data.providerId,
      model: parsed.data.model ?? null,
      reason: parsed.data.reason ?? null,
    },
  };
}

export async function runThreadRouteHooks(
  context: RouteContext,
): Promise<ThreadRouteOutcome> {
  const failures: ThreadRouteFailure[] = [];
  try {
    const provider = pluginHookProvider();
    if (provider === undefined) return { decision: null, failures };
    for (const hook of provider.listHooks("experimental_thread.route")) {
      let evaluation: HookEvaluation;
      try {
        evaluation = await evaluateHook(provider, hook, context);
      } catch {
        let pluginId = "unknown";
        try {
          pluginId = hook.pluginId;
        } catch {
          pluginId = "unknown";
        }
        evaluation = {
          type: "failure",
          failure: { pluginId, kind: "host_error", errorName: null },
        };
      }
      if (evaluation.type === "failure") {
        failures.push(evaluation.failure);
        continue;
      }
      if (evaluation.type === "decision") {
        return { decision: evaluation.decision, failures };
      }
    }
  } catch {
    failures.push({ pluginId: "unknown", kind: "host_error", errorName: null });
  }
  return { decision: null, failures };
}
