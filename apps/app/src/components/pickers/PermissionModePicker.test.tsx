// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionModePicker } from "./PermissionModePicker";

const originalWidth = window.innerWidth;

const permissionOptions = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
] as const;

afterEach(() => {
  cleanup();
  window.innerWidth = originalWidth;
  vi.clearAllMocks();
});

describe("PermissionModePicker", () => {
  it.each([360, 390, 1280])(
    "ignores provisional full access until permissions resolve at %s",
    (width) => {
      window.innerWidth = width;
      const { rerender } = render(
        <PermissionModePicker
          pending
          value="full"
          options={permissionOptions}
          onChange={() => {}}
          supported
        />,
      );
      const trigger = screen.getByRole("button", { name: "Permission mode" });
      expect(trigger.textContent).toBe("Permissions");
      expect(trigger.hasAttribute("disabled")).toBe(true);
      expect(trigger.querySelector('[data-icon="AlertTriangle"]')).toBeNull();
      expect(
        trigger.querySelector('[data-slot="skeleton"], .bg-state-hover'),
      ).toBeNull();
      rerender(
        <PermissionModePicker
          pending={false}
          value="auto"
          options={permissionOptions}
          onChange={() => {}}
          supported
        />,
      );
      expect(screen.queryByText("Full Access")).toBeNull();
      expect(screen.queryByText("Accept Edits")).toBeNull();
      expect(screen.getByText("Approve")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Permission mode" }).querySelector('[data-icon="AlertTriangle"]')).toBeNull();
    },
  );

  it("keeps full access warning text in the standard picker shape", () => {
    render(
      <PermissionModePicker
        value="full"
        options={permissionOptions}
        onChange={() => {}}
        supported
      />,
    );
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.textContent).toContain("Full Access");
    expect(trigger.classList.contains("border-attention/60")).toBe(false);
    expect(trigger.classList.contains("text-warning-text")).toBe(true);
    expect(trigger.classList.contains("border-none")).toBe(true);
    expect(trigger.classList.contains("bg-attention")).toBe(false);
    expect(trigger.classList.contains("text-muted-foreground")).toBe(false);
    expect(trigger.querySelector('[data-icon="AlertTriangle"]')?.classList.contains("text-attention")).toBe(true);
  });

  it("uses the same approve vocabulary for compact and wide labels", () => {
    render(
      <PermissionModePicker
        pending={false}
        value="auto"
        options={permissionOptions}
        onChange={() => {}}
        supported
      />,
    );
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.classList.contains("w-28")).toBe(true);
    expect(trigger.textContent).toBe("Approve");
    expect(trigger.textContent).toContain("Approve");
    expect(trigger.textContent).not.toContain("Auto");
  });
  it("can show an effective display override without changing the selected value", () => {
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        pending
        value="full"
        options={[]}
        onChange={onChange}
        supported
        displayOverride={{
          label: "Plan Mode",
          compactLabel: "Plan",
          description:
            "Claude Code will plan without normal full-access execution.",
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.textContent).toContain("Plan Mode");
    expect(trigger.textContent).not.toContain("Full Access");
    expect(trigger.querySelector('[data-icon="AlertTriangle"]')).toBeNull();
  });
});

it.each([360, 390, 1280])("retains the last permission label and chevron while pending at %s", (width) => {
  window.innerWidth = width;
  const props = { options: permissionOptions, onChange: () => {}, supported: true };
  const view = render(<PermissionModePicker {...props} value="full" />);
  const before = screen.getByRole("button", { name: "Permission mode" });
  expect(before.textContent).toBe("Full Access");
  view.rerender(<PermissionModePicker {...props} value="auto" pending />);
  const pending = screen.getByRole("button", { name: "Permission mode" });
  expect(pending.textContent).toBe("Full Access");
  expect(pending.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
  expect(pending.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
});

it.each([360, 390, 1280])("keeps an unknown mode neutral and reserves its resolved width at %s", (width) => {
  window.innerWidth = width;
  const onChange = vi.fn();
  const view = render(<PermissionModePicker options={permissionOptions} pending onChange={onChange} supported />);
  const trigger = screen.getByRole("button", { name: "Permission mode" });
  expect(trigger.textContent).toBe("Permissions");
  expect(trigger.hasAttribute("disabled")).toBe(true);
  expect(trigger.classList.contains("w-28")).toBe(true);
  expect(trigger.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
  expect(trigger.querySelector('[data-icon="AlertTriangle"]')).toBeNull();
  expect(trigger.className).not.toContain("text-warning-text");
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<PermissionModePicker options={permissionOptions} value="full" onChange={onChange} supported />);
  const resolved = screen.getByRole("button", { name: "Permission mode" });
  expect(resolved.textContent).toBe("Full Access");
  expect(resolved.classList.contains("w-28")).toBe(true);
  expect(resolved.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
  view.rerender(<PermissionModePicker options={[]} pending onChange={onChange} supported />);
  const pending = screen.getByRole("button", { name: "Permission mode" });
  expect(pending.textContent).toBe("Full Access");
  expect(pending.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
});

it.each(["full", "accept-edits", "auto"] as const)("owns the full-access cue for %s independently of option tones", (value) => {
  render(<PermissionModePicker options={permissionOptions.map(({ value, label }) => ({ value, label }))} value={value} onChange={() => {}} supported />);
  const trigger = screen.getByRole("button", { name: "Permission mode" });
  expect(trigger.querySelector('[data-icon="AlertTriangle"]') !== null).toBe(value === "full");
  expect(trigger.className.includes("text-warning-text")).toBe(value === "full");
});
