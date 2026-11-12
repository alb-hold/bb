// @vitest-environment jsdom
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const route = vi.hoisted(() => {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release, committedAt: -1, sidebarPass: 0 };
});

vi.mock("./components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./views/thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: Object.assign(() => null, {
    preload: () => Promise.resolve(),
  }),
}));
vi.mock("./lib/thread-open-prefetch", () => ({ prefetchThreadOpen: vi.fn() }));
vi.mock("./views/SplitWorkspaceRoute", async () => {
  await route.ready;
  return {
    default: function Workspace() {
      useLayoutEffect(() => {
        route.committedAt = route.sidebarPass;
      }, []);
      return <p>Workspace ready</p>;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("commits the initial workspace while sidebar updates are still arriving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  const { AppRoutes } = await import("./App");
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function UpdatingSidebar() {
    const [pass, setPass] = useState(0);
    useLayoutEffect(() => {
      route.sidebarPass = pass;
      if (pass === 24) finish();
    }, [pass]);
    useEffect(() => {
      if (pass === 24) return;
      const timer = setTimeout(() => {
        if (pass === 0) route.release();
        setPass(pass + 1);
      }, 0);
      return () => clearTimeout(timer);
    }, [pass]);
    return <p>Sidebar pass {pass}</p>;
  }
  render(
    <MemoryRouter initialEntries={["/threads/thr_initial"]}>
      <UpdatingSidebar />
      <AppRoutes />
    </MemoryRouter>,
  );
  await finished;
  expect(screen.getByText("Sidebar pass 24")).toBeTruthy();
  expect(screen.getByText("Workspace ready")).toBeTruthy();
  expect(route.committedAt).toBeGreaterThanOrEqual(0);
  expect(route.committedAt).toBeLessThanOrEqual(3);
});
