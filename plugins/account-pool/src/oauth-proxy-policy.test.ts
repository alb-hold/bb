import { describe, expect, it } from "vitest";
import { classifyOAuthProxyRequest } from "./oauth-proxy-policy.js";

describe("classifyOAuthProxyRequest", () => {
  it.each([
    ["GET", "/api/claude_code/policy_limits"],
    ["POST", "/api/eval/sdk-zAZezfDKGoZuXXKe"],
    ["GET", "/api/claude_cli/bootstrap"],
    ["POST", "/api/frame/deploy/prepare"],
    ["POST", "/api/frame/deploy/direct?create_confirmed=1"],
    ["GET", "/api/frame/frames?limit=200"],
    ["GET", "/api/frame/0b6a7c1e-3f2d-4c11-9a52-0f1e2d3c4b5a?v=2"],
    ["PATCH", "/api/frame/0b6a7c1e-3f2d-4c11-9a52-0f1e2d3c4b5a"],
    ["DELETE", "/api/frame/blob/slug/file.png/agent-delete"],
  ])("forwards %s %s", (method, target) => {
    expect(classifyOAuthProxyRequest(method, target)).toEqual({
      kind: "forward",
    });
  });

  it("answers settings and telemetry locally", () => {
    expect(
      classifyOAuthProxyRequest("GET", "/api/claude_code/settings"),
    ).toMatchObject({ kind: "local" });
    expect(
      classifyOAuthProxyRequest("POST", "/api/event_logging/v2/batch"),
    ).toEqual({ kind: "local", status: 204, body: null });
  });

  it.each([
    ["GET", "/api/oauth/profile"],
    ["GET", "/api/oauth/usage"],
    ["GET", "/mcp-registry/v0/servers"],
    ["POST", "/v1/messages"],
    ["DELETE", "/api/claude_code/policy_limits"],
    ["POST", "/api/claude_code/policy_limits"],
    ["GET", "/api/frame"],
    ["GET", "/api/frames/x"],
    ["GET", "/api/frame/../oauth/profile"],
    ["GET", "/api/frame/%2e%2e/oauth/profile"],
    ["GET", "/api/frame/%2E%2E%2Foauth"],
    ["GET", "/api/frame/a//b"],
    ["GET", "/api/frame/a\\b"],
    ["GET", "/api/frame/a b"],
    ["GET", "/api/frame/x#frag"],
    ["GET", "https://evil.example/api/frame/x"],
    ["GET", "//evil.example/api/frame/x"],
    ["GET", "/api/frame/x?" + "a".repeat(3000)],
    ["TRACE", "/api/frame/x"],
  ])("denies %s %s", (method, target) => {
    expect(classifyOAuthProxyRequest(method, target)).toEqual({
      kind: "deny",
    });
  });
});
