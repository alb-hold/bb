import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordFrontendInventory,
  buildFrontendInventory,
} from "./frontend-inventory.js";

async function record(setup: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "bb-inventory-"));
  try {
    const jsPath = join(rootDir, "app.js");
    await writeFile(
      jsPath,
      `export default { __bbPluginApp: true, setup(app) { ${setup} } };`,
    );
    return await buildFrontendInventory({
      rootDir,
      jsPath,
      runtimeSlots: [],
      esbuild,
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("frontend inventory recording", () => {
  it("records settings sections including Mobile without evaluating components", async () => {
    expect(
      await record(
        `app.slots.settingsSection({ id: "configuration", title: "Settings", component() { throw new Error("rendered"); } }); app.slots.settingsSection({ id: "pairing", experimental_page: "mobile", component() {} });`,
      ),
    ).toEqual({
      version: 1,
      settingsSections: [
        { id: "configuration", title: "Settings" },
        { id: "pairing", experimental_page: "mobile" },
      ],
    });
  });

  it("keeps a mixed account-pool-shaped frontend eager", async () => {
    expect(
      await record(
        `app.slots.settingsSection({ id: "accounts", component() {} }); app.composer.customize({ id: "subscription", scopes: ["new-thread", "thread"], experimental_modelPicker() {} });`,
      ),
    ).toBeNull();
  });

  it("keeps a boot slot eager", async () => {
    expect(
      await record(
        `app.slots.homepageSection({ id: "home", title: "Home", component() {} });`,
      ),
    ).toBeNull();
  });

  it("keeps throwing and non-serializable headings eager", async () => {
    expect(await record(`throw new Error("setup");`)).toBeNull();
    expect(
      await record(
        `app.slots.settingsSection({ id: "settings", title() {}, component() {} });`,
      ),
    ).toBeNull();
    expect(
      await record(
        `app.slots.settingsSection({ id: "settings", label() {}, component() {} });`,
      ),
    ).toBeNull();
  });

  it("bounds synchronous loops and unavailable global access", async () => {
    expect(await recordFrontendInventory("", "while (true) {}")).toBeNull();
    expect(await record(`document.title = "side effect";`)).toBeNull();
  });

  it("rejects malformed output from the recording realm", async () => {
    expect(
      await recordFrontendInventory(
        "",
        `'${JSON.stringify({ version: 1, settingsSections: [{ id: "settings", label: "Unknown" }] })}'`,
      ),
    ).toBeNull();
  });

  it("keeps asynchronous and pending work eager", async () => {
    expect(await record(`return (async () => {})();`)).toBeNull();
    expect(
      await record(
        `app.slots.settingsSection({ id: "settings", component() {} }); (async () => {})();`,
      ),
    ).toBeNull();
    expect(
      await recordFrontendInventory(
        "",
        `new Promise(() => {}); '${JSON.stringify({ version: 1, settingsSections: [{ id: "settings" }] })}';`,
      ),
    ).toBeNull();
  });

  it("keeps conditional browser registrations and global writes eager", async () => {
    expect(
      await record(
        `app.slots.settingsSection({ id: "settings", component() {} }); if (typeof customBrowserGlobal !== "undefined") app.slots.homepageSection({ id: "home", title: "Home", component() {} });`,
      ),
    ).toBeNull();
    expect(
      await record(
        `app.slots.settingsSection({ id: "settings", component() {} }); globalThis.bootEffect = true;`,
      ),
    ).toBeNull();
  });
  it("keeps swallowed unavailable access and unknown API destinations eager", async () => {
    expect(
      await record(
        `try { document.title; } catch {} app.slots.settingsSection({ id: "settings", component() {} });`,
      ),
    ).toBeNull();
    expect(
      await record(
        `app.slots.settingsSection({ id: "settings", component() {} }); app.slots.futureSurface?.({});`,
      ),
    ).toBeNull();
  });
});
