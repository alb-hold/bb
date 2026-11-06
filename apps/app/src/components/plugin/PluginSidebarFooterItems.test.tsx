// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import {
  useSidebarFooterPreferences,
  sidebarFooterCapacityAtom,
  sidebarFooterOrderAtom,
  sidebarFooterHiddenAtom,
} from "@/components/sidebar/sidebarFooterPreferences";
import { SidebarFooterCustomize } from "@/components/sidebar/SidebarFooterCustomize";
import { SidebarFooterSettings } from "@/components/settings/SidebarFooterSettings";
import type { ReactNode } from "react";
import type {
  ExperimentalSidebarFooterActionContext,
  ExperimentalSidebarFooterDisclosureController,
} from "@get-bb/plugin-sdk";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar.js";
import {
  resetPluginSlotStoreForTest,
  getPluginSlotSnapshot,
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import {
  PluginSidebarFooterDisclosure,
  PluginSidebarFooterItems,
  usePluginSidebarFooterDisclosure,
} from "./PluginSidebarFooterItems";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import { LocationProbe } from "@/test/location-probe";

function registrationSet(
  overrides: Partial<PluginRegistrationSet>,
): PluginRegistrationSet {
  return {
    homepageSections: [],
    settingsSections: [],
    navPanels: [],
    threadPanelActions: [],
    sidebarFooterActions: [],
    fileOpeners: [],
    messageDirectives: [],
    ...overrides,
  };
}

function pinnedFooterStore() {
  const store = createStore();
  store.set(sidebarFooterOrderAtom, [
    "builtin:mobile",
    ...getPluginSlotSnapshot().sidebarFooterItems.map(
      (item) => `plugin:${item.pluginId}/${item.id}`,
    ),
    "builtin:report-bug",
  ]);
  return store;
}

function renderWithProviders(ui: ReactNode, store = pinnedFooterStore()) {
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>
          <SidebarProvider>
            {ui}
            <LocationProbe />
          </SidebarProvider>
        </TooltipProvider>
      </MemoryRouter>
    </Provider>,
  );
}

function FooterHarness({
  onCustomize = () => {},
}: {
  onCustomize?: () => void;
}) {
  const disclosure = usePluginSidebarFooterDisclosure();
  return (
    <>
      <PluginSidebarFooterDisclosure
        item={disclosure.activeItem}
        onDismiss={disclosure.dismiss}
      />
      <SidebarMenu>
        <PluginSidebarFooterItems
          onCustomize={onCustomize}
          activeDisclosureKey={disclosure.activeKey}
          onDisclosureCommand={disclosure.handleCommand}
        />
      </SidebarMenu>
    </>
  );
}

function UsageDisclosure({ dismiss }: { dismiss(): void }) {
  return (
    <div>
      <p>Provider usage content</p>
      <button type="button" onClick={dismiss}>
        Dismiss usage
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginLogoStoreForTest();
  vi.restoreAllMocks();
});

function FooterPreferencesProbe() {
  const preferences = useSidebarFooterPreferences();
  return (
    <>
      <output data-testid="visible-footer">
        {preferences.footer.map((item) => item.key).join(",")}
      </output>
      <output data-testid="more-footer">
        {preferences.more.map((item) => item.key).join(",")}
      </output>
      <button onClick={() => preferences.addToFooter("builtin:mobile")}>
        Choose mobile
      </button>
    </>
  );
}

describe("PluginSidebarFooterItems", () => {
  it.each([
    [true, null],
    [true, 1],
    [false, null],
    [false, 1],
  ] as const)(
    "keeps the host prefix stable when a plugin arrives (compact=%s, capacity=%s)",
    (compact, capacity) => {
      const store = createStore();
      store.set(sidebarFooterCapacityAtom, capacity);
      const view = renderWithProviders(
        <CompactViewportOverrideProvider isCompactViewport={compact}>
          <SidebarMenu>
            <PluginSidebarFooterItems
              activeDisclosureKey={null}
              onDisclosureCommand={vi.fn()}
              onCustomize={vi.fn()}
              builtInActions={[{ id: "report-bug", onActivate: vi.fn() }]}
            />
          </SidebarMenu>
        </CompactViewportOverrideProvider>,
        store,
      );
      const labels = () =>
        Array.from(
          view.container.querySelectorAll('[data-sidebar="menu-button"]'),
        ).map((item) => item.getAttribute("aria-label"));
      expect(labels()).toEqual(["Report a bug", "More footer actions"]);
      act(() =>
        setPluginSlotRegistrations(
          "garden",
          collectPluginAppRegistrations(
            definePluginApp((app) => {
              app.experimental_sidebarFooter.register({
                kind: "action",
                id: "notes",
                label: "Garden notes",
                icon: "BookOpen",
                onActivate: vi.fn(),
              });
            }),
          ),
        ),
      );
      expect(labels()).toEqual(capacity === null
        ? ["Report a bug", "More footer actions", "Garden notes"]
        : ["Report a bug", "More footer actions"]);
    },
  );

  it.each(["Provider usage", "Report a bug", "More footer actions"])(
    "gives %s a matching accessible name and keyboard tooltip",
    async (label) => {
      setPluginSlotRegistrations(
        "usage",
        collectPluginAppRegistrations(
          definePluginApp((app) => {
            app.experimental_sidebarFooter.register({
              kind: "action",
              id: "usage",
              label: "Provider usage",
              icon: "ChartColumn",
              onActivate: vi.fn(),
            });
          }),
        ),
      );
      renderWithProviders(
        <SidebarMenu>
          <PluginSidebarFooterItems
            activeDisclosureKey={null}
            onDisclosureCommand={vi.fn()}
            onCustomize={vi.fn()}
            builtInActions={[{ id: "report-bug", onActivate: vi.fn() }]}
          />
        </SidebarMenu>,
        createStore(),
      );
      const trigger = screen.getByRole("button", { name: label });
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => trigger.focus());
      expect((await screen.findByRole("tooltip")).textContent).toBe(label);
    },
  );

  it.each(["order", "hidden"])(
    "preserves an existing profile with saved %s",
    (kind) => {
      const store = createStore();
      if (kind === "order")
        store.set(sidebarFooterOrderAtom, [
          "builtin:report-bug",
          "builtin:mobile",
        ]);
      else store.set(sidebarFooterHiddenAtom, ["builtin:report-bug"]);
      renderWithProviders(<FooterPreferencesProbe />, store);
      expect(screen.getByTestId("visible-footer").textContent).toContain(
        "builtin:mobile",
      );
      expect(
        screen.getByTestId(kind === "hidden" ? "more-footer" : "visible-footer")
          .textContent,
      ).toContain("builtin:report-bug");
    },
  );

  it("chooses an item without hiding existing shortcuts", () => {
    const store = createStore();
    store.set(sidebarFooterOrderAtom, ["builtin:report-bug", "builtin:mobile"]);
    store.set(sidebarFooterHiddenAtom, ["builtin:mobile"]);
    renderWithProviders(<FooterPreferencesProbe />, store);
    expect(screen.getByTestId("visible-footer").textContent).toBe(
      "builtin:report-bug",
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose mobile" }));
    expect(screen.getByTestId("visible-footer").textContent).toBe(
      "builtin:report-bug,builtin:mobile",
    );
  });

  it("keeps plugin actions and bug reporting in the footer and mobile apps in More by default", async () => {
    const run = vi.fn();
    setPluginSlotRegistrations(
      "example",
      collectPluginAppRegistrations(
        definePluginApp((app) => {
          app.experimental_sidebarFooter.register({
            kind: "action",
            id: "action",
            label: "Run action",
            icon: "Zap",
            onActivate: run,
          });
        }),
      ),
    );
    renderWithProviders(
      <SidebarMenu>
        <PluginSidebarFooterItems
          activeDisclosureKey={null}
          onDisclosureCommand={vi.fn()}
          onCustomize={vi.fn()}
          builtInActions={[
            { id: "mobile", onActivate: run },
            { id: "report-bug", onActivate: run },
          ]}
        />
      </SidebarMenu>,
      createStore(),
    );
    expect(document.querySelectorAll("[data-footer-item]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Report a bug" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Mobile apps" })).toBeNull();
    const more = screen.getByRole("button", { name: "More footer actions" });
    expect(more.className).toContain("text-muted-foreground");
    expect(more.className).not.toContain("opacity-80");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More footer actions" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Mobile apps" }),
    ).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Report a bug" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Run action" })).toBeNull();
  });

  it("fills the footer to its measured capacity and keeps overflow in More when an icon is removed", () => {
    setPluginSlotRegistrations(
      "example",
      collectPluginAppRegistrations(
        definePluginApp((app) => {
          for (const id of ["one", "two", "three", "four"]) {
            app.experimental_sidebarFooter.register({
              kind: "action",
              id,
              label: `Action ${id}`,
              icon: "Zap",
              onActivate: vi.fn(),
            });
          }
        }),
      ),
    );
    const store = pinnedFooterStore();
    store.set(sidebarFooterHiddenAtom, ["plugin:unloaded/action"]);
    store.set(sidebarFooterCapacityAtom, 5);
    renderWithProviders(<SidebarFooterCustomize onDone={() => {}} />, store);
    const footerIcons = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-footer-icon]"),
        (element) => element.dataset.footerIcon,
      );
    expect(footerIcons()).toEqual([
      "builtin:mobile",
      "builtin:report-bug",
      "plugin:example/one",
      "plugin:example/two",
      "plugin:example/three",
    ]);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove Mobile apps from footer" }),
    );
    expect(
      screen.getByRole("button", { name: "Add Action four to footer" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Action two from footer" }),
    );
    expect(store.get(sidebarFooterHiddenAtom)).toEqual([
      "plugin:unloaded/action",
      "plugin:example/four",
      "plugin:example/two",
    ]);
    expect(footerIcons()).toEqual([
      "builtin:mobile",
      "builtin:report-bug",
      "plugin:example/one",
      "plugin:example/three",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Add Action two to footer" }),
    );
    expect(footerIcons()).toEqual([
      "builtin:mobile",
      "builtin:report-bug",
      "plugin:example/one",
      "plugin:example/three",
      "plugin:example/two",
    ]);
    expect(
      screen.getByRole("button", { name: "Add Action four to footer" }),
    ).toHaveProperty("disabled", true);

    act(() => store.set(sidebarFooterCapacityAtom, 6));
    expect(footerIcons()).toHaveLength(5);
    fireEvent.click(
      screen.getByRole("button", { name: "Add Action four to footer" }),
    );
    expect(footerIcons()).toEqual([
      "builtin:mobile",
      "builtin:report-bug",
      "plugin:example/one",
      "plugin:example/three",
      "plugin:example/two",
      "plugin:example/four",
    ]);
    expect(store.get(sidebarFooterHiddenAtom)).toEqual([
      "plugin:unloaded/action",
    ]);
  });

  it("hides the whole footer from More and shows it again", async () => {
    setPluginSlotRegistrations(
      "example",
      collectPluginAppRegistrations(
        definePluginApp((app) => {
          app.experimental_sidebarFooter.register({
            kind: "action",
            id: "action",
            label: "Run action",
            icon: "Zap",
            onActivate: vi.fn(),
          });
        }),
      ),
    );
    const store = pinnedFooterStore();
    store.set(sidebarFooterHiddenAtom, ["plugin:unloaded/action"]);
    renderWithProviders(<FooterHarness />, store);
    const openMore = () =>
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "More footer actions" }),
        { button: 0, ctrlKey: false, pointerType: "mouse" },
      );
    openMore();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide footer" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Run action" })).toBeNull(),
    );
    expect(store.get(sidebarFooterHiddenAtom)).toEqual([
      "plugin:unloaded/action",
      "builtin:mobile",
      "plugin:example/action",
      "builtin:report-bug",
    ]);
    openMore();
    expect(
      await screen.findByRole("menuitem", { name: "Run action" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show footer" }));
    await screen.findByRole("button", { name: "Run action" });
    expect(store.get(sidebarFooterHiddenAtom)).toEqual([
      "plugin:unloaded/action",
    ]);
  });

  it("prefers the footer action icon over plugin branding", () => {
    setPluginLogoUrls(
      new Map([
        [
          "remote",
          {
            displayName: "Remote",
            icon: "FileText",
            compactIconUrl: null,
            logoUrl: "/api/v1/plugins/remote/assets/logo?h=abc",
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    setPluginSlotRegistrations(
      "remote",
      registrationSet({
        sidebarFooterActions: [
          {
            id: "open",
            title: "Remote",
            icon: "Smartphone",
            run: () => {},
          },
        ],
      }),
    );

    renderWithProviders(<FooterHarness />);

    expect(screen.getByRole("button", { name: "Remote" }).dataset.testid).toBe(
      "plugin-sidebar-footer-action-remote-open",
    );
    expect(document.querySelector('[data-icon="FileText"]')).toBeNull();
    expect(document.querySelector('[data-icon="Smartphone"]')).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("contains a throwing run without breaking the sidebar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPluginSlotRegistrations(
      "broken",
      registrationSet({
        sidebarFooterActions: [
          {
            id: "boom",
            title: "Boom",
            icon: "Zap",
            run: () => {
              throw new Error("nope");
            },
          },
        ],
      }),
    );

    renderWithProviders(<FooterHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Boom" }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sidebarFooterAction "boom" failed: nope'),
    );
  });

  it("opens plugin Settings", () => {
    setPluginSlotRegistrations(
      "remote",
      registrationSet({
        sidebarFooterActions: [
          {
            id: "settings",
            title: "Remote settings",
            icon: "Settings",
            run: ({ openSettings }) => openSettings(),
          },
        ],
      }),
    );

    renderWithProviders(<FooterHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Remote settings" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/plugins/remote",
    );
  });

  it("runs a unified footer action with plugin-detail navigation", () => {
    const onActivate = vi.fn(
      ({ openPluginDetails }: ExperimentalSidebarFooterActionContext) =>
        openPluginDetails(),
    );
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "action",
        id: "remote",
        label: "Remote access",
        icon: "Smartphone",
        onActivate,
      });
    });
    setPluginSlotRegistrations(
      "connect",
      collectPluginAppRegistrations(definition),
    );

    renderWithProviders(<FooterHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Remote access" }));

    expect(onActivate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/plugins/connect",
    );
  });

  it("toggles and dismisses a disclosure accessibly", () => {
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Provider usage",
        icon: "ChartColumn",
        component: UsageDisclosure,
      });
    });
    const registrations = collectPluginAppRegistrations(definition);
    setPluginLogoUrls(
      new Map([
        [
          "usage-plugin",
          {
            displayName: "Usage plugin",
            icon: "Beaker",
            compactIconUrl: null,
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    setPluginSlotRegistrations("usage-plugin", registrations);

    renderWithProviders(<FooterHarness />);

    const trigger = screen.getByRole("button", { name: "Provider usage" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-icon="ChartColumn"]')).not.toBeNull();
    expect(document.querySelector('[data-icon="Beaker"]')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("Provider usage content")).toBeDefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss usage" }));
    expect(screen.queryByText("Provider usage content")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the tooltip closed when the More drawer returns focus after a touch dismissal", () => {
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Provider usage",
        icon: "ChartColumn",
        component: UsageDisclosure,
      });
    });
    setPluginSlotRegistrations(
      "usage-plugin",
      collectPluginAppRegistrations(definition),
    );

    renderWithProviders(<FooterHarness />);
    const trigger = screen.getByRole("button", { name: "Provider usage" });

    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.pointerUp(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    expect(screen.getByText("Provider usage content")).toBeDefined();

    const dismissButton = screen.getByRole("button", { name: "Dismiss usage" });
    fireEvent.pointerDown(dismissButton, { pointerType: "touch" });
    fireEvent.pointerUp(dismissButton, { pointerType: "touch" });
    fireEvent.click(dismissButton);
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    fireEvent.pointerUp(document.body, { pointerType: "touch" });
    fireEvent.blur(trigger);
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    fireEvent.pointerUp(document.body, { pointerType: "touch" });
    trigger.focus();
    fireEvent.focus(trigger);

    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("lets the host coordinate disclosures from multiple plugins", () => {
    let first: ExperimentalSidebarFooterDisclosureController | null = null;
    let second: ExperimentalSidebarFooterDisclosureController | null = null;
    const firstDefinition = definePluginApp((app) => {
      first = app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "status",
        label: "First status",
        icon: "ChartColumn",
        component: () => <p>First content</p>,
      });
    });
    const secondDefinition = definePluginApp((app) => {
      second = app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "status",
        label: "Second status",
        icon: "ChartColumn",
        component: () => <p>Second content</p>,
      });
    });
    setPluginSlotRegistrations(
      "first-plugin",
      collectPluginAppRegistrations(firstDefinition),
    );
    setPluginSlotRegistrations(
      "second-plugin",
      collectPluginAppRegistrations(secondDefinition),
    );
    renderWithProviders(<FooterHarness />);

    const firstTrigger = screen.getByRole("button", { name: "First status" });
    const secondTrigger = screen.getByRole("button", {
      name: "Second status",
    });

    fireEvent.click(firstTrigger);
    expect(screen.getByText("First content")).toBeDefined();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(secondTrigger);
    expect(screen.queryByText("First content")).toBeNull();
    expect(screen.getByText("Second content")).toBeDefined();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("true");

    act(() => first!.close());
    expect(screen.getByText("Second content")).toBeDefined();

    act(() => {
      second!.open();
      first!.open();
    });
    expect(screen.getByText("First content")).toBeDefined();
    expect(screen.queryByText("Second content")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("First content")).toBeNull();
  });

  it("moves an open disclosure into More, still opens it there, and restores it through appearance settings", async () => {
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Provider usage",
        icon: "ChartColumn",
        component: () => <p>Usage detail</p>,
      });
    });
    setPluginSlotRegistrations(
      "usage-plugin",
      collectPluginAppRegistrations(definition),
    );
    const store = pinnedFooterStore();
    const onCustomize = vi.fn();
    renderWithProviders(
      <>
        <FooterHarness onCustomize={onCustomize} />
        <SidebarFooterSettings />
      </>,
      store,
    );
    expect(
      screen.getByRole("button", { name: "More footer actions" }),
    ).toBeDefined();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More footer actions" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize footer" }),
    );
    await waitFor(() => expect(onCustomize).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("location").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Provider usage" }));
    expect(screen.getByText("Usage detail")).toBeDefined();
    act(() => store.set(sidebarFooterCapacityAtom, 3));
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Provider usage" }),
    );
    fireEvent.pointerUp(
      await screen.findByRole("menuitem", { name: "Customize footer" }),
      { button: 2, pointerType: "mouse" },
    );
    expect(screen.getByTestId("location").textContent).toBe("/");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide from footer" }),
    );
    await waitFor(() => expect(screen.queryByText("Usage detail")).toBeNull());
    expect(store.get(sidebarFooterHiddenAtom)).toEqual([
      "plugin:usage-plugin/usage",
    ]);
    act(() => store.set(sidebarFooterCapacityAtom, null));
    expect(screen.queryByRole("button", { name: "Provider usage" })).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More footer actions" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Provider usage" }),
    );
    await screen.findByText("Usage detail");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("sidebar-footer-more"),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Show Provider usage in footer" }),
    );
    expect(
      screen.getByRole("button", { name: "Provider usage" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "More footer actions" }),
    ).toBeDefined();
  });

  it("keeps hidden actions callable and preserves preferences across plugin reloads", async () => {
    const run = vi.fn();
    const registration = collectPluginAppRegistrations(
      definePluginApp((app) => {
        app.experimental_sidebarFooter.register({
          kind: "action",
          id: "action",
          label: "Run action",
          icon: "Zap",
          onActivate: run,
        });
      }),
    );
    setPluginSlotRegistrations("example", registration);
    const store = createStore();
    store.set(sidebarFooterHiddenAtom, ["plugin:example/action"]);
    store.set(sidebarFooterOrderAtom, [
      "plugin:missing/item",
      "plugin:example/action",
    ]);
    renderWithProviders(<FooterHarness />, store);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More footer actions" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Run action" }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    act(() => removePluginSlotRegistrations("example"));
    expect(
      screen.getByRole("button", { name: "More footer actions" }),
    ).toBeDefined();
    act(() =>
      setPluginSlotRegistrations(
        "new-plugin",
        collectPluginAppRegistrations(
          definePluginApp((app) => {
            app.experimental_sidebarFooter.register({
              kind: "action",
              id: "new",
              label: "New action",
              icon: "Zap",
              onActivate: run,
            });
          }),
        ),
      ),
    );
    expect(screen.getByRole("button", { name: "New action" })).toBeDefined();
    act(() => setPluginSlotRegistrations("example", registration));
    expect(screen.queryByRole("button", { name: "Run action" })).toBeNull();
    expect(store.get(sidebarFooterHiddenAtom)).toEqual([
      "plugin:example/action",
    ]);
    expect(store.get(sidebarFooterOrderAtom)).toEqual([
      "plugin:missing/item",
      "plugin:example/action",
    ]);
  });

  it("keeps stored order within host and plugin groups and all-hidden actions reachable", async () => {
    const run = vi.fn();
    setPluginSlotRegistrations(
      "example",
      collectPluginAppRegistrations(
        definePluginApp((app) => {
          app.experimental_sidebarFooter.register({
            kind: "action",
            id: "action",
            label: "Run action",
            icon: "Zap",
            onActivate: run,
          });
        }),
      ),
    );
    const store = createStore();
    store.set(sidebarFooterOrderAtom, [
      "builtin:report-bug",
      "plugin:example/action",
      "builtin:settings",
      "builtin:mobile",
    ]);
    const view = renderWithProviders(
      <SidebarMenu>
        <PluginSidebarFooterItems
          onCustomize={vi.fn()}
          activeDisclosureKey={null}
          onDisclosureCommand={vi.fn()}
          builtInActions={[
            { id: "mobile", href: "/settings/mobile", onActivate: run },
            { id: "report-bug", onActivate: run },
          ]}
        />
      </SidebarMenu>,
      store,
    );
    expect(
      [...view.container.querySelectorAll("[data-footer-item]")].map((item) =>
        item.getAttribute("data-footer-item"),
      ),
    ).toEqual([
      "builtin:report-bug",
      "builtin:mobile",
      "plugin:example/action",
    ]);
    expect(
      screen.getByRole("link", { name: "Mobile apps" }).getAttribute("href"),
    ).toBe("/settings/mobile");
    act(() =>
      store.set(sidebarFooterHiddenAtom, [
        "builtin:settings",
        "builtin:mobile",
        "builtin:report-bug",
        "plugin:example/action",
      ]),
    );
    expect(view.container.querySelectorAll("[data-footer-item]")).toHaveLength(
      0,
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More footer actions" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Report a bug" }),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
