// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionModePicker } from "./PermissionModePicker";

const permissionOptions = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
] as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PermissionModePicker", () => {
  it("shows the stored permission with actions disabled until its options resolve", () => {
    render(
      <PermissionModePicker
        pending
        value="full"
        options={[]}
        onChange={() => {}}
        supported
      />,
    );
    expect(screen.getByText("Full Access")).not.toBeNull();
    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.textContent).toContain("Full Access");
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(
      trigger.querySelector('[data-slot="skeleton"], .bg-state-hover'),
    ).toBeNull();
  });

  it("keeps full access legible with a quiet warning outline", () => {
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
    expect(trigger.classList.contains("border-warning-text/30")).toBe(true);
    expect(trigger.classList.contains("!text-muted-foreground")).toBe(true);
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
    expect(trigger.textContent).toContain("Approve for me");
    expect(trigger.textContent).toContain("Approve");
    expect(trigger.textContent).not.toContain("Auto");
  });
  it("can show an effective display override without changing the selected value", () => {
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        value="full"
        options={permissionOptions}
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
