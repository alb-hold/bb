import { describe, expect, it } from "vitest";
import { validatePluginProviderEnvEntries } from "../internal/host-policy.js";

describe("provider catalog identity", () => {
  it("retains an explicit identity without changing ordinary environment entries", () => {
    const entries = [
      {
        name: "CATALOG_TOKEN",
        value: "rotating",
        reason: "catalog credential",
        internal_DO_NOT_USE_catalogIdentity: "account-a",
      },
      {
        name: "MODEL_ENDPOINT",
        value: "https://models.example",
        reason: "catalog route",
      },
    ];
    expect(validatePluginProviderEnvEntries(entries)).toEqual(entries);
  });
  it("rejects an empty catalog identity at the plugin boundary", () => {
    expect(() =>
      validatePluginProviderEnvEntries([
        {
          name: "CATALOG_TOKEN",
          value: "rotating",
          reason: "catalog",
          internal_DO_NOT_USE_catalogIdentity: "",
        },
      ]),
    ).toThrow();
  });
});
