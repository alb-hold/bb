import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [baselineHome, candidateHome, chatPath, terminalPath, output] = process.argv.slice(2);
if (!output) throw new Error("Usage: node p36-readonly-capture.mjs <baseline-home-url> <candidate-home-url> <chat-path> <terminal-path> <output-dir>");
const homes = [baselineHome, candidateHome].map(value => new URL(value));
for (const url of homes) {
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || ["24706", "16815"].includes(url.port)) throw new Error("Use dedicated seeded localhost servers, never the live bb server");
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "/Users/alexandrebrandizzi/ai-infra/deploy-tutano/node_modules/playwright/index.mjs");
const dir = resolve(output);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch();
const measurements = {};
try {
  for (const [arm, home] of [["before", homes[0]], ["after", homes[1]]]) {
    for (const width of [1280, 390, 360]) {
      const context = await browser.newContext({ viewport: { width, height: width === 1280 ? 800 : 844 }, hasTouch: width < 480, isMobile: width < 480, colorScheme: "dark" });
      const page = await context.newPage();
      try {
        for (const [surface, path] of [["home", home.pathname], ["chat", chatPath], ["terminal", terminalPath]]) {
          const url = new URL(path, home);
          if (url.origin !== home.origin) throw new Error("Paths must stay on the seeded server");
          await page.goto(url.href, { waitUntil: "networkidle" });
          const key = `${arm}-${surface}-${width}`;
          measurements[key] = await page.evaluate(() => {
            const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
            const probe = el => {
              const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
              return [[x, y - 21], [x, y + 21], [x - 21, y], [x + 21, y]].map(([x, y]) => {
                const hit = document.elementFromPoint(x, y);
                return { x, y, hit: el.contains(hit), target: hit?.closest("button,a")?.getAttribute("aria-label") ?? hit?.textContent?.slice(0, 70) };
              });
            };
            return {
              rows: [...document.querySelectorAll("[data-sidebar-rename-row]")].filter(visible).map(el => ({ id: el.querySelector("[data-sidebar-thread-id]")?.getAttribute("data-sidebar-thread-id"), ...box(el) })),
              summaries: [...document.querySelectorAll("button[data-compact-touch-summary]")].filter(visible).map(el => ({ text: el.textContent, ...box(el), probes: probe(el) })),
              search: [...document.querySelectorAll('header button[aria-label="Search terminal output"]')].filter(visible).map(el => ({ ...box(el), probes: probe(el) })),
              messages: [...document.querySelectorAll("[data-touch-actions-visible]")].map(el => ({ visible: el.getAttribute("data-touch-actions-visible"), actionSlotVisible: [...el.querySelectorAll("[data-message-action-slot]")].some(visible) })),
              unlabeledChrome: [...document.querySelectorAll('[data-testid="app-nav-rail"] button,[data-sidebar="footer"] button,[data-sidebar="footer"] a')].filter(visible).filter(el => !el.getAttribute("aria-label") && !el.textContent?.trim()).map(el => el.outerHTML),
              smallestType: getComputedStyle(document.documentElement).getPropertyValue("--text-2xs"),
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          await page.screenshot({ path: resolve(dir, `${key}.png`), fullPage: true });
        }
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
const before = measurements["before-home-1280"].rows;
const after = measurements["after-home-1280"].rows;
measurements.sidebarRowDelta = before.map(row => ({ id: row.id, before: row.height, after: after.find(candidate => candidate.id === row.id)?.height ?? null })).map(row => ({ ...row, delta: row.after === null ? null : row.after - row.before }));
await writeFile(resolve(dir, "measurements.json"), JSON.stringify(measurements, null, 2));
console.log(JSON.stringify(measurements.sidebarRowDelta, null, 2));
