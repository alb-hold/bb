// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  SidebarListVisibleContext,
  useSidebarListShown,
} from "./useSidebarListShown.js";

function Probe() {
  return useSidebarListShown() ? <span>pinned rows</span> : null;
}

afterEach(cleanup);

it("tracks the host visibility immediately when the sidebar opens or collapses", () => {
  const { rerender } = render(
    <SidebarListVisibleContext.Provider value={false}>
      <Probe />
    </SidebarListVisibleContext.Provider>,
  );
  expect(screen.queryByText("pinned rows")).toBeNull();
  rerender(
    <SidebarListVisibleContext.Provider value>
      <Probe />
    </SidebarListVisibleContext.Provider>,
  );
  expect(screen.getByText("pinned rows")).toBeTruthy();
  rerender(
    <SidebarListVisibleContext.Provider value={false}>
      <Probe />
    </SidebarListVisibleContext.Provider>,
  );
  expect(screen.queryByText("pinned rows")).toBeNull();
});
