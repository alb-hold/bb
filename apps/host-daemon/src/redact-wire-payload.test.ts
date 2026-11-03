import { describe, expect, it } from "vitest";
import { redactWirePayload } from "./redact-wire-payload.js";

const SECRET = "s3cr3t-credential-value_abc123";

describe("redactWirePayload", () => {
  it("hides the native tool credential in a terminal.open message", () => {
    const message = JSON.stringify({
      type: "terminal.open",
      contributedEnv: [
        { name: "OTHER", value: "keep-me", source: { plugin: "x" } },
        {
          name: "BB_NATIVE_TOOL_CREDENTIAL",
          value: SECRET,
          source: { plugin: "claude-code" },
          reason: "r",
        },
      ],
      terminalId: "term_1",
    });
    const redacted = redactWirePayload(message);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("keep-me");
    expect(redacted).toContain('"terminalId":"term_1"');
    expect(() => JSON.parse(redacted)).not.toThrow();
  });

  it("hides it when the value is serialized before the name", () => {
    const redacted = redactWirePayload(
      JSON.stringify({
        value: SECRET,
        name: "BB_NATIVE_TOOL_CREDENTIAL",
      }),
    );
    expect(redacted).not.toContain(SECRET);
  });

  it("hides a value cut off mid-string", () => {
    const truncated = `{"type":"terminal.open","contributedEnv":[{"name":"BB_NATIVE_TOOL_CREDENTIAL","value":"${SECRET.slice(0, 10)}`;
    expect(redactWirePayload(truncated)).not.toContain(SECRET.slice(0, 10));
  });
});
