// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { resetPreferencesSyncForTest } from "../preferences/preferences-sync.js";

const subscriptions = vi.hoisted(() => vi.fn());
vi.mock("../model/use-sidebar-data.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../model/use-sidebar-data.js")>();
  return {
    ...original,
    useSidebarData: () => {
      subscriptions();
      return original.useSidebarData();
    },
  };
});

installTestPluginRuntime();
const { experimental_ThreadActionsContextMenu: ThreadActionsContextMenu } =
  await import("@get-bb/plugin-sdk/app");
const { useThreadSelectionMenu } = await import("./useThreadSelectionMenu.js");
const {
  ThreadSelectionProvider,
  useThreadSelectionStore,
  useMultiSelectionContaining,
} = await import("./threadSelection.js");

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  subscriptions.mockClear();
});

function ClosedMenu() {
  const menu = useThreadSelectionMenu(null);
  return <output>{menu === null ? "closed" : "selected"}</output>;
}

it("shares the selection provider's sidebar subscription across 100 closed row menus", () => {
  function Rows() {
    return (
      <ThreadSelectionProvider activeThreadId={null}>
        {Array.from({ length: 100 }, (_, index) => <ClosedMenu key={index} />)}
      </ThreadSelectionProvider>
    );
  }
  renderSlot({ component: Rows }, {}, {
    sidebarThreads: {
      threads: [makeSidebarThread({ id: "a" })],
      projects: [makePluginProject()],
      sections: [],
    },
  });
  expect(screen.getAllByText("closed")).toHaveLength(100);
  expect(subscriptions).toHaveBeenCalledTimes(2);
});

function Selection() {
  const store = useThreadSelectionStore();
  const selected = useMultiSelectionContaining("a");
  const menu = useThreadSelectionMenu(selected);
  return (
    <div data-sidebar="content">
      <a href="#a" data-sidebar-thread-id="a">
        First
      </a>
      <ThreadActionsContextMenu
        thread={{
          id: "b",
          projectId: "proj_test",
          parentThreadId: null,
          parentNotifications: "auto",
          archivedAt: null,
          pinnedAt: null,
          sectionId: null,
          isUnread: false,
          status: "idle",
          environment: null,
        }}
        {...(menu === null
          ? {}
          : {
              experimental_bulkThreads: menu.selection,
              inline: menu.inline,
              onEscapeKeyDown: menu.onEscapeKeyDown,
              onCloseAutoFocus: menu.onCloseAutoFocus,
            })}
      >
        <a
          data-sidebar-thread-id="b"
          onClick={(event) =>
            store.handleClick("b", event, event.currentTarget)
          }
        >
          Second
        </a>
      </ThreadActionsContextMenu>
      <output>{selected?.length ?? 0} selected</output>
    </div>
  );
}

function Harness() {
  return (
    <ThreadSelectionProvider activeThreadId="a">
      <Selection />
    </ThreadSelectionProvider>
  );
}

function renderSelection() {
  const evaluated: (readonly PluginThreadActionTarget[])[] = [];
  const slot = renderSlot(
    { component: Harness },
    {},
    {
      experiments: ["sidebarMultiSelect"],
      sidebarThreads: {
        threads: [
          makeSidebarThread({ id: "a" }),
          makeSidebarThread({ id: "b", pinnedAt: 3 }),
        ],
        projects: [makePluginProject()],
        sections: [],
      },
      threadBulkActions: (threads) => {
        evaluated.push(threads);
        return [];
      },
    },
  );
  fireEvent.click(screen.getByText("Second"), {
    metaKey: true,
    shiftKey: true,
  });
  expect(screen.getByText("2 selected")).toBeTruthy();
  return { evaluated, slot };
}

it("hands the host menu the selected sidebar threads in list order", async () => {
  const { evaluated } = renderSelection();
  fireEvent.contextMenu(screen.getByText("Second"));
  await screen.findByRole("menu", { name: "Actions for 2 threads" });
  expect(
    evaluated.at(-1)?.map(({ id, pinnedAt }) => ({ id, pinnedAt })),
  ).toEqual([
    { id: "a", pinnedAt: null },
    { id: "b", pinnedAt: 3 },
  ]);
});

it("clears the multi-selection from its Clear selection item", async () => {
  renderSelection();
  fireEvent.contextMenu(screen.getByText("Second"));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Clear selection" }),
  );
  await waitFor(() => expect(screen.getByText("0 selected")).toBeTruthy());
});

it("clears the multi-selection when Escape dismisses its context menu", async () => {
  renderSelection();
  fireEvent.contextMenu(screen.getByText("Second"));
  const menu = await screen.findByRole("menu", {
    name: "Actions for 2 threads",
  });
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(screen.getByText("0 selected")).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByText("First")),
  );
});
