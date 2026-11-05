// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerSubmitButton, COMPOSER_SHELL_CLASS } from "./composer-primitives";

afterEach(cleanup);

it("keeps the send glyph and geometry when sending is unavailable", () => {
  const onClick = vi.fn();
  const { rerender, container } = render(
    <form className={COMPOSER_SHELL_CLASS}>
      <ComposerSubmitButton aria-label="Send" disabled onClick={onClick} />
    </form>,
  );
  const button = screen.getByRole("button", { name: "Send" });
  const glyph = button.querySelector('[data-icon="ArrowUp"]');
  expect(glyph).not.toBeNull();
  expect(button.querySelector('.animate-spin')).toBeNull();
  expect(button.classList.contains('size-9')).toBe(true);
  expect(button.classList.contains('pointer-coarse:size-11')).toBe(true);
  expect(button.classList.contains('disabled:opacity-50')).toBe(true);
  expect(container.querySelector('form')?.classList.contains('rounded-xl')).toBe(true);
  expect(container.querySelector('form')?.classList.contains('border-border')).toBe(true);
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  rerender(<ComposerSubmitButton aria-label="Send" onClick={onClick} />);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onClick).toHaveBeenCalledOnce();
});
