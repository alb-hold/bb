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
  it.each(["full", "accept-edits", "auto"] as const)(
    "keeps provisional %s neutral until the effective permission resolves",
    (value) => {
      const { rerender } = render(
        <PermissionModePicker
          pending
          value={value}
          options={permissionOptions}
          onChange={() => {}}
          supported
        />,
      );
      const trigger = screen.getByRole("button", { name: "Permission mode" });
      expect(trigger.textContent).toBe(({ full: "Full Access", "accept-edits": "Edits", auto: "Approve" }[value]));
      expect(trigger.hasAttribute("disabled")).toBe(true);
      expect(trigger.className).not.toContain("warning");
      expect(
        trigger.querySelector('[data-slot="skeleton"], .bg-state-hover'),
      ).toBeNull();
      rerender(
        <PermissionModePicker
          value="auto"
          options={permissionOptions}
          onChange={() => {}}
          supported
        />,
      );
      expect(screen.queryByText("Full Access")).toBeNull();
      expect(screen.queryByText("Accept Edits")).toBeNull();
      expect(screen.getByText("Approve")).not.toBeNull();
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
    expect(trigger.classList.contains("w-28")).toBe(false);
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
  });
});

it.each([360, 390, 1280])("retains the last permission label and chevron while pending at %s", (width) => {
  window.innerWidth = width;
  const props = { options: permissionOptions, onChange: () => {}, supported: true };
  const view = render(<PermissionModePicker {...props} value="full" />);
  const before = screen.getByRole("button", { name: "Permission mode" });
  expect(before.textContent).toBe("Full Access");
  view.rerender(<PermissionModePicker {...props} pending />);
  const pending = screen.getByRole("button", { name: "Permission mode" });
  expect(pending.textContent).toBe("Full Access");
  expect(pending.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
});

it("uses the default permission label and chevron before the first value", () => {
  render(<PermissionModePicker options={[]} pending onChange={() => {}} supported />);
  const trigger = screen.getByRole("button", { name: "Permission mode" });
  expect(trigger.textContent).toBe("Approve");
  expect(trigger.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
});
