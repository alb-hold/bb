// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { CompactHomeHeader } from "./CompactHomeHeader";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({ dispatch }),
}));
afterEach(cleanup);
it("shows context and dispatches the existing new-thread command", () => {
  render(
    <TooltipProvider>
      <CompactHomeHeader title="A long project context" />
    </TooltipProvider>,
  );
  expect(
    screen.getByText("A long project context").classList.contains("truncate"),
  ).toBe(true);
  const action = screen.getByRole("button", { name: "New thread" });
  fireEvent.click(action);
  expect(dispatch).toHaveBeenCalledWith("thread.new", action);
});
