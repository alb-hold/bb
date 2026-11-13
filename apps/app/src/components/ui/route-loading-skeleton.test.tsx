import { renderToStaticMarkup } from "react-dom/server";
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";


import { afterEach, describe, expect, it } from "vitest";

import { RouteLoadingSkeleton } from "./route-loading-skeleton";


const STANDALONE_BLEED_CLASSES = ["-mx-4", "-mt-4", "md:-mx-5", "md:-mt-5"];

import {
  writeCachedSidebarBootstrap,
  resetSidebarBootstrapCacheForTest,
} from "@/lib/sidebar-bootstrap-cache";

import {
  makeSidebarBootstrapResponse,
  makeProjectWithThreadsResponse,
} from "@/test/fixtures/projects";

import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";


afterEach(() => {
  cleanup();
  resetSidebarBootstrapCacheForTest();
});


function renderSkeleton(isBoundedPane: boolean) {
  render(<RouteLoadingSkeleton isBoundedPane={isBoundedPane} />);
  const skeleton = screen.getByRole("status", { name: "Loading" });
  const header = skeleton.firstElementChild;
  if (header === null) throw new Error("Skeleton header row is missing");
  return { skeleton: skeleton.classList, header: header.classList };
}


describe("RouteLoadingSkeleton", () => {
  it("renders cached Recent titles in its first root-compose frame", () => {
    writeCachedSidebarBootstrap(
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            threads: [
              makeThreadListEntry({
                id: "old",
                title: "Older thread",
                latestAttentionAt: 1,
              }),
              makeThreadListEntry({
                id: "new",
                title: "Newest thread",
                latestAttentionAt: 2,
              }),
              makeThreadListEntry({
                id: "archived",
                title: "Archived thread",
                archivedAt: 1,
              }),
            ],
          }),
        ],
      }),
    );
    const markup = renderToStaticMarkup(
      <RouteLoadingSkeleton isBoundedPane={false} variant="root-compose" />,
    );
    expect(markup).toContain("Recent");
    expect(markup).toContain("Newest thread");
    expect(markup.indexOf("Newest thread")).toBeLessThan(
      markup.indexOf("Older thread"),
    );
    expect(markup).not.toContain("Archived thread");
    expect(
      renderToStaticMarkup(<RouteLoadingSkeleton isBoundedPane={false} />),
    ).not.toContain("Newest thread");
  });


  it("leaves Recent absent when no bootstrap was cached", () => {
    expect(
      renderToStaticMarkup(
        <RouteLoadingSkeleton isBoundedPane={false} variant="root-compose" />,
      ),
    ).not.toContain("Recent");
  });

  it("bleeds through standalone page padding", () => {
    const { skeleton, header } = renderSkeleton(false);

    for (const token of STANDALONE_BLEED_CLASSES) {
      expect(skeleton.contains(token), token).toBe(true);
    }
    expect(header.contains("pl-12")).toBe(true);
  });


  it("keeps bounded-pane placeholders inside their pane", () => {
    const { skeleton, header } = renderSkeleton(true);

    expect(skeleton.contains("flex")).toBe(true);
    for (const token of STANDALONE_BLEED_CLASSES) {
      expect(skeleton.contains(token), token).toBe(false);
    }
    expect(header.contains("px-4")).toBe(true);
    expect(header.contains("pl-12")).toBe(false);
  });
});
