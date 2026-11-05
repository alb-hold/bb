import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const captures = JSON.parse(readFileSync(process.argv[2], "utf8"));

for (const width of [360, 390]) {
  test(`home actions align without overlapping at ${width}px`, () => {
    const capture = captures.metrics.find((entry) => entry.width === width && Array.isArray(entry.header) && Array.isArray(entry.panelButtons));
    assert.ok(capture, `Missing ${width}px capture`);
    const newThread = capture.header.find((entry) => entry.box.width > 0)?.box;
    const panel = capture.panelButtons.find(
      (entry) => /show right panel/i.test(entry.name) && entry.box.width > 0,
    )?.box;
    assert.ok(newThread, "Missing New thread button");
    assert.ok(panel, "Missing right panel button");
    assert.equal(newThread.width, 44);
    assert.equal(newThread.height, 44);
    assert.equal(panel.width, 44);
    assert.equal(panel.height, 44);
    assert.ok(Math.abs(panel.y - newThread.y) < 0.5, "Unequal button tops");
    assert.ok(
      Math.abs(panel.y + panel.height / 2 - newThread.y - newThread.height / 2) < 0.5,
      "Unequal icon centers",
    );
    assert.ok(panel.x - newThread.right >= 4, "Less than 4px between hit areas");
  });
}
