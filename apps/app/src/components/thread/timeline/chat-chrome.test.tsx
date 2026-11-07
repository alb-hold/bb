// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

function compactStyles(
  path: string,
  media = "@media (width < 48rem) and (pointer: coarse)",
) {
  const css = readFileSync(path, "utf8");
  let result = "";
  let offset = 0;
  while ((offset = css.indexOf(media, offset)) !== -1) {
    const start = css.indexOf("{", offset);
    let depth = 1;
    let end = start + 1;
    while (depth && end < css.length) {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
      end++;
    }
    result += css.slice(start + 1, end - 1);
    offset = end;
  }
  return result;
}
afterEach(cleanup);

it("balances compact transcript spacing with visible controls and 44px effective targets", () => {
  const { container } = render(
    <>
      <style>
        {compactStyles("src/app.css") +
          compactStyles(
            "src/components/thread/timeline/message-action-bar.css",
          )}
      </style>
      <div data-message-action-slot="">
        <button data-compact-touch="action">Copy</button>
      </div>
      <div data-compact-touch-panel="">
        <div>
          <button data-compact-touch-summary="">Ran 1 command</button>
        </div>
      </div>
      <div data-code-actions="">
        <button data-compact-touch="code">Copy code</button>
      </div>
    </>,
  );
  for (const selector of [
    '[data-compact-touch="action"]',
    '[data-compact-touch="code"]',
    "[data-compact-touch-summary]",
  ]) {
    const style = getComputedStyle(container.querySelector(selector)!);
    expect(style.minHeight).toBe("36px");
    expect(style.minInlineSize).toBe("44px");
  }
  expect(
    getComputedStyle(container.querySelector("[data-message-action-slot]")!)
      .paddingBlock,
  ).toBe("4px");
  expect(
    getComputedStyle(
      container.querySelector("[data-compact-touch-panel] > div")!,
    ).paddingBlock,
  ).toBe("4px");
});

it("only hides the permission label inside a collapsed phone composer", () => {
  const { container } = render(
    <>
      <style>{compactStyles("src/app.css")}</style>
      {[true, false].map((collapsed) => (
        <form
          key={String(collapsed)}
          data-promptbox=""
          data-promptbox-collapsed={collapsed ? "" : undefined}
        >
          <button className="permission-mode-picker">
            <span data-permission-label="">Full Access</span>
          </button>
        </form>
      ))}
    </>,
  );
  const labels = container.querySelectorAll("[data-permission-label]");
  expect(getComputedStyle(labels[0]!).display).toBe("none");
  expect(getComputedStyle(labels[1]!).display).not.toBe("none");
  const trigger = container.querySelector("button")!;
  expect(getComputedStyle(trigger).minHeight).toBe("44px");
  expect(getComputedStyle(trigger).minWidth).toBe("44px");
});

it("lets the phone mode selector fit its labels without fixed width or edge margins", () => {
  const { container } = render(
    <>
      <style>{compactStyles("src/app.css", "@media (width < 48rem) {")}</style>
      <div data-execution-controls-layout="stacked">
        <div data-native-terminal-toggle="">Chat Terminal</div>
      </div>
    </>,
  );
  const style = getComputedStyle(
    container.querySelector("[data-native-terminal-toggle]")!,
  );
  expect(style.width).toBe("max-content");
  expect(style.marginInline).toBe("0px");
});
