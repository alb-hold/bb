// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { PermissionModePicker } from "./PermissionModePicker";

const options = [
  { value: "auto", label: "Approve for me" },
  { value: "accept-edits", label: "Accept Edits" },
  { value: "full", label: "Full Access", tone: "warning" },
] as const;
afterEach(cleanup);

it.each(["auto", "full"] as const)(
  "keeps the desktop %s label intrinsic and reserves its enabled chevron",
  (value) => {
    const props = {
      value,
      options,
      supported: true,
      onChange: vi.fn(),
      showChevronWhenDisabled: false,
    };
    const view = render(<PermissionModePicker {...props} disabled />);
    const trigger = screen.getByRole("button", { name: "Permissions" });
    expect(trigger.classList.contains("w-max")).toBe(true);
    expect(trigger.classList.contains("min-w-0")).toBe(true);
    expect(trigger.classList.contains("gap-1")).toBe(true);
    expect(
      trigger
        .querySelector('[data-icon="ChevronDown"]')
        ?.classList.contains("ml-auto"),
    ).toBe(false);
    expect(trigger.classList.contains("w-44")).toBe(false);
    expect(
      trigger
        .querySelector('[data-icon="ChevronDown"]')
        ?.classList.contains("invisible"),
    ).toBe(true);
    const label = trigger.textContent;
    view.rerender(<PermissionModePicker {...props} />);
    const enabledTrigger = screen.getByRole("button", { name: "Permissions" });
    expect(enabledTrigger.textContent).toBe(label);
    expect(
      enabledTrigger
        .querySelector('[data-icon="ChevronDown"]')
        ?.classList.contains("invisible"),
    ).toBe(false);
  },
);

it("keeps desktop sizing intrinsic while defaults and capabilities settle", () => {
  const onChange = vi.fn();
  const view = render(
    <PermissionModePicker
      value="auto"
      options={[]}
      pending
      supported
      showChevronWhenDisabled={false}
      onChange={onChange}
    />,
  );
  const assertWidth = () =>
    expect(
      screen
        .getByRole("button", { name: "Permissions" })
        .classList.contains("min-w-0"),
    ).toBe(true);
  assertWidth();
  expect(
    screen
      .getByRole("button", { name: "Permissions" })
      .querySelector('[data-icon="ChevronDown"]')
      ?.classList.contains("invisible"),
  ).toBe(true);
  view.rerender(
    <PermissionModePicker
      value="auto"
      options={options}
      supported
      showChevronWhenDisabled={false}
      onChange={onChange}
    />,
  );
  assertWidth();
  expect(screen.getByRole("button", { name: "Permissions" }).textContent).toBe(
    "Permissions:Ask first",
  );
  expect(
    screen
      .getByRole("button", { name: "Permissions" })
      .querySelector('[data-icon="ChevronDown"]'),
  ).not.toBeNull();
  for (const value of ["full", "auto", "accept-edits"] as const) {
    view.rerender(
      <PermissionModePicker
        value={value}
        options={options}
        supported
        onChange={onChange}
      />,
    );
    assertWidth();
  }
  view.rerender(
    <PermissionModePicker options={[]} pending supported onChange={onChange} />,
  );
  assertWidth();
  expect(onChange).not.toHaveBeenCalled();
});

it.each(["auto", "accept-edits", "full"] as const)(
  "names permissions and shows the shared shield for %s",
  (value) => {
    render(
      <PermissionModePicker
        value={value}
        options={options}
        supported
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Permissions" });
    expect(trigger.textContent).toBe(
      `Permissions:${value === "auto" ? "Ask first" : value === "full" ? "Full Access" : "Edits"}`,
    );
    expect(trigger.querySelector('[data-icon="SecurityCheck"]')).not.toBeNull();
    expect(trigger.querySelector('[data-icon="AlertTriangle"]')).toBeNull();
    expect(trigger.classList.contains("text-warning-text")).toBe(
      value === "full",
    );
  },
);

it("keeps cached values and chevrons during provider refresh without changing permissions", () => {
  const onChange = vi.fn();
  const view = render(
    <PermissionModePicker
      value="full"
      options={options}
      supported
      onChange={onChange}
    />,
  );
  view.rerender(
    <PermissionModePicker
      value="auto"
      options={[]}
      pending
      supported
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Permissions" });
  expect(trigger.textContent).toBe("Permissions:Full Access");
  expect(trigger.hasAttribute("disabled")).toBe(true);
  expect(trigger.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it("uses the initial cached mode before options resolve", () => {
  render(
    <PermissionModePicker
      value="auto"
      options={[]}
      pending
      supported
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Permissions" }).textContent).toBe(
    "Permissions:Ask first",
  );
});

it("reserves a skeleton when no cached mode exists", () => {
  render(
    <PermissionModePicker options={[]} pending supported onChange={() => {}} />,
  );
  expect(
    screen.getByRole("button", { name: "Permissions" }).className,
  ).toContain("min-w-0");
  expect(
    screen.getByRole("button", { name: "Permissions" }).className,
  ).toContain("[&>span]:invisible");
});

it("preserves plan display overrides without changing selected permissions", () => {
  const onChange = vi.fn();
  render(
    <PermissionModePicker
      value="full"
      options={options}
      pending
      supported
      displayOverride={{ label: "Plan Mode" }}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Permissions" }).textContent).toBe(
    "Permissions:Plan Mode",
  );
  expect(onChange).not.toHaveBeenCalled();
});

it("opens the same options and applies a selected permission", async () => {
  const onChange = vi.fn();
  render(
    <PermissionModePicker
      value="auto"
      options={options}
      supported
      onChange={onChange}
    />,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Permissions" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Full Access/ }));
  expect(onChange).toHaveBeenCalledWith("full");
});

it.each([false, true])(
  "hides unsupported and single-option controls (%s)",
  (supported) => {
    render(
      <PermissionModePicker
        value="auto"
        options={options.slice(0, 1)}
        supported={supported}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  },
);

it.each(["auto", "accept-edits", "full"] as const)(
  "keeps the mobile %s trigger compact, named and warning-aware",
  (value) => {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <PermissionModePicker
          value={value}
          options={options}
          supported
          onChange={() => {}}
        />
      </CompactViewportOverrideProvider>,
    );
    const mode =
      value === "auto" ? "Ask first" : value === "full" ? "Full Access" : "Edits";
    const trigger = screen.getByRole("button", {
      name: `Permissions: ${mode}`,
    });
    expect(trigger.textContent).toBe(mode);
    expect(trigger.getAttribute("data-compact-touch")).toBe("picker");
    expect(trigger.classList.contains("min-w-28")).toBe(false);
    expect(trigger.classList.contains("w-44")).toBe(false);
    expect(trigger.querySelector('[data-icon="SecurityCheck"]')).not.toBeNull();
    expect(trigger.classList.contains("text-warning-text")).toBe(
      value === "full",
    );
  },
);

it("keeps the phone permission name and menu while marking its collapsible label", async () => {
  const onChange = vi.fn();
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <PermissionModePicker
        value="full"
        options={options}
        supported
        onChange={onChange}
      />
    </CompactViewportOverrideProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Permissions: Full Access",
  });
  expect(trigger.classList.contains("permission-mode-picker")).toBe(true);
  expect(trigger.querySelector("[data-permission-label]")?.textContent).toBe(
    "Full Access",
  );
  expect(trigger.querySelector('[data-icon="SecurityCheck"]')).not.toBeNull();
  expect(trigger.querySelector("[title]")?.getAttribute("title")).toContain(
    "Full Access",
  );
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: /Ask first/ }));
  expect(onChange).toHaveBeenCalledWith("auto");
});

it.each([
  ["full", "Full Access"],
  ["auto", "Ask first"],
  ["accept-edits", "Edits"],
] as const)(
  "names the collapsed phone shield for mode %s while its visible label is hidden",
  (value, label) => {
    const css = readFileSync("src/app.css", "utf8");
    const labelRule = css.match(
      /\[data-promptbox\]\[data-promptbox-collapsed\] \[data-permission-label\] \{[^}]+\}/,
    )?.[0];
    expect(labelRule).toBeDefined();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <style>{labelRule}</style>
        <form data-promptbox="" data-promptbox-collapsed="">
          <PermissionModePicker
            value={value}
            options={options}
            supported
            onChange={vi.fn()}
          />
        </form>
      </CompactViewportOverrideProvider>,
    );
    const trigger = screen.getByRole("button", {
      name: `Permissions: ${label}`,
    });
    expect(
      getComputedStyle(trigger.querySelector("[data-permission-label]")!)
        .display,
    ).toBe("none");
    expect(trigger.querySelector('[data-icon="SecurityCheck"]')).not.toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe(`Permissions: ${label}`);
  },
);
