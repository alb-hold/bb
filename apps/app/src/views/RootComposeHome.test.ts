import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RootComposeHome } from "./RootComposeHome";

it("starts phone Recent at the header without a leading spacer", () => {
  const markup = renderToStaticMarkup(
    createElement(RootComposeHome, {
      isCompact: true,
      composer: "Composer",
      compactScrollContent: "Recent",
      homepageSections: null,
    }),
  );
  expect(markup).not.toContain("leading-spacer");
  expect(markup).not.toContain("justify-end");
  expect(markup).toContain("top:56px");
});
