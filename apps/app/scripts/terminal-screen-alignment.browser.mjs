import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const cssPath = process.argv[2] ?? resolve(appRoot, "src/app.css");
const css = readFileSync(cssPath, "utf8")
  .match(/:where\(\[data-app-terminal\][^}]+\}/g)
  ?.join("\n");
assert.ok(css, "Terminal application CSS is required");
assert.ok(process.env.PLAYWRIGHT_CLI, "PLAYWRIGHT_CLI is required");
const playwrightRequire = createRequire(
  realpathSync(process.env.PLAYWRIGHT_CLI),
);
const { chromium } = playwrightRequire("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      [data-app-terminal] { position: absolute; left: 801px; top: 64px; width: 479px; }
      .xterm-scrollable-element { position: relative; }
    </style>
    <div data-app-terminal><div data-terminal-grid-cache-id="recorded-grid"></div></div>
  `);
  await page.addStyleTag({
    path: resolve(appRoot, "node_modules/@xterm/xterm/css/xterm.css"),
  });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({
    path: resolve(appRoot, "node_modules/@xterm/xterm/lib/xterm.js"),
  });
  const result = await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    const terminal = new window.Terminal({ cols: 80, rows: 24 });
    terminal.open(document.querySelector("[data-terminal-grid-cache-id]"));
    await frames();
    const screen = terminal.element.querySelector(".xterm-screen");
    const viewport = screen.parentElement;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%";
    screen.append(canvas);
    const shifts = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (
          entry.sources.some(
            (source) => source.node === screen || source.node === canvas,
          )
        )
          shifts.push({
            value: entry.value,
            sources: entry.sources.map((source) => source.node.tagName),
          });
      }
    });
    observer.observe({ type: "layout-shift", buffered: false });
    screen.style.width = "471px";
    screen.style.height = "456px";
    await frames();
    const read = () => {
      const rect = screen.getBoundingClientRect();
      return {
        left: rect.left,
        width: rect.width,
        layoutLeft: screen.offsetLeft,
        contentLeft: viewport.getBoundingClientRect().left,
        contentWidth: viewport.clientWidth,
      };
    };
    const overflow = read();
    shifts.length = 0;
    screen.style.width = "448px";
    screen.style.height = "722px";
    await frames();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fitted = read();
    observer.disconnect();
    terminal.dispose();
    return { overflow, fitted, shifts };
  });
  console.log(
    JSON.stringify({ browser: browser.version(), cssPath, ...result }),
  );
  assert.equal(
    result.overflow.contentLeft,
    809,
    "The content edge must include the 8px gutter",
  );
  assert.equal(
    result.overflow.left,
    result.overflow.contentLeft,
    "Overflow must stay at the content edge",
  );
  assert.equal(
    result.fitted.left,
    816.5,
    "The fitted screen must retain symmetric gutters",
  );
  assert.equal(
    result.fitted.layoutLeft,
    result.overflow.layoutLeft,
    "Fitting must not move the layout origin",
  );
  assert.deepEqual(
    result.shifts,
    [],
    "The recorded fit must not shift the screen or canvas",
  );
} finally {
  await browser.close();
}
