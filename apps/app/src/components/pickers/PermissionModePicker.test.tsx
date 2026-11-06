// @vitest-environment jsdom
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

it("reserves the same desktop width while defaults and capabilities settle", () => {
  const onChange = vi.fn();
  const view = render(<PermissionModePicker value="auto" options={[]} pending supported showChevronWhenDisabled={false} onChange={onChange} />);
  const assertWidth = () => expect(screen.getByRole("button", { name: "Permissions" }).classList.contains("w-44")).toBe(true);
  assertWidth();
  expect(screen.getByRole("button", { name: "Permissions" }).querySelector('[data-icon="ChevronDown"]')).toBeNull();
  view.rerender(<PermissionModePicker value="auto" options={options} supported showChevronWhenDisabled={false} onChange={onChange} />);
  assertWidth();
  expect(screen.getByRole("button", { name: "Permissions" }).textContent).toBe("Permissions:Approve");
  expect(screen.getByRole("button", { name: "Permissions" }).querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
  for (const value of ["full", "auto", "accept-edits"] as const) {
    view.rerender(<PermissionModePicker value={value} options={options} supported onChange={onChange} />);
    assertWidth();
  }
  view.rerender(<PermissionModePicker options={[]} pending supported onChange={onChange} />);
  assertWidth();
  expect(onChange).not.toHaveBeenCalled();
});

it.each(["auto", "accept-edits", "full"] as const)("names permissions and shows the shared shield for %s", (value) => {
  render(<PermissionModePicker value={value} options={options} supported onChange={() => {}} />);
  const trigger = screen.getByRole("button", { name: "Permissions" });
  expect(trigger.textContent).toBe(`Permissions:${value === "auto" ? "Approve" : value === "full" ? "Full Access" : "Edits"}`);
  expect(trigger.querySelector('[data-icon="SecurityCheck"]')).not.toBeNull();
  expect(trigger.querySelector('[data-icon="AlertTriangle"]')).toBeNull();
  expect(trigger.classList.contains("text-warning-text")).toBe(value === "full");
});

it("keeps cached values and chevrons during provider refresh without changing permissions", () => {
  const onChange = vi.fn();
  const view = render(<PermissionModePicker value="full" options={options} supported onChange={onChange} />);
  view.rerender(<PermissionModePicker value="auto" options={[]} pending supported onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Permissions" });
  expect(trigger.textContent).toBe("Permissions:Full Access");
  expect(trigger.hasAttribute("disabled")).toBe(true);
  expect(trigger.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it("uses the initial cached mode before options resolve", () => {
  render(<PermissionModePicker value="auto" options={[]} pending supported onChange={() => {}} />);
  expect(screen.getByRole("button", { name: "Permissions" }).textContent).toBe("Permissions:Approve");
});

it("reserves a skeleton when no cached mode exists", () => {
  render(<PermissionModePicker options={[]} pending supported onChange={() => {}} />);
  expect(screen.getByRole("button", { name: "Permissions" }).className).toContain("w-44");
  expect(screen.getByRole("button", { name: "Permissions" }).className).toContain("[&>span]:invisible");
});

it("preserves plan display overrides without changing selected permissions", () => {
  const onChange = vi.fn();
  render(<PermissionModePicker value="full" options={options} pending supported displayOverride={{ label: "Plan Mode" }} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Permissions" }).textContent).toBe("Permissions:Plan Mode");
  expect(onChange).not.toHaveBeenCalled();
});

it("opens the same options and applies a selected permission", async () => {
  const onChange = vi.fn();
  render(<PermissionModePicker value="auto" options={options} supported onChange={onChange} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Permissions" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Full Access/ }));
  expect(onChange).toHaveBeenCalledWith("full");
});

it.each([false, true])("hides unsupported and single-option controls (%s)", (supported) => {
  render(<PermissionModePicker value="auto" options={options.slice(0, 1)} supported={supported} onChange={() => {}} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it.each(["auto", "accept-edits", "full"] as const)("keeps the mobile %s trigger compact, named and warning-aware", (value) => {
  render(<CompactViewportOverrideProvider isCompactViewport><PermissionModePicker value={value} options={options} supported onChange={() => {}} /></CompactViewportOverrideProvider>);
  const mode = value === "auto" ? "Approve" : value === "full" ? "Full Access" : "Edits";
  const trigger = screen.getByRole("button", { name: `Permissions: ${mode}` });
  expect(trigger.textContent).toBe("");
  expect(trigger.getAttribute("data-compact-touch")).toBe("picker");
  expect(trigger.classList.contains("min-w-28")).toBe(false);
  expect(trigger.classList.contains("w-44")).toBe(false);
  expect(trigger.querySelector('[data-icon="SecurityCheck"]')).not.toBeNull();
  expect(trigger.classList.contains("text-warning-text")).toBe(value === "full");
});
