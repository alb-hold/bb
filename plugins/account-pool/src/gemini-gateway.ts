// Translation between antigravity-acp's gateway auth (genai `v1beta/models`
// calls to the hub) and the Code Assist `v1internal` API that the runtime's
// own OAuth path calls. Every rule here mirrors antigravity-acp 1.5.0:
// - ccpa_connection/proxy_server.py: the model comes from the request path,
//   the genai body is forwarded unchanged as `request`, and each SSE
//   `data:` event's `response` is unwrapped back to genai.
// - ccpa_connection client: POST `<tier base>/v1internal:<method>` with
//   `{project, model, request}` and exactly Authorization, Content-Type and
//   User-Agent.
// - useragent.py: one aidev User-Agent; the gateway path only adds
//   `auth_method=gateway`.
// - server `_build_literal_model_target` (OAuth) sends the picked id as is;
//   `_build_mapped_model_target` (gateway) splits a mapped id into its base
//   model plus `thinkingLevel`, so the hub joins it back.

/** The only antigravity-acp release whose gateway wire this hub speaks. */
export const SUPPORTED_RUNTIME_VERSION = "1.5.0";

const RUNTIME_USER_AGENT = /antigravity\/acp\/([^\s(]+) \(([^)]*)\)/u;

// DEFAULT_MODEL_METADATA_MAP in antigravity-acp 1.5.0 (model_selection):
// [family id, base model id, thinking levels].
const THINKING_FAMILIES: readonly (readonly [string, string, readonly string[]])[] =
  [
    ["gemini-4-carbon", "gemini-4-carbon", ["medium", "high", "low"]],
    ["gemini-4-argon", "gemini-4-argon", ["high", "medium", "low"]],
    ["gemini-3.8-flash", "gemini-3.8-flash", ["high", "medium", "low"]],
    ["gemini-3.7-flash", "gemini-3.7-flash", ["high", "medium", "low"]],
    ["gemini-3.6-flash", "gemini-3.6-flash", ["high", "medium", "low"]],
    ["gemini-3.5-flash", "gemini-3.5-flash", ["high", "medium", "low"]],
    ["gemini-3.1-pro", "gemini-3.1-pro-preview", ["high", "low"]],
  ];

const MAPPED_MODELS = new Map<string, string>(
  THINKING_FAMILIES.flatMap(([family, base, levels]) =>
    levels.map((level) => [`${base}\u0000${level}`, `${family}-${level}`] as const),
  ),
);

// The gateway path's image target is the SDK default; the OAuth path names
// `_OAUTH_IMAGE_MODEL`.
const GATEWAY_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
const OAUTH_IMAGE_MODEL = "gemini-3.1-flash-image";

/** Ids the runtime can call before any model list was served. */
export const STATIC_GEMINI_MODEL_IDS: readonly string[] = [
  ...new Set([
    ...THINKING_FAMILIES.flatMap(([family, base, levels]) => [
      base,
      ...levels.map((level) => `${family}-${level}`),
    ]),
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    GATEWAY_IMAGE_MODEL,
  ]),
];

export const GEMINI_MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/u;

export type GeminiGatewayCall =
  | { kind: "models"; api: "v1beta" | "v1" }
  | {
      kind: "generate";
      model: string;
      method: "streamGenerateContent" | "generateContent";
    };

export function geminiGatewayCall(url: URL): GeminiGatewayCall | null {
  const match =
    /\/(v1beta|v1)\/models(?:\/([^/:]+):(streamGenerateContent|generateContent))?$/u.exec(
      url.pathname,
    );
  if (match === null) return null;
  const [, api, model, method] = match;
  if (model === undefined)
    return { kind: "models", api: api as "v1beta" | "v1" };
  if (!GEMINI_MODEL_ID.test(model)) return null;
  return {
    kind: "generate",
    model,
    method: method as "streamGenerateContent" | "generateContent",
  };
}

/**
 * Why this client cannot be routed, or null. Only a runtime whose gateway wire
 * matches this translation is served; anything else is told so by name
 * instead of being forwarded.
 */
export function geminiRuntimeRefusal(headers: Headers): string | null {
  const match = RUNTIME_USER_AGENT.exec(headers.get("user-agent") ?? "");
  if (match === null)
    return "Gemini routing is not available: the request is not from antigravity-acp.";
  if (match[1] !== SUPPORTED_RUNTIME_VERSION)
    return `Gemini routing is not available: antigravity-acp ${match[1]} is installed, and the Account Pooler supports only ${SUPPORTED_RUNTIME_VERSION}.`;
  return null;
}

/** The runtime's own User-Agent, as its OAuth path sends it upstream. */
export function geminiUpstreamUserAgent(headers: Headers): string {
  const match = RUNTIME_USER_AGENT.exec(headers.get("user-agent") ?? "");
  if (match === null) return `antigravity/acp/${SUPPORTED_RUNTIME_VERSION}`;
  const fields = match[2]!
    .split(";")
    .map((field) => field.trim())
    .filter((field) => field !== "" && field !== "auth_method=gateway");
  return `antigravity/acp/${match[1]} (${fields.join("; ")})`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The Code Assist model id and genai request for a gateway call: a mapped id
 * the runtime split into base + thinkingLevel is joined back, as the OAuth
 * path would have sent it.
 */
export function codeAssistModel(
  pathModel: string,
  body: Record<string, unknown>,
): { model: string; request: Record<string, unknown> } {
  if (pathModel === GATEWAY_IMAGE_MODEL)
    return { model: OAUTH_IMAGE_MODEL, request: body };
  const generation = record(body.generationConfig);
  const thinking = record(generation?.thinkingConfig);
  const level = thinking?.thinkingLevel;
  const mapped =
    typeof level === "string"
      ? MAPPED_MODELS.get(`${pathModel}\u0000${level.toLowerCase()}`)
      : undefined;
  if (mapped === undefined || generation === null || thinking === null)
    return { model: pathModel, request: body };
  const { thinkingLevel: _level, ...restThinking } = thinking;
  const { thinkingConfig: _thinking, ...restGeneration } = generation;
  // The OAuth path sends no thinkingConfig for a literal id, never `{}`.
  return {
    model: mapped,
    request: {
      ...body,
      generationConfig:
        Object.keys(restThinking).length === 0
          ? restGeneration
          : { ...restGeneration, thinkingConfig: restThinking },
    },
  };
}

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function bufferedJson(
  transform: (payload: unknown) => unknown,
): TransformStream<Uint8Array, Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_BUFFERED_BYTES) {
        controller.error(new Error("Google Gemini response is too large."));
        return;
      }
      chunks.push(chunk);
    },
    flush(controller) {
      const text = Buffer.concat(chunks).toString("utf8");
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        controller.enqueue(new TextEncoder().encode(text));
        return;
      }
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify(transform(payload))),
      );
    },
  });
}

/** `generateContent`: the genai response is the `response` member. */
export function unwrapUnary(): TransformStream<Uint8Array, Uint8Array> {
  return bufferedJson((payload) => {
    const wrapped = record(payload);
    return wrapped !== null && "response" in wrapped ? wrapped.response : payload;
  });
}

/**
 * `streamGenerateContent?alt=sse`: each `data:` event's `response` is written
 * in its place; every other line passes through. An in-stream error event is
 * passed on as is, after `onError` sees it.
 */
export function unwrapSse(
  onError: (detail: string) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const line = (text: string): string => {
    if (!text.startsWith("data:")) return text;
    const data = text.slice(5).trim();
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return text;
    }
    const event = record(payload);
    if (event === null) return text;
    if ("response" in event) return `data: ${JSON.stringify(event.response)}`;
    if ("error" in event) onError(data);
    return text;
  };
  const drain = (final: boolean): string => {
    let out = "";
    while (true) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const raw = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const carriage = raw.endsWith("\r");
      out += line(carriage ? raw.slice(0, -1) : raw) + (carriage ? "\r\n" : "\n");
    }
    if (final && pending !== "") {
      out += line(pending);
      pending = "";
    }
    return out;
  };
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > MAX_BUFFERED_BYTES) {
        controller.error(new Error("Google Gemini event is too large."));
        return;
      }
      const out = drain(false);
      if (out !== "") controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      pending += decoder.decode();
      const out = drain(true);
      if (out !== "") controller.enqueue(encoder.encode(out));
    },
  });
}

interface CodeAssistModel {
  id: string;
  displayName: string;
  maxTokens: number | null;
}

/**
 * The account's models from `fetchAvailableModels`, in the order its
 * `agentModelSorts` give, Gemini models only. Like the runtime's
 * `_parse_ccpa_response`, a model the sorts leave out is dropped. A response
 * with no sorted ids at all lists its `models` keys instead, so the runtime
 * is not left on its built-in fallback ids while the account has models.
 */
export function codeAssistModels(payload: unknown): CodeAssistModel[] {
  const root = record(payload);
  const models = record(root?.models);
  if (models === null) return [];
  const order: string[] = [];
  const sorts = Array.isArray(root?.agentModelSorts) ? root.agentModelSorts : [];
  for (const sort of sorts) {
    const groups = record(sort)?.groups;
    for (const group of Array.isArray(groups) ? groups : []) {
      const ids = record(group)?.modelIds;
      for (const id of Array.isArray(ids) ? ids : [])
        if (typeof id === "string" && !order.includes(id)) order.push(id);
    }
  }
  if (order.length === 0) order.push(...Object.keys(models));
  return order.flatMap((id) => {
    const entry = record(models[id]);
    if (
      entry === null ||
      entry.disabled === true ||
      !id.startsWith("gemini-") ||
      !GEMINI_MODEL_ID.test(id)
    )
      return [];
    return [
      {
        id,
        displayName:
          typeof entry.displayName === "string" ? entry.displayName : id,
        maxTokens: typeof entry.maxTokens === "number" ? entry.maxTokens : null,
      },
    ];
  });
}

/** The model list in the shape the runtime asked for. */
export function modelListResponse(
  api: "v1beta" | "v1",
  onModels: (ids: string[]) => void,
): TransformStream<Uint8Array, Uint8Array> {
  return bufferedJson((payload) => {
    const models = codeAssistModels(payload);
    onModels(models.map((model) => model.id));
    if (api === "v1")
      return {
        object: "list",
        data: models.map((model) => ({ id: model.id, object: "model" })),
      };
    return {
      models: models.map((model) => ({
        name: `models/${model.id}`,
        displayName: model.displayName,
        ...(model.maxTokens === null ? {} : { inputTokenLimit: model.maxTokens }),
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      })),
    };
  });
}
