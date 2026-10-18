// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginThreadActionEntry } from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { TooltipProvider } from "@/components/ui/tooltip";

installTestPluginRuntime();
const { ThreadRowQuickActions } = await import("./ThreadRowQuickActions.js");

function moveEntry(
  projectCount: number,
  run: (value?: string) => Promise<void>,
): PluginThreadActionEntry {
  return {
    key: "bb--core/moveToProject",
    pluginId: "bb--core",
    group: "organize",
    action: {
      label: "Move to project",
      icon: "FolderOpen",
      choices: {
        heading: "Move to project",
        items: Array.from({ length: projectCount }, (_, index) => ({
          id: `proj_${index}`,
          label: `Project ${index}`,
        })),
      },
      run,
    },
  };
}

function renderQuickActions(entry: PluginThreadActionEntry) {
  render(
    <TooltipProvider>
      <ThreadRowQuickActions entries={[entry]} />
    </TooltipProvider>,
  );
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Move to project" }),
    {
      button: 0,
    },
  );
}

afterEach(() => {
  cleanup();
});

describe("ThreadRowQuickActions choices", () => {
  it("filters a long choice list and runs the picked choice", async () => {
    const run = vi.fn(async () => {});
    renderQuickActions(moveEntry(30, run));
    const filter = await screen.findByRole("textbox", {
      name: "Filter Move to project",
    });
    filter.focus();
    fireEvent.keyDown(filter, { key: "P" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "project 25" } });
    expect(screen.queryByRole("menuitem", { name: "Project 2" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Project 25" }));
    expect(run).toHaveBeenCalledWith("proj_25");
  });

  it("focuses the filter on open and sends row keystrokes into it", async () => {
    renderQuickActions(moveEntry(30, async () => {}));
    const filter = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Filter Move to project",
    });
    await waitFor(() => expect(document.activeElement).toBe(filter));
    const row = screen.getByRole("menuitem", { name: "Project 7" });
    row.focus();
    fireEvent.keyDown(row, { key: "7" });
    expect(filter.value).toBe("7");
    expect(document.activeElement).toBe(filter);
    expect(screen.queryByRole("menuitem", { name: "Project 8" })).toBeNull();
  });

  it("leaves focus off the filter on a coarse pointer", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    try {
      renderQuickActions(moveEntry(30, async () => {}));
      const filter = await screen.findByRole("textbox", {
        name: "Filter Move to project",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).not.toBe(filter);
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("lists a short choice list without a filter", async () => {
    renderQuickActions(moveEntry(3, async () => {}));
    expect(
      await screen.findByRole("menuitem", { name: "Project 2" }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
