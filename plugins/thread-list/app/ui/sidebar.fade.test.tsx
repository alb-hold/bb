// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SidebarContentElementProvider } from "./sidebar";

afterEach(cleanup);

it("shows the bottom scroll cue only while rows remain below", () => {
  const { container, unmount } = render(
    <div data-sidebar="content">
      <SidebarContentElementProvider>
        <div>Threads</div>
      </SidebarContentElementProvider>
    </div>,
  );
  const scroller = container.firstElementChild as HTMLElement;
  Object.defineProperty(scroller, "clientHeight", { value: 200 });
  Object.defineProperty(scroller, "scrollHeight", { value: 400 });
  fireEvent.scroll(scroller);
  expect(scroller.hasAttribute("data-more-below")).toBe(true);
  scroller.scrollTop = 200;
  fireEvent.scroll(scroller);
  expect(scroller.hasAttribute("data-more-below")).toBe(false);
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  expect(scroller.hasAttribute("data-more-below")).toBe(true);
  unmount();
  expect(scroller.hasAttribute("data-more-below")).toBe(false);
});
