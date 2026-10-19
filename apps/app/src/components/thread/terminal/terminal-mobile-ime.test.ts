// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { suppressDuplicateTerminalCompositionInput } from "./terminal-mobile-input";

describe("mobile terminal IME input", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("forwards committed composition text once when Chromium emits insertText", async () => {
    const root = document.createElement("div");
    const textarea = document.createElement("textarea");
    root.append(textarea);
    document.body.append(root);
    const forwarded: string[] = [];
    textarea.addEventListener("compositionend", (event) => {
      forwarded.push((event as CompositionEvent).data);
    });
    textarea.addEventListener("input", (event) => {
      forwarded.push((event as InputEvent).data ?? "");
    });
    const subscription = suppressDuplicateTerminalCompositionInput(root);

    textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
    );
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "日本語",
        bubbles: true,
        composed: true,
      }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", {
        data: "日本語",
        inputType: "insertText",
        bubbles: true,
        composed: true,
      }),
    );

    expect(forwarded).toEqual(["日本語"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    textarea.dispatchEvent(
      new InputEvent("input", {
        data: "日本語",
        inputType: "insertText",
        bubbles: true,
        composed: true,
      }),
    );
    expect(forwarded).toEqual(["日本語", "日本語"]);
    subscription.dispose();
  });
});
