// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ComposerPlaceholder } from "./ComposerPlaceholder";

afterEach(cleanup);

it("reserves the home composer with labeled disabled controls", () => {
  const { container } = render(
    <ComposerPlaceholder state={{ kind: "loading", shape: "new-thread" }} />,
  );
  expect(
    container.querySelector('[data-slot="skeleton"], .animate-pulse'),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Loading composer" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("button").textContent).toContain(
    "Model · Chat / Terminal",
  );
  const shell = container.querySelector(
    '[data-composer-placeholder="loading"]',
  );
  expect(shell?.classList.contains("h-[132px]")).toBe(true);
  expect(shell?.classList.contains("max-md:pointer-coarse:h-44")).toBe(
    true,
  );
  expect(shell?.classList.contains("rounded-xl")).toBe(true);
});

it("shows the loaded follow-up placeholder while composer controls are disabled", () => {
  render(<ComposerPlaceholder state={{ kind: "loading", shape: "thread-compact" }} />);
  expect(screen.getByText("Ask a follow-up")).toBeTruthy();
  expect(screen.queryByText("Composer")).toBeNull();
  expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
});
