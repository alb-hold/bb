import { createRef } from "react";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ComposerSubmitButton,
  COMPOSER_SHELL_CLASS,
} from "./composer-primitives";

afterEach(cleanup);

it("keeps the send glyph and geometry when sending is unavailable", () => {
  const onClick = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  const { rerender, container } = render(
    <form className={COMPOSER_SHELL_CLASS}>
      <ComposerSubmitButton
        ref={ref}
        aria-label="Send"
        disabled
        onClick={onClick}
      />
    </form>,
  );
  const button = screen.getByRole("button", { name: "Send" });
  expect(ref.current).toBe(button);
  const glyph = button.querySelector('[data-icon="ArrowUp"]');
  expect(glyph).not.toBeNull();
  expect(button.querySelector(".animate-spin")).toBeNull();
  expect(button.classList.contains("size-9")).toBe(true);
  expect(button.classList.contains("pointer-coarse:size-11")).toBe(true);
  expect(button.classList.contains("disabled:opacity-100")).toBe(true);
  expect(
    container.querySelector("form")?.classList.contains("rounded-xl"),
  ).toBe(true);
  expect(
    container.querySelector("form")?.classList.contains("border-border"),
  ).toBe(true);
  expect(button.classList.contains("disabled:bg-foreground/5")).toBe(true);
  expect(button.classList.contains("disabled:text-muted-foreground")).toBe(
    true,
  );
  expect(button.classList.contains("bg-foreground")).toBe(true);
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  rerender(<ComposerSubmitButton aria-label="Send" onClick={onClick} />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onClick).toHaveBeenCalledOnce();
});
