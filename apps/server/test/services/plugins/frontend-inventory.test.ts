import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@bb/domain";
import { loadPluginAppBundle } from "../../../src/services/plugins/app-bundle.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function bundle(frontendInventory?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "bb-inventory-meta-"));
  roots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "app.js"), "export default {};");
  await writeFile(
    join(root, "dist", "app.meta.json"),
    JSON.stringify({
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: PLUGIN_SDK_VERSION,
      runtimeSlots: [],
      frontendInventory,
    }),
  );
  return loadPluginAppBundle("settings-only", root);
}

describe("frontend inventory asset metadata", () => {
  it("passes a valid settings inventory through unchanged", async () => {
    const inventory = {
      version: 1,
      settingsSections: [
        { id: "settings", title: "Configuration" },
        { id: "pairing", experimental_page: "mobile" },
      ],
    };
    expect((await bundle(inventory)).state.bundle?.frontendInventory).toEqual(
      inventory,
    );
  });
  it.each([
    undefined,
    null,
    { version: 1, settingsSections: [] },
    { version: 1, settingsSections: [{ id: "settings", unknown: "slot" }] },
  ])(
    "keeps missing or malformed inventory eager without losing assets (%j)",
    async (inventory) => {
      const result = await bundle(inventory);
      expect(result.state.bundle?.compatible).toBe(true);
      expect(result.state.bundle?.frontendInventory).toBeUndefined();
    },
  );
});
