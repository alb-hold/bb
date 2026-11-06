import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [candidateUrl, baselineUrl] = process.argv.slice(2);
if (!candidateUrl) throw new Error('Usage: node scripts/p35-phone-measure.mjs <seeded-thread-url> [baseline-thread-url]');
for (const value of [candidateUrl, baselineUrl].filter(Boolean)) {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use the seeded localhost server');
}
const output = process.env.P35_OUTPUT ?? '/tmp/p35-phone-measure';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [revision, url] of [['baseline', baselineUrl], ['candidate', candidateUrl]]) {
    if (!url) continue;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const resizes = [];
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type === 'resize') resizes.push({ at: Date.now(), url: socket.url(), ...message });
      } catch {}
    }));
    const navigationStarted = Date.now();
    await page.goto(url);
    await page.locator('[data-native-terminal-prompt], [data-native-terminal-toggle]').first().waitFor();
    for (const width of [390, 360, 320]) {
      const resizeStart = resizes.length;
      await page.setViewportSize({ width, height: 844 });
      const resolutionStarted = Date.now();
      let modelResolved = false;
      let modelPresent = false;
      do {
        const modelState = await page.evaluate(() => {
          const trigger = document.querySelector('[data-model-reasoning-trigger]');
          const model = trigger?.querySelector('[data-model-name], :scope > span > span.truncate');
          const text = model?.textContent?.trim() ?? '';
          return { present: trigger !== null, resolved: text.length > 0 && !['Model', 'Select model', 'Loading…'].includes(text) && !trigger?.hasAttribute('data-model-loading') };
        });
        modelPresent = modelState.present;
        modelResolved = modelState.resolved;
        if (!modelPresent || modelResolved) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() - resolutionStarted < 15_000);
      const modelWaitMs = Date.now() - resolutionStarted;
      const modelResolvedAfterNavigationMs = modelResolved ? Date.now() - navigationStarted : null;
      const samples = [];
      for (let index = 0; index < 12; index++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        samples.push(await page.evaluate(() => {
          const box = selector => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          };
          const model = document.querySelector('[data-model-name]') ?? document.querySelector('[data-model-reasoning-trigger] > span > span.truncate');
          let visibleModel = null;
          if (model) {
            const style = getComputedStyle(model);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const text = model.textContent ?? '';
            let length = text.length;
            if (model.scrollWidth > model.clientWidth) {
              while (length > 0 && ctx.measureText(text.slice(0, length) + '…').width > model.clientWidth) length--;
              visibleModel = text.slice(0, length) + '…';
            } else visibleModel = text;
          }
          const renderer = document.querySelector('[data-terminal-renderer]');
          const labels = [...document.querySelectorAll('[data-native-terminal-toggle] button span')].map(node => ({
            text: node.textContent, visible: getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0,
          }));
          return {
            composer: box('[data-native-terminal-prompt]'), input: box('[data-native-terminal-prompt] textarea'),
            actions: box('[data-native-composer-actions]'), terminal: box('[data-terminal-renderer]'),
            grid: renderer ? { ...renderer.dataset } : null, visibleModel, modelText: model?.textContent ?? null, modelHtml: model?.outerHTML ?? null, labels,
            overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            controls: [...document.querySelectorAll('[data-native-composer-actions] > button')].map(node => ({ label: node.getAttribute('aria-label'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
          };
        }));
      }
      const result = { revision, url, width, modelPresent, modelResolved, modelWaitMs, modelResolvedAfterNavigationMs, samples, resizes: resizes.slice(resizeStart) };
      results.push(result);
      await page.screenshot({ path: path.join(output, `${revision}-${width}.png`), fullPage: true });
      console.log(JSON.stringify(result));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
