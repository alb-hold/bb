// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { MobileSettingsCategoryBar } from "./SettingsCategoryNav";
import { SETTINGS_NAV_SECTIONS } from "./settings-sections";

const configurablePlugin = {
  hasSettingsForm: true,
  icon: null,
  id: "linear",
  label: "Linear",
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

afterEach(cleanup);

describe("MobileSettingsCategoryBar", () => {
  it("shows the active section title and opens the shared category list in a persistent responsive drawer", async () => {
    const appRoot = document.createElement("main");
    document.body.appendChild(appRoot);

    try {
      render(
        <MemoryRouter initialEntries={["/settings"]}>
          <LocationProbe />
          <MobileSettingsCategoryBar
            navigation={{
              activePluginId: null,
              activeSection: "general",
              pluginEntries: [configurablePlugin],
              sections: SETTINGS_NAV_SECTIONS,
            }}
          />
        </MemoryRouter>,
      );

      const bar = screen.getByTestId("mobile-settings-category-bar");
      expect(bar.classList.contains("md:hidden")).toBe(true);
      expect(
        screen.getByRole("heading", { level: 2, name: "General" }),
      ).toBeDefined();
      expect(
        document.querySelector("[data-persistent-drawer-content]"),
      ).toBeNull();

      const trigger = screen.getByRole("button", { name: "Categories" });
      expect(trigger.classList.contains("min-h-11")).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger);

      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(appRoot.hasAttribute("inert")).toBe(false);
      expect(appRoot.getAttribute("aria-hidden")).toBeNull();

      const nav = await screen.findByRole("navigation", {
        name: "Settings categories",
      });
      expect(
        within(nav)
          .getByRole("link", { name: "General" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(
        within(nav).getByRole("link", { name: "Linear" }).getAttribute("href"),
      ).toBe("/settings/plugins/linear");
      expect(
        within(nav)
          .getByRole("link", { name: "Archived threads" })
          .getAttribute("href"),
      ).toBe("/settings/archived");

      fireEvent.click(within(nav).getByRole("link", { name: "Appearance" }));

      expect(screen.getByTestId("location").textContent).toBe(
        "/settings/appearance",
      );
      await waitFor(() =>
        expect(trigger.getAttribute("aria-expanded")).toBe("false"),
      );
    } finally {
      appRoot.remove();
    }
  });

  it("shows the active plugin name when viewing a plugin settings route", () => {
    render(
      <MemoryRouter initialEntries={["/settings/plugins/linear"]}>
        <MobileSettingsCategoryBar
          navigation={{
            activePluginId: "linear",
            activeSection: null,
            pluginEntries: [configurablePlugin],
            sections: SETTINGS_NAV_SECTIONS,
          }}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Linear" }),
    ).toBeDefined();
  });
});
