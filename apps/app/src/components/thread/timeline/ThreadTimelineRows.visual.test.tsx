// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { turnRow, commandRow } from "@/test/fixtures/thread-timeline-rows";
import {
  ThreadTimelineRows,
  PAST_ROW_DIM_CLASS_NAME,
} from "./ThreadTimelineRows";

vi.mock("@/components/thread/ThreadUsageSummary.js", () => ({
  ThreadTurnTokenSummary: () => <span>Token breakdown fixture</span>,
}));

afterEach(cleanup);

it("keeps token details inside the Worked for disclosure and preserves secondary status ink", () => {
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
  expect(screen.queryByText("Token breakdown fixture")).toBeNull();
  const label = screen.getByText("Worked for");
  expect(PAST_ROW_DIM_CLASS_NAME).toBe("text-muted-foreground");
  expect(label.className).toContain("text-muted-foreground");
  const chevron = label.closest("button")?.querySelector("svg:last-child");
  expect(chevron?.classList.contains("opacity-0")).toBe(false);
  expect(chevron?.classList.contains("text-muted-foreground")).toBe(true);
  fireEvent.click(label);
  expect(screen.getByText("Token breakdown fixture")).toBeTruthy();
  fireEvent.click(label);
  expect(
    screen.getByText("Token breakdown fixture").closest("[aria-hidden=true]"),
  ).toBeTruthy();
});
