import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, inject, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("threadListChromiumPath");
const appCss = await readFile(
  new URL("../../../../apps/app/src/app.css", import.meta.url),
  "utf8",
);
const themeCss = await readFile(
  new URL("../../../../apps/app/src/components/ui/theme.css", import.meta.url),
  "utf8",
);
const disclosureSource = await readFile(
  new URL(
    "../../../../apps/app/src/components/ui/disclosure.tsx",
    import.meta.url,
  ),
  "utf8",
);
const tailwindTheme = await readFile(
  new URL(
    "../../../../apps/app/node_modules/tailwindcss/theme.css",
    import.meta.url,
  ),
  "utf8",
);
const panelClass = z
  .string()
  .parse(
    disclosureSource.match(/<div className="(group\/timeline-row[^"]*)"/)?.[1],
  );
const paddingSteps = Number(
  z.string().parse(panelClass.match(/max-md:pointer-coarse:py-(\d+)/)?.[1]),
);
const spacing = z
  .string()
  .parse(tailwindTheme.match(/--spacing:\s*([^;]+);/)?.[1]);
const breakpoint = z
  .string()
  .parse(tailwindTheme.match(/--breakpoint-md:\s*([^;]+);/)?.[1]);
const panelCss = `@media (width < ${breakpoint}) and (pointer: coarse) {
  [class="${panelClass}"] { padding-block: calc(${spacing} * ${paddingSteps}); }
}`;
const typographyCss = `${themeCss.match(/\n:root \{[^}]+\}/)?.[0]}${themeCss.match(/@media \(max-width: 767px\) and \(pointer: coarse\) \{\s*:root \{[^}]+\}\s*\}/)?.[0]}`;
const touchCss = appCss.slice(
  appCss.indexOf("@media (width < 48rem) and (pointer: coarse)"),
);

it.each(
  [360, 390, 1280].flatMap((width) =>
    [0, 4, 8].flatMap((gap) =>
      [2, 3, 4].map((count) => ({ width, gap, count })),
    ),
  ),
)(
  "preserves the smallest host tier and compact summary geometry for $count rows at $width px with a $gap px gap",
  async ({ width, gap, count }) => {
    expect(chromiumPath).not.toBeNull();
    const dir = await mkdtemp(join(tmpdir(), "bb-compact-chrome-"));
    try {
      const file = join(dir, "index.html");
      await writeFile(
        file,
        `<!doctype html><meta name="viewport" content="width=device-width"><style>
:root { --text-xs:0.75rem; --spacing:${spacing} }
${typographyCss}
@layer theme { :root { --text-2xs:0.625rem } }
body { margin:0; width:${width}px } button { box-sizing:border-box; border:0 }
header { display:flex; gap:4px; height:48px; align-items:center; position:relative; z-index:10 }
header button { width:36px; height:36px }
[data-compact-touch-summary] { display:flex; width:100%; padding:0; align-items:center; font-size:var(--text-xs) }
[data-compact-touch-height] { overflow-y:clip; overflow-x:visible }
[data-message-action-slot] button { width:44px; height:20px; padding:0 }
[data-compact-touch-height] > div { display:flow-root }
[data-timeline-items] { display:flex; flex-direction:column; gap:${gap}px }
${touchCss}
${panelCss}
</style><header><button data-compact-touch="header">Actions</button><button data-compact-touch="header" data-terminal-search-trigger aria-label="Search terminal output">Search</button><button data-compact-touch="header">Panel</button></header><div style="height:32px"></div>
<div data-compact-touch-height><div><div data-timeline-row-list="${gap === 0 ? "bundle" : gap === 4 ? "nested" : "top-level"}"><div data-timeline-items>
<div data-message-action-slot><button data-compact-touch="action" aria-label="Copy previous message">Copy</button></div>
${Array.from({ length: count }, (_, index) => `<div data-timeline-row-id="row-${index}"><div data-compact-touch-panel><div class="${panelClass}"><button data-compact-touch-summary aria-expanded="false" style="height:${index % 2 === 0 ? 20 : 23}px">Ran ${index + 1} command</button></div></div></div>`).join("")}
<div data-message-action-slot><button data-compact-touch="action" aria-label="Copy next message">Copy</button></div>
</div></div></div></div>
<pre id="result"></pre><script>
const panelPadding = parseFloat(getComputedStyle(document.querySelector('[data-compact-touch-panel] > div')).paddingTop);
const box = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,fontSize:getComputedStyle(el).fontSize} };
const probe = el => { const r = el.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
return [[x,y-21],[x,y+21],[x-21,y],[x+21,y]].map(([x,y]) => el.contains(document.elementFromPoint(x,y))); };
const summaries = [...document.querySelectorAll('[data-compact-touch-summary]')];
const search = document.querySelector('[aria-label="Search terminal output"]');
const boundaryHits = summaries.slice(0,-1).flatMap((el,index) => { const first = el.getBoundingClientRect(), second = summaries[index+1].getBoundingClientRect(); const midpoint = (first.bottom + second.top)/2, x=first.x+first.width/2; return [el.contains(document.elementFromPoint(x,midpoint-1)),summaries[index+1].contains(document.elementFromPoint(x,midpoint+1))]; });
const drawnHits = summaries.every(el => { const r = el.getBoundingClientRect(); return [r.top+1,r.bottom-1].every(y => el.contains(document.elementFromPoint(r.x+r.width/2,y))); });
const adjacentControls = [...document.querySelectorAll('[data-message-action-slot] button')].map((el,index) => {const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,index===0?r.bottom-1:r.top+1));});
document.querySelector('#result').textContent = JSON.stringify({panelPadding,smallestType:getComputedStyle(document.documentElement).getPropertyValue("--text-2xs"),drawnHits,adjacentControls,coarse:matchMedia('(pointer: coarse)').matches, boundaryHits, summaries:summaries.map(el => ({...box(el),hits:probe(el)})),search:{...box(search),hits:probe(search)}});
</script>`,
      );
      const { stdout } = await execFileAsync(
        chromiumPath!,
        [
          "--headless",
          `--user-data-dir=${join(dir, "profile")}`,
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-extensions",
          "--disable-background-networking",
          "--no-first-run",
          "--blink-settings=primaryPointerType=2,availablePointerTypes=2",
          `--window-size=${width},900`,
          "--dump-dom",
          `file://${file}`,
        ],
        { timeout: 30_000 },
      );
      const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
      expect(raw).toBeDefined();
      const target = z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        fontSize: z.string(),
        hits: z.array(z.boolean()),
      });
      const result = z
        .object({
          panelPadding: z.number(),
          smallestType: z.string(),
          drawnHits: z.boolean(),
          adjacentControls: z.array(z.boolean()),
          coarse: z.boolean(),
          boundaryHits: z.array(z.boolean()),
          summaries: z.array(target),
          search: target,
        })
        .parse(JSON.parse(raw!.replaceAll("&quot;", '"')));
      await writeFile(
        join(tmpdir(), `p36-chrome-af0afa41bfdb-${width}-${gap}-${count}.json`),
        JSON.stringify(result),
      );
      expect(result.coarse).toBe(true);
      expect(result.summaries).toHaveLength(count);
      expect(result.adjacentControls).toEqual([true, true]);
      expect(result.drawnHits).toBe(true);
      expect(result.smallestType.trim()).toBe("0.6875rem");
      for (const summary of result.summaries) {
        expect(summary.hits.filter(Boolean).length).toBeGreaterThanOrEqual(
          width < 480 ? 3 : 2,
        );
        expect(summary.fontSize).toBe(width < 480 ? "14px" : "12px");
        expect(summary.height).toBeGreaterThanOrEqual(20);
        expect(summary.height).toBeLessThanOrEqual(24);
      }
      if (width < 480) expect(result.boundaryHits.every(Boolean)).toBe(true);
      expect(result.summaries[1].y - result.summaries[0].y).toBe(
        20 + gap + 2 * result.panelPadding,
      );
      if (count > 2)
        expect(result.summaries[2].y - result.summaries[1].y).toBe(
          23 + gap + 2 * result.panelPadding,
        );
      expect(result.search.height).toBe(width < 480 ? 44 : 36);
      expect(result.search.width).toBe(width < 480 ? 44 : 36);
      expect(result.search.hits.every(Boolean)).toBe(width < 480);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  40_000,
);
