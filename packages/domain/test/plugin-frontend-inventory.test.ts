import { describe, expect, it } from "vitest";
import { parsePluginFrontendInventory } from "../src/plugin-frontend-inventory.js";

describe("frontend inventory boundary", () => {
  it.each([
    undefined,
    null,
    {},
    { version: 2, settingsSections: [{ id: "settings" }] },
    { version: 1, settingsSections: [] },
    {
      version: 1,
      settingsSections: [{ id: "settings", title: () => "Settings" }],
    },
  ])("keeps absent or untrusted metadata eager (%j)", (value) => {
    expect(parsePluginFrontendInventory(value)).toBeNull();
  });
  it("rejects duplicate section identities", () => {
    expect(
      parsePluginFrontendInventory({
        version: 1,
        settingsSections: [{ id: "same" }, { id: "same" }],
      }),
    ).toBeNull();
  });
});
