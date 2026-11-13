// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import { makeProjectResponse } from "@/test/fixtures/projects";

const mockPathPickerHost = vi.hoisted(() => ({
  value: { hostId: null as string | null, hostName: null as string | null },
}));

const mockProjectActions = vi.hoisted(() => ({
  requestRename: vi.fn(),
  requestDelete: vi.fn(),
  requestAddLocalPath: vi.fn(),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  usePathPickerHost: () => mockPathPickerHost.value,
}));

vi.mock("./ProjectActionsProvider", () => ({
  useProjectActions: () => mockProjectActions,
}));

describe("ProjectActionsMenu", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockPathPickerHost.value = { hostId: null, hostName: null };
  });

  it.each(["keyboard", "pointer"] as const)("closes after selecting an action opened by %s", async (input) => {
    const project = makeProjectResponse();

    render(
      <MemoryRouter>
        <ProjectActionsMenu project={project} />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: "Test project actions" });
    if (input === "keyboard") {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      await act(() => vi.dynamicImportSettled());
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole("menuitem", { name: "Project settings" }),
        );
      });
    } else {
      fireEvent.pointerDown(trigger, { button: 0 });
      await act(() => vi.dynamicImportSettled());
      await screen.findByRole("menuitem", { name: "Project settings" });
      expect(document.activeElement).not.toBe(
        screen.getByRole("menuitem", { name: "Project settings" }),
      );
    }
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    });
  });
});
