// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    const { stdout: ver } = await execFileAsync(chromiumPath!, ["--version"], { timeout: 5000 });
    const shells = [
      ...globSync(join(homedir(), ".cache/ms-playwright/chromium_headless_shell-*/chrome-*/headless_shell")),
      ...globSync(join(dirname(chromiumPath!), "*headless*")),
    ];
    const tiny = join(dir, "tiny.html");
    await writeFile(tiny, `<!doctype html><pre id="result"></pre><script>document.querySelector('#result').textContent='TINY_OK';</script>`);
    const baseFlags = (p: string) => ["--headless", `--user-data-dir=${join(dir, p)}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking", "--no-first-run"];
    const probe = async (label: string, extra: string[], url: string) => {
      const t0 = Date.now();
      try {
        const res = await execFileAsync(chromiumPath!, [...baseFlags(`p-${label}`), ...extra, "--dump-dom", url], { timeout: 6000, maxBuffer: 8 * 1024 * 1024 });
        return `${label}:ok:${Date.now() - t0}ms:out=${res.stdout.length}:head=${JSON.stringify(res.stdout.slice(0, 120))}`;
      } catch (err) {
        const e = err as { code?: unknown; signal?: unknown; killed?: unknown; stdout?: string; stderr?: string };
        return `${label}:err:${Date.now() - t0}ms:code=${String(e.code)}:sig=${String(e.signal)}:out=${e.stdout?.length ?? 0}:errTail=${JSON.stringify((e.stderr ?? "").slice(-350))}`;
      }
    };
    const htmlContent = `<!doctype html><meta charset="utf-8"><style>${css}</style>${container.innerHTML}<pre id="result"></pre><script>
const sections=[...document.querySelectorAll('[data-testid="plugin-homepage-sections"] > section')];
document.querySelector('#result').textContent=JSON.stringify(sections.map(s=>{const r=s.getBoundingClientRect(),h=s.querySelector('h2'),hr=h.getBoundingClientRect();return {display:getComputedStyle(s).display,width:r.width,height:r.height,headingVisible:!!(hr.width&&hr.height&&getComputedStyle(h).visibility!=="hidden"),text:s.textContent}}));
</script>`;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlContent);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const diag: string[] = [
      `bin=${chromiumPath}`,
      `ver=${ver.trim()}`,
      `shells=${JSON.stringify(shells)}`,
      `cssLen=${css.length}`,
      await probe("blank", [], "about:blank"),
      await probe("tiny", [], pathToFileURL(tiny).href),
      await probe("http", [], `http://127.0.0.1:${port}/`),
      await probe("fileV1", ["--enable-logging=stderr", "--v=1"], pathToFileURL(file).href),
    ];
    server.close();
    const { stdout, stderr } = await execFileAsync(chromiumPath!, [...baseFlags("profile"), "--allow-file-access-from-files", "--dump-dom", pathToFileURL(file).href], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }).catch((e) => ({ stdout: "", stderr: String(e) }));
    const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
    expect(raw, `${diag.join(" | ")} | mainStderr=${stderr.slice(0, 300)}`).toBeDefined();
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
