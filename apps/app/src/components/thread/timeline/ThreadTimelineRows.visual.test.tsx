// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  turnRow,
  commandRow,
  toolRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  ThreadTimelineRows,
  PAST_ROW_DIM_CLASS_NAME,
} from "./ThreadTimelineRows";

vi.mock("@/components/thread/ThreadUsageSummary.js", () => ({
  ThreadTurnTokenSummary: () => <span>Token breakdown fixture</span>,
}));

afterEach(cleanup);

it("tightens disclosure margins within a turn without changing user or turn boundaries", () => {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTimelineRows
          timelineRows={[
            conversationRow({
              id: "spacing-user",
              role: "user",
              text: "Run the checks",
              turnId: "spacing-turn",
              seq: 1,
            }),
            conversationRow({
              id: "spacing-code",
              role: "assistant",
              text: "```sh\nPASS routes.test.ts\nnext line\n```",
              turnId: "spacing-turn",
              seq: 2,
            }),
            commandRow({
              id: "spacing-command",
              command: "pnpm test",
              turnId: "spacing-turn",
              seq: 3,
            }),
            toolRow({
              id: "spacing-tool",
              toolName: "Read",
              turnId: "spacing-turn",
              seq: 4,
            }),
            turnRow({
              id: "spacing-worked",
              turnId: "spacing-turn",
              status: "completed",
              seq: 5,
            }),
            conversationRow({
              id: "spacing-next-user",
              role: "user",
              text: "Continue",
              turnId: "spacing-next-turn",
              seq: 6,
            }),
            conversationRow({
              id: "spacing-next-answer",
              role: "assistant",
              text: "Continuing",
              turnId: "spacing-next-turn",
              seq: 7,
            }),
          ]}
          threadRuntimeDisplayStatus="idle"
          threadIsActive={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(
    resolve("src/components/thread/timeline/timeline-row-spacing.css"),
    "utf8",
  );
  document.head.append(stylesheet);
  try {
    const margin = (id: string) => {
      const row = container.querySelector<HTMLElement>(
        `[data-timeline-window-key="${id}"]`,
      );
      expect(row).not.toBeNull();
      expect(row!.style.marginTop).toBe("");
      return getComputedStyle(row!).marginTop;
    };
    expect(margin("spacing-code")).toBe("0.5rem");
    expect(margin("spacing-command")).toBe("0.25rem");
    expect(margin("spacing-tool")).toBe("0.125rem");
    expect(margin("spacing-worked")).toBe("0.25rem");
    expect(margin("spacing-next-user")).toBe("1rem");
    const px = (value: string) => Number.parseFloat(value) * 16;
    expect(px(margin("spacing-next-user"))).toBeGreaterThanOrEqual(
      px(margin("spacing-command")) * 3,
    );
    expect(margin("spacing-next-answer")).toBe("0.5rem");
  } finally {
    stylesheet.remove();
  }
});

it("shows turn spend on the collapsed Worked for row in secondary status ink", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTimelineRows
          timelineRows={[
            turnRow({
              id: "visual-turn",
              status: "completed",
              durationMs: 1000,
              children: [commandRow({ command: "pwd" })],
            }),
          ]}
          threadRuntimeDisplayStatus="idle"
          threadIsActive={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    (await screen.findByText("Token breakdown fixture")).closest("[aria-hidden=true]"),
  ).toBeNull();
  const label = screen.getByText("Worked for");
  expect(
    label
      .closest("button")
      ?.contains(screen.getByText("Token breakdown fixture")),
  ).toBe(true);
  expect(PAST_ROW_DIM_CLASS_NAME).toBe("text-muted-foreground");
  expect(label.className).toContain("text-muted-foreground");
  const chevron = label.closest("button")?.querySelector("svg:last-child");
  expect(chevron?.classList.contains("opacity-0")).toBe(false);
  expect(chevron?.classList.contains("text-muted-foreground")).toBe(true);
});

it("separates the worked duration and token count visually and for assistive readers", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTimelineRows
          timelineRows={[
            turnRow({
              id: "separator-turn",
              status: "completed",
              durationMs: 1000,
              children: [commandRow({ command: "pwd" })],
            }),
          ]}
          threadRuntimeDisplayStatus="idle"
          threadIsActive={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const button = screen.getByText("Worked for").closest("button")!;
  expect(button.querySelector("[data-token-separator]")?.textContent).toBe("·");
  expect(
    button.querySelector("[data-token-separator]")?.getAttribute("aria-hidden"),
  ).toBe("true");
  await screen.findByText("Token breakdown fixture");
  expect(button.textContent).toMatch(/1s · Token breakdown fixture/);
  expect(
    screen.getByRole("button", { name: /1s Token breakdown fixture/ }),
  ).toBe(button);
});
