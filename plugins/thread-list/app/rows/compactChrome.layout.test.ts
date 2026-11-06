import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, inject, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("threadListChromiumPath");
const appCss = await readFile(new URL("../../../../apps/app/src/app.css", import.meta.url), "utf8");
const touchCss = appCss.slice(appCss.indexOf("@media (width < 48rem) and (pointer: coarse)"));

it.each([360, 390])("keeps summary probes and terminal search inside disjoint 44px targets at %ipx", async (width) => {
  expect(chromiumPath).not.toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "bb-compact-chrome-"));
  try {
    const file = join(dir, "index.html");
    await writeFile(file, `<!doctype html><meta name="viewport" content="width=device-width"><style>
body { margin:0; width:${width}px } button { box-sizing:border-box; border:0 }
header { display:flex; gap:4px; height:48px; align-items:center }
header button { width:36px; height:36px }
[data-compact-touch-summary] { display:flex; width:100%; height:20px; padding:0; align-items:center }
${touchCss}
</style><header><button data-compact-touch="header">Actions</button><button data-compact-touch="header" data-terminal-search-trigger aria-label="Search terminal output">Search</button><button data-compact-touch="header">Panel</button></header>
<div data-compact-touch-height><div><button data-compact-touch-summary>Ran 1 command</button></div></div>
<div data-compact-touch-height><div><button data-compact-touch-summary>Ran 1 tool</button></div></div>
<pre id="result"></pre><script>
const box = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} };
const probe = el => { const r = el.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
return [[x,y-21],[x,y+21],[x-21,y],[x+21,y]].map(([x,y]) => el.contains(document.elementFromPoint(x,y))); };
const summaries = [...document.querySelectorAll('[data-compact-touch-summary]')];
const search = document.querySelector('[aria-label="Search terminal output"]');
document.querySelector('#result').textContent = JSON.stringify({coarse:matchMedia('(pointer: coarse)').matches, summaries:summaries.map(el => ({...box(el),hits:probe(el)})),search:{...box(search),hits:probe(search)}});
</script>`);
    const { stdout } = await execFileAsync(chromiumPath!, [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-extensions", "--disable-background-networking", "--no-first-run",
      "--blink-settings=primaryPointerType=2,availablePointerTypes=2",
      `--window-size=${width},900`, "--dump-dom", `file://${file}`,
    ], { timeout: 30_000 });
    const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
    expect(raw).toBeDefined();
    const target = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), hits: z.array(z.boolean()) });
    const result = z.object({ coarse: z.boolean(), summaries: z.array(target), search: target }).parse(JSON.parse(raw!.replaceAll("&quot;", '"')));
    expect(result.coarse).toBe(true);
    expect(result.summaries).toHaveLength(2);
    for (const summary of result.summaries) {
      expect(summary.hits.filter(Boolean).length).toBeGreaterThanOrEqual(3);
      expect(summary.height).toBeGreaterThanOrEqual(44);
    }
    expect(result.summaries[0].y + result.summaries[0].height).toBeLessThanOrEqual(result.summaries[1].y);
    expect(result.search.height).toBeGreaterThanOrEqual(44);
    expect(result.search.width).toBeGreaterThanOrEqual(44);
    expect(result.search.hits.every(Boolean)).toBe(true);
    await writeFile(join(tmpdir(), `p36-chrome-af0afa41bfdb-${width}.json`), JSON.stringify(result));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 40_000);
