// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ComposerMention } from "@get-bb/plugin-sdk/app";
import {
  arePromptEditorValuesEqual,
  suppressPromptEditorAnchorActivation,
} from "./PromptBoxInternal";

it("gives the primary voice action the same round shape as submit", () => {
  const source = readFileSync("src/PromptBoxInternal.tsx", "utf8");
  const primaryVoice = source.slice(
    source.indexOf(") : showVoiceAsPrimaryAction ? ("),
  );
  expect(
    primaryVoice.slice(0, primaryVoice.indexOf("</VoiceInputButton>")),
  ).toContain('"rounded-full transition-colors"');
});

function dispatchThroughEditorTarget({
  eventName,
  target,
}: {
  eventName: "auxclick" | "click";
  target: HTMLElement;
}) {
  const editorRoot = document.createElement("div");
  editorRoot.append(target);
  document.body.append(editorRoot);

  let suppressed = false;
  editorRoot.addEventListener(eventName, (event) => {
    suppressed = suppressPromptEditorAnchorActivation(event);
  });

  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
  });
  const defaultAllowed = target.dispatchEvent(event);

  editorRoot.remove();
  return { defaultAllowed, event, suppressed };
}

describe("suppressPromptEditorAnchorActivation", () => {
  it("cancels anchor clicks inside the prompt editor", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "https://example.com";

    const result = dispatchThroughEditorTarget({
      eventName: "click",
      target: anchor,
    });

    expect(result.suppressed).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.defaultAllowed).toBe(false);
  });

  it("cancels auxiliary anchor clicks inside the prompt editor", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "https://example.com";

    const result = dispatchThroughEditorTarget({
      eventName: "auxclick",
      target: anchor,
    });

    expect(result.suppressed).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.defaultAllowed).toBe(false);
  });

  it("does not cancel ordinary prompt editor clicks", () => {
    const span = document.createElement("span");
    span.textContent = "plain prompt text";

    const result = dispatchThroughEditorTarget({
      eventName: "click",
      target: span,
    });

    expect(result.suppressed).toBe(false);
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.defaultAllowed).toBe(true);
  });
});

describe("arePromptEditorValuesEqual", () => {
  it("compares cloned mention values without serializing the prompt text", () => {
    const mention: ComposerMention = {
      from: 4,
      to: 10,
      kind: "path",
      source: "workspace",
      entryKind: "file",
      path: "src/a.ts",
      label: "a.ts",
    };
    const left = { text: "see @a.ts", mentions: [mention] };

    expect(
      arePromptEditorValuesEqual(left, {
        text: left.text,
        mentions: [{ ...mention }],
      }),
    ).toBe(true);
    expect(
      arePromptEditorValuesEqual(left, {
        text: left.text,
        mentions: [{ ...mention, path: "src/b.ts" }],
      }),
    ).toBe(false);
  });

  it("treats a mention with reordered keys as the same mention", () => {
    const mention: ComposerMention = {
      from: 0,
      to: 5,
      kind: "plugin",
      pluginId: "sample",
      icon: null,
      provider: "people",
      id: "alice",
      label: "Alice",
    };
    const reordered: ComposerMention = {
      label: "Alice",
      id: "alice",
      provider: "people",
      icon: null,
      pluginId: "sample",
      kind: "plugin",
      to: 5,
      from: 0,
    };

    expect(
      arePromptEditorValuesEqual(
        { text: "Alice", mentions: [mention] },
        { text: "Alice", mentions: [reordered] },
      ),
    ).toBe(true);
  });
});

it("owns the single phone action row through stable composer slots", () => {
  const source = readFileSync("src/PromptBoxInternal.tsx", "utf8");
  const css = readFileSync("../../apps/app/src/app.css", "utf8");
  const pluginCss = readFileSync("src/composer.css", "utf8");
  expect(pluginCss).not.toContain('data-promptbox-execution-layout="stacked"');
  expect(source).toContain("data-promptbox-execution-layout=");
  expect(source).toContain('surface === "new-thread" && executionControls');
  for (const slot of [
    "leading-actions",
    "plus-control",
    "execution-controls",
    "trailing-actions",
  ]) {
    expect(source).toContain(`data-promptbox-${slot}=""`);
  }
  for (const [slot, column] of [
    ["plus-control", "1"],
    ["trailing-actions", "3"],
  ]) {
    const rule = css.match(
      new RegExp(`\\[data-promptbox-${slot}\\]\\s*\\{([^}]+)`),
    )?.[1];
    expect(rule).toContain(`grid-column: ${column}`);
    expect(rule).toContain("grid-row: 1");
  }
  expect(css).not.toContain('aria-label="Prompt actions"');
});

it("pins pending execution controls to one phone row in the eager stylesheet", () => {
  const css = readFileSync("../../apps/app/src/app.css", "utf8");
  const pluginCss = readFileSync("src/composer.css", "utf8");
  for (const slot of [
    "data-execution-controls-layout",
    "data-model-reasoning-trigger",
    "data-native-terminal-toggle",
  ]) {
    expect(pluginCss).not.toContain(slot);
  }
  for (const [selector, declarations] of [
    ['[data-execution-controls-layout="stacked"]', ["display: flex", "grid-column: 2", "grid-row: 1", "min-width: 0", "flex-wrap: nowrap", "gap: 0"]],
    ['[data-model-reasoning-trigger]', ["min-width: 0", "flex: 1 1 0%", "overflow: hidden"]],
    ['[data-native-terminal-toggle]', ["height: auto"]],
    ['[data-native-terminal-toggle] > button', ["height: 2.75rem", "min-width: 2.75rem"]],
  ] as const) {
    expect(css).toContain(selector + " {");
    const rule = css.slice(css.indexOf(selector + " {"));
    const body = rule.slice(0, rule.indexOf("}"));
    for (const declaration of declarations) expect(body).toContain(declaration);
  }
});
