import { describe, expect, it } from "vitest";
import { nativeTerminalThreadSchema } from "../src/index.js";

const view = {
  threadId: "thr_native",
  providerId: "codex",
  displayName: "Codex",
  nativeSessionId: null,
  canReturnToChat: false,
  terminal: null,
};

describe("native terminal stored model response", () => {
  it.each(["gpt-6.1-sol", null])("requires the stored model value (%s)", (model) => {
    expect(nativeTerminalThreadSchema.parse({ ...view, model }).model).toBe(model);
  });

  it("rejects responses that omit model at the server boundary", () => {
    expect(nativeTerminalThreadSchema.safeParse(view).success).toBe(false);
  });
});
