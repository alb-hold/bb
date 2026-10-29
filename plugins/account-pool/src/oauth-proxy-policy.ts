export const OAUTH_PROXY_HOST = "api.anthropic.com";
export const OAUTH_PROXY_ROUTE = "/claude-oauth";
export const TARGET_HOST_HEADER = "x-pool-target-host";
export const TARGET_METHOD_HEADER = "x-pool-target-method";
export const TARGET_PATH_HEADER = "x-pool-target-path";
export const MAX_TARGET_LENGTH = 2_048;

export type OAuthProxyDecision =
  | { kind: "forward" }
  | { kind: "local"; status: number; body: string | null }
  | { kind: "deny" };

const FORWARD: OAuthProxyDecision = { kind: "forward" };
const DENY: OAuthProxyDecision = { kind: "deny" };
const TARGET_PATTERN =
  /^\/[A-Za-z0-9._~%:@!$&'()*+,;=/-]*(?:\?[A-Za-z0-9._~%:@!$&'()*+,;=/?-]*)?$/u;
const FRAME_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const EVAL_PATH = /^\/api\/eval\/sdk-[A-Za-z0-9]+$/u;
const ARTIFACT_MCP_PATH = "/api/artifacts/mcp";
const ARTIFACT_MCP_METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);

function safeSegments(pathname: string): boolean {
  const segments = pathname.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    )
      return false;
  }
  return true;
}

export function classifyOAuthProxyRequest(
  method: string,
  target: string,
): OAuthProxyDecision {
  if (target.length > MAX_TARGET_LENGTH || !TARGET_PATTERN.test(target))
    return DENY;
  const queryStart = target.indexOf("?");
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  if (!safeSegments(pathname)) return DENY;
  if (pathname.startsWith("/api/frame/"))
    return FRAME_METHODS.has(method) ? FORWARD : DENY;
  if (
    queryStart === -1 &&
    pathname === ARTIFACT_MCP_PATH &&
    ARTIFACT_MCP_METHODS.has(method)
  )
    return FORWARD;
  if (method === "GET" && pathname === "/api/claude_code/policy_limits")
    return FORWARD;
  if (method === "GET" && pathname === "/api/claude_cli/bootstrap")
    return FORWARD;
  if (method === "POST" && EVAL_PATH.test(pathname)) return FORWARD;
  if (method === "GET" && pathname === "/api/claude_code/settings")
    return { kind: "local", status: 404, body: "{}" };
  if (method === "POST" && pathname === "/api/event_logging/v2/batch")
    return { kind: "local", status: 204, body: null };
  return DENY;
}
