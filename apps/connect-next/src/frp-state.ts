export type FrpProxyState =
  | { kind: "online"; clientId: string }
  | { kind: "offline" }
  | { kind: "unknown" };

export interface FrpState {
  proxy(name: string): Promise<FrpProxyState>;
  online(): Promise<Map<string, string> | null>;
}

export interface FrpStateOptions {
  port: number;
  user: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateOf(value: unknown): FrpProxyState {
  if (!isRecord(value)) return { kind: "unknown" };
  if (value.status === "offline") return { kind: "offline" };
  if (value.status !== "online") return { kind: "unknown" };
  return {
    kind: "online",
    clientId: typeof value.clientID === "string" ? value.clientID : "",
  };
}

export function createFrpState(options: FrpStateOptions): FrpState {
  const fetchImpl = options.fetch ?? fetch;
  const origin = `http://127.0.0.1:${options.port}`;
  const authorization = `Basic ${Buffer.from(
    `${options.user}:${options.password}`,
  ).toString("base64")}`;

  async function get(path: string): Promise<Response | null> {
    try {
      return await fetchImpl(`${origin}${path}`, {
        headers: { authorization },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  }

  return {
    async proxy(name) {
      const response = await get(`/api/proxy/http/${encodeURIComponent(name)}`);
      if (response === null) return { kind: "unknown" };
      if (response.status === 404) return { kind: "offline" };
      if (!response.ok) return { kind: "unknown" };
      return stateOf(await response.json().catch(() => null));
    },
    async online() {
      const response = await get("/api/proxy/http");
      if (response === null || !response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      if (!isRecord(body) || !Array.isArray(body.proxies)) return null;
      const online = new Map<string, string>();
      for (const entry of body.proxies) {
        const state = stateOf(entry);
        if (state.kind === "unknown") return null;
        if (state.kind !== "online") continue;
        if (!isRecord(entry) || typeof entry.name !== "string") return null;
        online.set(entry.name, state.clientId);
      }
      return online;
    },
  };
}
