// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ImageLightbox } from "./plugin-sdk-lazy-components";

afterEach(cleanup);

it("opens the lazy SDK lightbox and restores focus to its trigger after closing", async () => {
  function Preview() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Preview attachment</button>
        <ImageLightbox
          imageAlt="Attachment"
          imageSrc={open ? "/attachment.png" : null}
          isOpen={open}
          title="Attachment preview"
          onClose={() => setOpen(false)}
        />
      </>
    );
  }
  render(<Preview />);
  const trigger = screen.getByRole("button", { name: "Preview attachment" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: "Attachment preview",
  });
  expect(document.activeElement).toBe(dialog);
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
