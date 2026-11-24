// @vitest-environment jsdom
import { expect, it } from "vitest";
import { RECENT_THREAD_COLLAPSE_CLASS } from "./RootComposeRecentRows";

it("keeps parent recent-row collapse targets at 44x44 while matching the 16px leaf icon column", () => {
  const classes = RECENT_THREAD_COLLAPSE_CLASS.split(/\s+/u);
  expect(classes).toContain("h-11");
  expect(classes).toContain("w-11");
  expect(classes).toContain("-ml-6");
  expect(classes).toContain("pl-6");
  expect(classes).toContain("-mr-1");
  expect(classes).not.toContain("w-13");
});
