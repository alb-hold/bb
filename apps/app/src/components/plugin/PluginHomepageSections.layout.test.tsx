// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, inject, it } from "vitest";
import type {} from "../../../vitest.global-setup";
import appCss from "../../app.css?inline";
import { MemoryRouter } from "react-router-dom";
import { resetPluginSlotStoreForTest, setPluginSlotRegistrations } from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { RootComposeHome } from "@/views/RootComposeHome";
import { PluginHomepageSections } from "./PluginHomepageSections";

const execFileAsync = promisify(execFile);
const chromiumPath = inject("appChromiumPath");

function resolveAssetUrls(css: string): string {
  return css.replace(
    /url\((["']?)(\/[^)"']+)\1\)/g,
    (_m, _q: string, asset: string) =>
      `url("${pathToFileURL(asset.startsWith("/@fs/") ? asset.slice(4) : resolve(process.cwd(), `.${asset}`))}")`,
  );
}

async function runChromiumMeasure<T>(html: string, prefix: string): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    const file = join(dir, "index.html");
    await writeFile(file, html);
    const { stdout, stderr } = await execFileAsync(
      chromiumPath!,
      [
        "--headless",
        "--window-size=1440,900",
        `--user-data-dir=${join(dir, "profile")}`,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--allow-file-access-from-files",
        "--virtual-time-budget=3000",
        "--dump-dom",
        pathToFileURL(file).href,
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
    expect(
      raw,
      `stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`,
    ).toBeDefined();
    return JSON.parse(
      raw!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    ) as T;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

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
  const result = await runChromiumMeasure<
    Array<{
      display: string;
      width: number;
      height: number;
      headingVisible: boolean;
      text: string;
    }>
  >(
    `<!doctype html><meta charset="utf-8"><style>${resolveAssetUrls(appCss)}</style>${container.innerHTML}<pre id="result"></pre><script>
const sections=[...document.querySelectorAll('[data-testid="plugin-homepage-sections"] > section')];
document.querySelector('#result').textContent=JSON.stringify(sections.map(s=>{const r=s.getBoundingClientRect(),h=s.querySelector('h2'),hr=h.getBoundingClientRect();return {display:getComputedStyle(s).display,width:r.width,height:r.height,headingVisible:!!(hr.width&&hr.height&&getComputedStyle(h).visibility!=="hidden"),text:s.textContent}}));
</script>`,
    "bb-homepage-sections-",
  );
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ display: "none", width: 0, height: 0, headingVisible: false });
  expect(result[1].display).not.toBe("none");
  expect(result[1].width).toBeGreaterThan(0);
  expect(result[1].height).toBeGreaterThan(0);
  expect(result[1].headingVisible).toBe(true);
  expect(result[1].text).toContain("populated section body");
}, 40000);

it("keeps the desktop composer anchored when plugin homepage sections mount late in Chromium", async () => {
  function EmptySection() {
    return null;
  }
  function ResumeSessionSection() {
    return <div style={{ height: 220 }}>Resume session body</div>;
  }
  function FleetSection() {
    return <div style={{ height: 260 }}>Fleet body</div>;
  }

  const { container } = render(
    <MemoryRouter initialEntries={["/"]}>
      <RootComposeHome
        isCompact={false}
        wideContentClassName="pt-14"
        composer={<div data-testid="composer-probe" style={{ height: 180 }}>Composer</div>}
        compactScrollContent={
          <div data-testid="recents-probe" style={{ height: 190 }}>Recents</div>
        }
        homepageSections={<PluginHomepageSections />}
      />
    </MemoryRouter>,
  );

  const beforeHtml = container.innerHTML;

  act(() => {
    setPluginSlotRegistrations(
      "resume-session",
      makePluginRegistrationSet({
        homepageSections: [
          { id: "resume", title: "Resume session", component: EmptySection },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "fleet",
      makePluginRegistrationSet({
        homepageSections: [
          { id: "fleet", title: "Fleet", component: EmptySection },
        ],
      }),
    );
  });

  const emptySectionsHtml = container.innerHTML;

  act(() => {
    setPluginSlotRegistrations(
      "resume-session",
      makePluginRegistrationSet({
        homepageSections: [
          { id: "resume", title: "Resume session", component: ResumeSessionSection },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "fleet",
      makePluginRegistrationSet({
        homepageSections: [
          { id: "fleet", title: "Fleet", component: FleetSection },
        ],
      }),
    );
  });

  const afterHtml = container.innerHTML;
  const payloads = JSON.stringify({ beforeHtml, emptySectionsHtml, afterHtml }).replaceAll(
    "</",
    "<\\/",
  );

  const result = await runChromiumMeasure<{
    beforeTop: number;
    emptyTop: number;
    afterTop: number;
    afterComposerBottom: number;
    afterRecentsBottom: number;
    afterSectionsTop: number;
    afterSectionsBottom: number;
    afterScrollHeight: number;
    afterClientHeight: number;
    shortViewportComposerTop: number;
    shortViewportScrollHeight: number;
  }>(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:900px;overflow:hidden;}${resolveAssetUrls(appCss)}</style><div id="stage" class="relative flex flex-col overflow-hidden" style="width:1440px;height:900px"></div><pre id="result"></pre><script>
const payloads = ${payloads};
const stage = document.getElementById("stage");
function measure(html) {
  stage.innerHTML = html;
  const composer = stage.querySelector('[data-testid="root-compose-compact-composer"]');
  const recents = stage.querySelector('[data-testid="root-compose-desktop-recents"]');
  const sections = stage.querySelector('[data-testid="plugin-homepage-sections"]');
  const scroller = stage.querySelector('.overflow-y-auto');
  const cr = composer.getBoundingClientRect();
  const rr = recents.getBoundingClientRect();
  const sr = sections ? sections.getBoundingClientRect() : null;
  return {
    composerTop: Math.round(cr.top * 100) / 100,
    composerBottom: Math.round(cr.bottom * 100) / 100,
    recentsBottom: Math.round(rr.bottom * 100) / 100,
    sectionsTop: sr ? Math.round(sr.top * 100) / 100 : null,
    sectionsBottom: sr ? Math.round(sr.bottom * 100) / 100 : null,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  };
}
const before = measure(payloads.beforeHtml);
const empty = measure(payloads.emptySectionsHtml);
const after = measure(payloads.afterHtml);
stage.style.height = "400px";
const shortViewport = measure(payloads.afterHtml);
document.querySelector('#result').textContent = JSON.stringify({
  beforeTop: before.composerTop,
  emptyTop: empty.composerTop,
  afterTop: after.composerTop,
  afterComposerBottom: after.composerBottom,
  afterRecentsBottom: after.recentsBottom,
  afterSectionsTop: after.sectionsTop,
  afterSectionsBottom: after.sectionsBottom,
  afterScrollHeight: after.scrollHeight,
  afterClientHeight: after.clientHeight,
  shortViewportComposerTop: shortViewport.composerTop,
  shortViewportScrollHeight: shortViewport.scrollHeight,
});
</script>`,
    "bb-home-late-sections-cls-",
  );

  expect(result.beforeTop).toBeGreaterThan(56);
  expect({ emptyTop: result.emptyTop, afterTop: result.afterTop }).toEqual({
    emptyTop: result.beforeTop,
    afterTop: result.beforeTop,
  });
  expect(result.afterSectionsTop).toBeGreaterThanOrEqual(result.afterRecentsBottom);
  expect(result.afterSectionsBottom).toBeGreaterThan(result.afterSectionsTop);
  expect(result.afterScrollHeight).toBeGreaterThan(result.afterClientHeight);
  expect(result.shortViewportComposerTop).toBeGreaterThanOrEqual(0);
  expect(result.shortViewportScrollHeight).toBeGreaterThan(400);
}, 40000);
