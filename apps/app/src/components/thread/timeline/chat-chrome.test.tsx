// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import {
  conversationRow,
  commandRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { MessageActionBar } from "./MessageActionBar";
import { ExpandablePanel } from "../../ui/disclosure";
import { MarkdownPreview } from "../../ui/markdown-preview";

function compactStyles(
  path: string,
  media = path.endsWith("message-action-bar.css") ? "@media (pointer: coarse)" : "@media (width < 48rem) and (pointer: coarse)",
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  [true, true, "4px"],
  [true, false, "8px"],
  [false, true, "8px"],
])(
  "renders and measures the same timeline gap with compact=%s coarse=%s",
  (compact, coarse, gap) => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches:
        (compact && query === COMPACT_VIEWPORT_QUERY) ||
        (coarse && query === POINTER_COARSE_QUERY),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTimelineRows
            timelineRows={[
              conversationRow({
                id: "request",
                role: "user",
                text: "Please keep the public API unchanged.",
              }),
              commandRow({ id: "command", command: "pwd" }),
            ]}
            threadRuntimeDisplayStatus="idle"
            threadIsActive={false}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const items = container.querySelector<HTMLElement>(
      '[data-timeline-row-list="top-level"] > [data-timeline-items]',
    )!;
    expect(items.style.gap).toBe(gap);
  },
);

it.each([false, true])(
  "collapses hidden action-slot whitespace while retaining footer content: %s",
  (footer) => {
    const { container } = render(
      <>
        <style>
          {compactStyles(
            "src/components/thread/timeline/message-action-bar.css",
          )}
        </style>
        <div data-touch-actions-visible="false">
          <MessageActionBar
            timestamp={0}
            messageText="Request"
            alignment="end"
            mobileActionDisplay="inline"
            footerAdornment={
              footer ? <span data-testid="usage">108.7K tokens</span> : null
            }
          />
        </div>
      </>,
    );
    const slot = container.querySelector<HTMLElement>(
      "[data-message-action-slot]",
    )!;
    expect(getComputedStyle(slot).minHeight).toBe("0px");
    expect(getComputedStyle(slot).display).not.toBe("none");
    if (footer)
      expect(
        screen.getByTestId("usage").closest("[data-message-action-slot]"),
      ).toBe(slot);
    screen.getByRole("button", { name: "Copy message" }).focus();
    expect(
      slot.closest("[data-touch-actions-visible]")!.matches(":focus-within"),
    ).toBe(true);
    slot.setAttribute("data-message-action-slot", "");
    expect(
      getComputedStyle(slot.querySelector("[data-message-action-row]")!)
        .position,
    ).not.toBe("absolute");
    expect(
      getComputedStyle(screen.getByRole("button", { name: "Copy message" }))
        .minHeight,
    ).toBe("44px");
  },
);

it.each([true, false])(
  "sizes real chat controls with phone coarse styles enabled: %s",
  (coarse) => {
    render(
      <>
        {coarse ? (
          <style>
            {compactStyles("src/app.css") +
              compactStyles(
                "src/components/thread/timeline/message-action-bar.css",
              )}
          </style>
        ) : null}
        <MessageActionBar
          timestamp={0}
          messageText="Answer"
          alignment="start"
          mobileActionDisplay="inline"
          pluginActions={[
            {
              key: "reply",
              label: "Reply in side chat",
              pluginId: null,
              icon: "Reply",
              onSelect: () => {},
            },
          ]}
        />
        <MarkdownPreview content={"```sh\npwd\n```"} />
        {[
          "Ran 1 command",
          "Ran 1 tool",
          "Worked for 18m 1s · 108.7K tokens",
        ].map((summary) => (
          <ExpandablePanel
            key={summary}
            isExpanded={false}
            summaryContent={summary}
            headerToneClass="text-muted-foreground"
            onToggle={() => {}}
          >
            Output
          </ExpandablePanel>
        ))}
      </>,
    );
    for (const name of [
      "Copy message",
      "Message actions",
      "Reply in side chat",
      "Copy code",
      "Wrap lines",
      "Ran 1 command",
      "Ran 1 tool",
      "Worked for 18m 1s · 108.7K tokens",
    ]) {
      const button = screen.getByRole("button", { name });
      const style = getComputedStyle(button);
      if (coarse) {
        expect(style.minHeight, name).toBe("44px");
        expect(style.minInlineSize, name).toBe("44px");
      } else {
        expect(style.minHeight, name).not.toBe("44px");
        expect(style.minInlineSize, name).not.toBe("44px");
      }
    }
    expect(
      screen
        .getByRole("button", { name: "Message actions" })
        .classList.contains("size-5"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Wrap lines" })
        .classList.contains("size-5"),
    ).toBe(true);
  },
);

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
    expect(style.minHeight).toBe("44px");
    expect(style.minInlineSize).toBe("44px");
  }
  expect(
    getComputedStyle(container.querySelector("[data-message-action-slot]")!)
      .paddingBlock,
  ).toBe("0px");
  expect(
    getComputedStyle(
      container.querySelector("[data-compact-touch-panel] > div")!,
    ).paddingBlock,
  ).toBe("0px");
});

it("uses a 4px phone block gap and keeps animated disclosure hit areas in flow", () => {
  const { container } = render(
    <>
      <style>
        {compactStyles("src/app.css") +
          compactStyles(
            "src/components/thread/timeline/message-action-bar.css",
          )}
      </style>
      <div data-timeline-row-list="top-level">
        <div data-timeline-items="" />
      </div>
      <div data-compact-touch-height="">
        <div>
          <button data-compact-touch-summary="">Ran 1 tool</button>
        </div>
      </div>
    </>,
  );
  expect(
    getComputedStyle(container.querySelector("[data-timeline-items]")!).rowGap,
  ).toBe("4px");
  expect(
    getComputedStyle(container.querySelector("[data-compact-touch-height]")!)
      .marginBlock,
  ).toBe("0px");
  expect(
    getComputedStyle(
      container.querySelector("[data-compact-touch-height] > div")!,
    ).paddingBlock,
  ).toBe("0px");
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
