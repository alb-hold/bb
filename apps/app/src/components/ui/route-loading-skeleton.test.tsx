import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RouteLoadingSkeleton } from "./route-loading-skeleton";
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
  resetSidebarBootstrapCacheForTest();
});

function renderSkeleton(isBoundedPane: boolean) {
  const markup = renderToStaticMarkup(
    <RouteLoadingSkeleton isBoundedPane={isBoundedPane} />,
  );
  const match = markup.match(
    /^<div class="([^"]*)"[^>]*data-testid="route-loading-skeleton"[^>]*><div class="([^"]*)"/,
  );
  return {
    skeleton: match?.[1]?.split(" ") ?? [],
    header: match?.[2]?.split(" ") ?? [],
  };
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

    expect(skeleton).toEqual(
      expect.arrayContaining(["-mx-4", "-mt-4", "md:-mx-5", "md:-mt-5"]),
    );
    expect(header).toContain("pl-12");
  });

  it("keeps bounded-pane placeholders inside their pane", () => {
    const { skeleton, header } = renderSkeleton(true);

    expect(skeleton).toContain("flex");
    for (const token of ["-mx-4", "-mt-4", "md:-mx-5", "md:-mt-5"]) {
      expect(skeleton).not.toContain(token);
    }
    expect(header).toContain("px-4");
    expect(header).not.toContain("pl-12");
  });
});
