import { describe, expect, it } from "vitest";
import { resolveAcpAuthMethodId } from "./auth-method.js";

describe("resolveAcpAuthMethodId", () => {
  const gemini = [{ id: "oauth-personal" }, { id: "gemini-api-key" }];

  it("picks oauth-personal when the pool supplies a Code Assist token", () => {
    expect(
      resolveAcpAuthMethodId(gemini, {
        GOOGLE_GENAI_USE_GCA: "true",
        GOOGLE_CLOUD_ACCESS_TOKEN: "hub-token",
      }),
    ).toBe("oauth-personal");
  });

  it("does not pick it without the token, the flag, or the method", () => {
    expect(
      resolveAcpAuthMethodId(gemini, { GOOGLE_GENAI_USE_GCA: "true" }),
    ).toBeUndefined();
    expect(
      resolveAcpAuthMethodId(gemini, { GOOGLE_CLOUD_ACCESS_TOKEN: "t" }),
    ).toBeUndefined();
    expect(
      resolveAcpAuthMethodId([{ id: "gemini-api-key" }], {
        GOOGLE_GENAI_USE_GCA: "true",
        GOOGLE_CLOUD_ACCESS_TOKEN: "t",
      }),
    ).toBeUndefined();
  });

  it("keeps the existing picks", () => {
    expect(
      resolveAcpAuthMethodId([{ id: "xai.api_key" }], { XAI_API_KEY: "k" }),
    ).toBe("xai.api_key");
    expect(resolveAcpAuthMethodId([{ id: "cached_token" }], {})).toBe(
      "cached_token",
    );
  });
});
