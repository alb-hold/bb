// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OptionPicker } from "./OptionPicker";

const chunk = vi.hoisted(() => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, pending, requested: vi.fn() };
});
vi.mock("./OptionPickerItems", async (importOriginal) => {
  chunk.requested();
  await chunk.pending;
  return importOriginal();
});
afterEach(cleanup);

it("opens from the first click while its body is downloading and selects without another trigger click", async () => {
  const onChange = vi.fn();
  render(
    <OptionPicker
      label="Permissions"
      value="read"
      options={[
        { value: "read", label: "Read only" },
        { value: "write", label: "Allow edits" },
      ]}
      onChange={onChange}
    />,
  );
  expect(chunk.requested).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Permissions" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  expect(screen.queryByRole("menuitem", { name: "Allow edits" })).toBeNull();
  await act(async () => chunk.release());
  fireEvent.click(await screen.findByRole("menuitem", { name: "Allow edits" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("write");
});
