// @vitest-environment jsdom

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import type {} from "../../../../vitest.global-setup";
import appCss from "../../../app.css?inline";
import { TerminalMobileControls } from "./TerminalMobileControls";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("terminalControlsChromiumPath");
const keySchema = z.object({
  label: z.string(),
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fontSize: z.string(),
  scrollWidth: z.number(),
  clientWidth: z.number(),
  ellipsis: z.boolean(),
  chevron: z.boolean(),
});
const stateSchema = z.object({
  viewportWidth: z.number(),
  controlsWidth: z.number(),
  topPadding: z.number(),
  dividerGap: z.number(),
  scrollWidth: z.number(),
  clientWidth: z.number(),
  row: z.array(keySchema),
  menu: z.array(keySchema),
});
const fullKeySet = [
  "Interrupt (Control C)",
  "Escape",
  "Tab",
  "Enter",
  "Arrow up",
  "Arrow down",
  "More terminal keys",
  "Search terminal output",
  "Control for next key",
  "Arrow left",
  "Arrow right",
  "Previous prompt",
  "Next prompt",
  "Shift Tab",
  "Function key F2",
  "End of input (Control D)",
  "Page up",
  "Page down",
  "Home",
  "End",
  "Paste",
  "Select terminal text",
  "Show or hide keyboard",
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.skipIf(chromiumPath === null && !process.env.CI)(
  "TerminalMobileControls in real Chromium",
  () => {
    it.each([288, 320, 344, 360, 375, 390])(
      "fits uniform touch keys and preserves every menu key at %i px",
      async (width) => {
        expect(chromiumPath).not.toBeNull();
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
          width,
        );
        const { container, getByRole } = render(
          <TerminalMobileControls
            className="py-0"
            controlActive={false}
            disabled={false}
            onArrow={vi.fn()}
            onControlChange={vi.fn()}
            onInput={vi.fn()}
            onKeyboardToggle={vi.fn()}
            onPaste={vi.fn()}
            onPreviousPrompt={vi.fn()}
            onNextPrompt={vi.fn()}
            onSearch={vi.fn()}
            onSelectText={vi.fn()}
          />,
        );
        const closed = container.innerHTML;
        fireEvent.click(getByRole("button", { name: "More terminal keys" }));
        const expanded = container.innerHTML;
        const dir = await mkdtemp(join(tmpdir(), "bb-terminal-key-layout-"));
        try {
          const css = appCss.replace(
            /url\((["']?)(\/[^)"']+)\1\)/g,
            (_match, _quote: string, asset: string) =>
              `url("${pathToFileURL(asset.startsWith("/@fs/") ? asset.slice(4) : resolve(process.cwd(), `.${asset}`))}")`,
          );
          const file = join(dir, "index.html");
          const frame = (markup: string) =>
            `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style>${markup}`
              .replaceAll("&", "&amp;")
              .replaceAll('"', "&quot;")
              .replaceAll("<", "&lt;");
          await writeFile(
            file,
            `<!doctype html><meta charset="utf-8"><style>body { margin:0 } iframe { display:block; border:0; width:${width}px; height:400px }</style><iframe id="closed" srcdoc="${frame(closed)}"></iframe><iframe id="expanded" srcdoc="${frame(expanded)}"></iframe><pre id="result"></pre><script>
const frames = [...document.querySelectorAll('iframe')];
Promise.all(frames.map(async frame => {
  if (frame.contentDocument.readyState !== 'complete' || !frame.contentDocument.querySelector('[data-terminal-mobile-controls]')) await new Promise(resolve => frame.addEventListener('load', resolve, {once:true}));
  await frame.contentDocument.fonts.ready;
})).then(() => {
  const key = el => {
    const r = el.getBoundingClientRect();
    return {label:el.getAttribute('aria-label'),text:el.textContent,x:r.x,y:r.y,width:r.width,height:r.height,fontSize:getComputedStyle(el).fontSize,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,ellipsis:!!el.querySelector('[data-icon="MoreHorizontal"]'),chevron:!!el.querySelector('[data-icon="ChevronDown"], [data-icon="ChevronUp"]')};
  };
  const state = id => {
    const frame = document.querySelector('#'+id);
    const controls = frame.contentDocument.querySelector('[data-terminal-mobile-controls]');
    const row = controls.lastElementChild;
    const buttons = [...row.querySelectorAll('button')];
    return {viewportWidth:frame.contentWindow.innerWidth,controlsWidth:controls.getBoundingClientRect().width,topPadding:parseFloat(getComputedStyle(row).paddingTop),dividerGap:buttons[0].getBoundingClientRect().top-controls.getBoundingClientRect().top-parseFloat(getComputedStyle(controls).borderTopWidth),scrollWidth:row.scrollWidth,clientWidth:row.clientWidth,row:buttons.map(key),menu:[...controls.querySelectorAll('button')].filter(el=>!row.contains(el)).map(key)};
  };
  document.querySelector('#result').textContent=JSON.stringify({coarse:matchMedia('(pointer: coarse)').matches,closed:state('closed'),expanded:state('expanded')});
});
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
              "--virtual-time-budget=5000",
              "--dump-dom",
              pathToFileURL(file).href,
            ],
            { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          );
          const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
          expect(raw).toBeDefined();
          const result = z
            .object({
              coarse: z.boolean(),
              closed: stateSchema,
              expanded: stateSchema,
            })
            .parse(JSON.parse(raw!.replaceAll("&quot;", '"').replaceAll("&amp;", "&")));
          console.log("C28_LAYOUT " + JSON.stringify({ width, ...result }));
          expect(result.coarse).toBe(true);
          expect(result.closed.viewportWidth).toBe(width);
          expect(result.expanded.viewportWidth).toBe(width);
          expect(result.closed.controlsWidth).toBe(width);
          expect(result.closed.dividerGap).toBeCloseTo(6, 1);
          expect(result.closed.topPadding).toBeCloseTo(6, 1);
          expect(result.closed.row.at(-1)?.label).toBe("More terminal keys");
          const allKeys = [...result.expanded.row, ...result.expanded.menu];
          expect(allKeys.find((key) => key.label === "Enter")?.text).toBe(
            "Enter",
          );
          expect(allKeys.map((key) => key.label).sort()).toEqual(
            [...fullKeySet].sort(),
          );
          for (const state of [result.closed, result.expanded]) {
            expect(state.scrollWidth).toBe(state.clientWidth);
            for (const [index, key] of state.row.entries()) {
              expect(key.y).toBe(state.row[0]?.y);
              expect(key.x).toBeGreaterThanOrEqual(0);
              expect(key.x + key.width).toBeLessThanOrEqual(
                state.controlsWidth,
              );
              const previous = state.row[index - 1];
              if (previous) {
                expect(key.x).toBeGreaterThanOrEqual(
                  previous.x + previous.width,
                );
              }
            }
            const keys = [...state.row, ...state.menu];
            expect(new Set(keys.map((key) => key.fontSize))).toEqual(
              new Set(["14px"]),
            );
            for (const key of keys) {
              expect(key.width, key.label).toBeGreaterThanOrEqual(44);
              expect(key.height, key.label).toBeGreaterThanOrEqual(44);
              expect(key.scrollWidth, key.label).toBeLessThanOrEqual(
                key.clientWidth,
              );
            }
            const more = state.row.find(
              (key) => key.label === "More terminal keys",
            );
            expect(more?.text).toBe("Keys");
            expect(more?.ellipsis).toBe(true);
            expect(more?.chevron).toBe(true);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      40_000,
    );
  },
);
