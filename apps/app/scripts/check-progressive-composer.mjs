import assert from "node:assert/strict";

async function geometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-progressive-composer]");
    const plain = root.querySelector("textarea");
    const editor = plain ?? root.querySelector("[contenteditable=true]");
    const rect = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const font = getComputedStyle(editor);
    let caret;
    let selection;
    if (plain) {
      const mirror = document.createElement("div");
      for (const key of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "lineHeight",
        "letterSpacing",
        "textIndent",
        "wordSpacing",
        "overflowWrap",
        "wordBreak",
        "tabSize",
      ])
        mirror.style[key] = font[key];
      Object.assign(mirror.style, {
        position: "fixed",
        left: `${rect(plain).x}px`,
        top: `${rect(plain).y - plain.scrollTop}px`,
        width: `${plain.clientWidth}px`,
        whiteSpace: "pre-wrap",
        visibility: "hidden",
        margin: "0",
        padding: "0",
        border: "0",
      });
      const head =
        plain.selectionDirection === "backward"
          ? plain.selectionStart
          : plain.selectionEnd;
      const text = document.createTextNode(plain.value);
      mirror.append(text);
      document.body.append(mirror);
      const range = document.createRange();
      range.setStart(text, head);
      range.collapse(true);
      caret = rect(range);
      mirror.remove();
      selection = {
        anchor:
          plain.selectionDirection === "backward"
            ? plain.selectionEnd
            : plain.selectionStart,
        head,
      };
    } else {
      const native = window.getSelection();
      const range = document.createRange();
      range.setStart(native.focusNode, native.focusOffset);
      range.collapse(true);
      caret = rect(range);
      const offset = (node, position) => {
        const prefix = document.createRange();
        prefix.selectNodeContents(editor);
        prefix.setEnd(node, position);
        return prefix.toString().length;
      };
      selection = {
        anchor: offset(native.anchorNode, native.anchorOffset),
        head: offset(native.focusNode, native.focusOffset),
      };
    }
    return {
      phase: root.dataset.progressiveComposer,
      form: rect(root.querySelector("form")),
      scroll: rect(root.querySelector("[data-promptbox-editor-scroll]")),
      editor: rect(editor),
      actions: rect(root.querySelector("[data-promptbox-action-row]")),
      submit: rect(root.querySelector("[data-promptbox-submit-group] button")),
      textMetrics: Object.fromEntries(
        [
          "fontFamily",
          "fontSize",
          "fontWeight",
          "lineHeight",
          "letterSpacing",
        ].map((key) => [key, font[key]]),
      ),
      focused: document.activeElement === editor,
      text: plain ? plain.value : editor.textContent,
      selection,
      caret,
    };
  });
}

export async function checkProgressiveComposer(
  page,
  base,
  {
    width = 1280,
    height = 800,
    text = "hello @world /plan",
    anchor = 12,
    head = 6,
  } = {},
) {
  await page.setViewportSize({ width, height });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const matches = (url) =>
    /\/(?:__p25\/plugins|api\/v1\/plugins)\/bb--composer\/(?:assets\/)?app\.js$/.test(
      url.pathname,
    );
  const hold = async (route) => {
    await gate;
    await route.continue();
  };
  await page.route(matches, hold);
  try {
    await page.goto(`${base}/`, { waitUntil: "commit" });
    await page.waitForSelector("[data-sidebar-thread-id]");
    const input = page.locator("[data-progressive-composer=plain] textarea");
    await input.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await input.fill(text);
    await input.evaluate(
      (element, { anchor, head }) => {
        element.focus();
        element.setSelectionRange(
          Math.min(anchor, head),
          Math.max(anchor, head),
          anchor > head ? "backward" : "forward",
        );
      },
      { anchor, head },
    );
    const before = await geometry(page);
    release();
    await page.waitForSelector(
      "[data-progressive-composer=rich] [contenteditable=true]",
    );
    const after = await geometry(page);
    assert.equal(before.phase, "plain");
    assert.equal(after.phase, "rich");
    assert.equal(after.text, text);
    assert.equal(after.focused, true);
    assert.deepEqual(after.selection, { anchor, head });
    assert.deepEqual(after.textMetrics, before.textMetrics);
    for (const key of ["form", "scroll", "editor", "actions", "submit"]) {
      for (const dimension of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(before[key][dimension] - after[key][dimension]) <= 0.5,
          `${width}px ${key}.${dimension}: ${before[key][dimension]} -> ${after[key][dimension]}`,
        );
    }
    for (const dimension of text.length ? ["x", "y", "height"] : [])
      assert.ok(
        Math.abs(before.caret[dimension] - after.caret[dimension]) <= 0.5,
        `${width}px caret.${dimension}: ${before.caret[dimension]} -> ${after.caret[dimension]}`,
      );
    return { width, height, before, after };
  } finally {
    release();
    await page.unroute(matches, hold);
  }
}
