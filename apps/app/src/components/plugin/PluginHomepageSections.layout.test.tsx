// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, inject, it } from "vitest";
import type {} from "../../../vitest.global-setup";
import appCss from "../../app.css?inline";
import { MemoryRouter } from "react-router-dom";
import { resetPluginSlotStoreForTest, setPluginSlotRegistrations } from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { PluginHomepageSections } from "./PluginHomepageSections";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("appChromiumPath");
afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
});
it("hides empty homepage sections and keeps populated sections visible in Chromium", async () => {
  function Empty() { return null; }
  function Populated() { return <div>populated section body</div>; }
  setPluginSlotRegistrations("empty", makePluginRegistrationSet({ homepageSections: [{ id: "empty", title: "Empty", component: Empty }] }));
  setPluginSlotRegistrations("populated", makePluginRegistrationSet({ homepageSections: [{ id: "populated", title: "Populated", component: Populated }] }));
  const { container } = render(<MemoryRouter initialEntries={["/"]}><PluginHomepageSections /></MemoryRouter>);
  expect(container.querySelectorAll("[data-testid=plugin-homepage-sections] > section")).toHaveLength(2);
  const dir = await mkdtemp(join(tmpdir(), "bb-homepage-sections-"));
  try {
    const css = appCss.replace(/url\((["']?)(\/[^)"']+)\1\)/g, (_m, _q: string, asset: string) => `url("${pathToFileURL(asset.startsWith("/@fs/") ? asset.slice(4) : resolve(process.cwd(), `.${asset}`))}")`);
    const file = join(dir, "index.html");
    await writeFile(file, `<!doctype html><meta charset="utf-8"><style>${css}</style>${container.innerHTML}<pre id="result"></pre><script>
const sections=[...document.querySelectorAll('[data-testid="plugin-homepage-sections"] > section')];
document.querySelector('#result').textContent=JSON.stringify(sections.map(s=>{const r=s.getBoundingClientRect(),h=s.querySelector('h2'),hr=h.getBoundingClientRect();return {display:getComputedStyle(s).display,width:r.width,height:r.height,headingVisible:!!(hr.width&&hr.height&&getComputedStyle(h).visibility!=="hidden"),text:s.textContent}}));
</script>`);
    const { stdout, stderr } = await execFileAsync(chromiumPath!, ["--headless", `--user-data-dir=${join(dir, "profile")}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--allow-file-access-from-files", "--dump-dom", pathToFileURL(file).href], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
    expect(raw, `stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`).toBeDefined();
    const result = JSON.parse(raw!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ display: "none", width: 0, height: 0, headingVisible: false });
    expect(result[1].display).not.toBe("none");
    expect(result[1].width).toBeGreaterThan(0);
    expect(result[1].height).toBeGreaterThan(0);
    expect(result[1].headingVisible).toBe(true);
    expect(result[1].text).toContain("populated section body");
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 40000);
