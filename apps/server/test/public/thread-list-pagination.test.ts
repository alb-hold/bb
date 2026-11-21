import { threads } from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { threadListResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

describe("thread list continuation", () => {
  it("returns all matching SDK rows across tied page boundaries", async () => {
    await withTestHarness(async (harness) => {
      for (let i = 0; i < 215; i++) {
        harness.db
          .insert(threads)
          .values({
            id: `thr_paging_${i}`,
            projectId: PERSONAL_PROJECT_ID,
            providerId: "codex",
            status: "idle",
            createdAt: 100,
            updatedAt: 100,
            pinnedAt: i < 120 ? 1 : null,
            pinSortKey: i < 120 ? "V" : null,
            archivedAt: i % 2 === 0 ? 50 : null,
            visibility: i % 7 === 0 ? "hidden" : "visible",
          })
          .run();
      }
      const paths: URL[] = [];
      const sdk = createBbSdk({
        transport: createHttpTransport({
          baseUrl: "http://localhost",
          runtime: "node",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            paths.push(new URL(request.url));
            return harness.app.fetch(request);
          },
        }),
      });
      for (const filter of [{}, { includeHidden: true, archived: true }]) {
        const params = new URLSearchParams();
        if (filter.includeHidden) params.set("includeHidden", "true");
        if (filter.archived) params.set("archived", "true");
        const response = await harness.app.request(`/api/v1/threads?${params}`);
        const expected = threadListResponseSchema.parse(await response.json());
        paths.length = 0;
        const result = await sdk.threads.list(filter);
        expect(result.map((row) => row.id)).toEqual(
          expected.map((row) => row.id),
        );
        expect(paths.length).toBeGreaterThan(1);
        expect(paths.every((path) => path.searchParams.has("limit"))).toBe(
          true,
        );
        expect(paths[1]?.searchParams.has("cursor")).toBe(true);
      }
      expect(
        (await harness.app.request("/api/v1/threads?limit=1&cursor=invalid"))
          .status,
      ).toBe(400);
    });
  });
});
