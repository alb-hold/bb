import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { rewriteXtermFaint } from "../../vite-xterm-faint";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@xterm/xterm"), "utf8");

it("rewrites the exact installed terminal module", () => {
  const output = rewriteXtermFaint(source, "xterm.js", "6.1.0-beta.292");
  expect(output).not.toBe(source);
  expect(output).toContain("l.color.ensureContrastRatio(t,n,4.5)");
});
it("requires re-derivation on an xterm upgrade", () => {
  expect(() => rewriteXtermFaint(source, "xterm.js", "6.2.0")).toThrow(
    "re-derived or dropped",
  );
});
it("refuses missing and ambiguous source matches", () => {
  expect(() => rewriteXtermFaint("", "xterm.js", "6.1.0-beta.292")).toThrow(
    "matches=0",
  );
  expect(() =>
    rewriteXtermFaint(source + source, "xterm.js", "6.1.0-beta.292"),
  ).toThrow("matches=2");
});
