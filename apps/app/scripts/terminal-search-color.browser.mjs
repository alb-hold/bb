import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import ts from "typescript";

const appRoot = resolve(import.meta.dirname, "..");
const colorModulePath = resolve(
  appRoot,
  "src/components/thread/terminal/terminal-search-color.ts",
);
const themePath = resolve(appRoot, "src/components/ui/theme.css");
const source = await readFile(colorModulePath, "utf8");
const themeCss = await readFile(themePath, "utf8");
const browserThemeCss = themeCss.replace(/^@import[^;]*;\s*/gm, "");
const colorModule = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpile(source, { module: ts.ModuleKind.ESNext }),
  ).toString("base64")}`
);
const cssColorToHexSource = colorModule.cssColorToHex.toString();
const playwrightBin = process.env.PLAYWRIGHT_CLI
  ? realpathSync(process.env.PLAYWRIGHT_CLI)
  : process.env.PATH.split(":")
      .map((directory) => resolve(directory, "playwright"))
      .find((candidate) => {
        try {
          realpathSync(candidate);
          return true;
        } catch {
          return false;
        }
      });

if (!playwrightBin) {
  throw new Error("Playwright is unavailable; invoke through npx --package=playwright");
}

const playwrightRequire = createRequire(realpathSync(playwrightBin));
const { chromium, webkit } = playwrightRequire("playwright");
const oldRegexParser = (value) => {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [212, 167, 44];
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
};
const oldRegexMutant = process.argv.includes("--old-regex-mutant");
const converterName = oldRegexMutant ? "old regex mutant" : "cssColorToHex";
const converterSource = oldRegexMutant
  ? oldRegexParser.toString()
  : cssColorToHexSource;

async function verifyBrowser(browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
    await page.setContent('<html><body><div id="swatch"></div></body></html>');
    await page.addStyleTag({ content: browserThemeCss });
    console.log(`${browserType.name()} ${browser.version()}`);

    for (const theme of ["light", "dark"]) {
      await page.locator("body").evaluate((body, mode) => {
        body.className = mode === "dark" ? "dark" : "light";
      }, theme);

      for (const token of [
        "--sidebar-search-match",
        "--sidebar-search-match-border",
      ]) {
        const converted = await page.evaluate(
          ({ tokenName, converterSource }) => {
            const swatch = document.querySelector("#swatch");
            swatch.style.cssText =
              "position:fixed;left:0;top:0;width:2px;height:2px;border:0";
            swatch.style.backgroundColor = `var(${tokenName})`;
            const computedColor = getComputedStyle(swatch).backgroundColor;
            const converter = new Function(`return (${converterSource})`)();
            return {
              computedColor,
              converted: converter(computedColor),
            };
          },
          { tokenName: token, converterSource },
        );
        const png = await page.locator("#swatch").screenshot();
        const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const [red, green, blue] = data;
        const expected = `#${[red, green, blue]
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("")}`;
        const channels = [red, green, blue];
        const oldValue = oldRegexParser(converted.computedColor);

        if (!/^#[\da-f]{6}$/i.test(converted.converted)) {
          throw new Error(`${theme} ${token}: invalid result ${converted.converted}`);
        }
        if (converted.converted.toLowerCase() !== expected) {
          throw new Error(
            `${theme} ${token}: ${converterName} ${converted.converted}, painted pixel ${expected}, computed ${converted.computedColor}`,
          );
        }
        if (Math.max(...channels) < 40 || Math.min(...channels) > 245) {
          throw new Error(`${theme} ${token}: painted color is near black or white: ${expected}`);
        }
        if (oldValue.toLowerCase() === expected) {
          throw new Error(`${theme} ${token}: old regex parser unexpectedly returned ${expected}`);
        }
        console.log(
          `PASS ${theme} ${token}: ${converted.computedColor} => ${converted.converted}; pixel ${expected}; old regex ${oldValue}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}

await verifyBrowser(chromium);
await verifyBrowser(webkit);
