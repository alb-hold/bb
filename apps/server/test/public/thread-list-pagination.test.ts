import { projects, threads } from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import {
  sidebarBootstrapResponseSchema,
  threadListResponseSchema,
} from "@bb/server-contract";
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
            latestAttentionAt: 100,
            createdAt: 100,
            updatedAt: 100,
            pinnedAt: i < 120 ? 1 : null,
            pinSortKey: i < 120 ? "V" : null,
            archivedAt: i % 2 === 0 ? 50 : null,
            visibility: i % 7 === 0 ? "hidden" : "visible",
          })
          .run();
      }
      const route = "/api/v1/sidebar-bootstrap";
      const complete = sidebarBootstrapResponseSchema.parse(
        await (await harness.app.request(route)).json(),
      );
      const expectedIds = complete.personalProject.threads.map((row) => row.id);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: "23" });
        if (cursor !== null) params.set("cursor", cursor);
        const page = await harness.app.request(route + "?" + params);
        expect(page.status).toBe(200);
        const bootstrap = sidebarBootstrapResponseSchema.parse(
          await page.json(),
        );
        expect(bootstrap.personalProject.threads.length).toBeLessThanOrEqual(
          23,
        );
        ids.push(...bootstrap.personalProject.threads.map((row) => row.id));
        cursor = page.headers.get("X-BB-Next-Cursor");
        expect(ids.length).toBeLessThanOrEqual(expectedIds.length);
      } while (cursor !== null);
      expect(expectedIds.length).toBeGreaterThan(23);
      expect(ids).toEqual(expectedIds);
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
        const firstDefault = await harness.app.request(
          `/api/v1/threads?${params}`,
        );
        expect(firstDefault.status).toBe(200);
        expect(firstDefault.headers.get("X-BB-Pagination")).toBe("cursor");
        const firstDefaultText = await firstDefault.text();
        const firstDefaultRows = threadListResponseSchema.parse(
          JSON.parse(firstDefaultText),
        );
        expect(firstDefaultRows.length).toBe(100);
        expect(firstDefault.headers.get("X-BB-Next-Cursor")).toBeTruthy();

        const walkedIds: string[] = [];
        let listCursor: string | null = null;
        let totalWalkBytes = 0;
        do {
          const pageParams = new URLSearchParams(params);
          if (listCursor !== null) pageParams.set("cursor", listCursor);
          const pageRes = await harness.app.request(
            `/api/v1/threads?${pageParams}`,
          );
          expect(pageRes.status).toBe(200);
          expect(pageRes.headers.get("X-BB-Pagination")).toBe("cursor");
          const pageText = await pageRes.text();
          totalWalkBytes += Buffer.byteLength(pageText, "utf8");
          const pageRows = threadListResponseSchema.parse(JSON.parse(pageText));
          expect(pageRows.length).toBeLessThanOrEqual(100);
          walkedIds.push(...pageRows.map((row) => row.id));
          listCursor = pageRes.headers.get("X-BB-Next-Cursor");
        } while (listCursor !== null);
        expect(new Set(walkedIds).size).toBe(walkedIds.length);
        expect(walkedIds.length).toBeGreaterThan(100);
        expect(Buffer.byteLength(firstDefaultText, "utf8")).toBeLessThan(
          totalWalkBytes,
        );

        paths.length = 0;
        const result = await sdk.threads.list(filter);
        expect(result.map((row) => row.id)).toEqual(walkedIds);
        expect(paths.length).toBeGreaterThan(1);
        expect(paths.every((path) => path.searchParams.has("limit"))).toBe(
          true,
        );
        expect(paths[1]?.searchParams.has("cursor")).toBe(true);
        const summaries = await sdk.threads.experimental_listSummaries(filter);
        expect(summaries.map((row) => row.id)).toEqual(walkedIds);
        expect(summaries[0]).not.toHaveProperty("environmentPath");
        expect(summaries[0]).toMatchObject({
          title: result[0]?.title,
          status: result[0]?.status,
          listIndicator: result[0]?.listIndicator,
        });
      }
      expect(
        (await harness.app.request("/api/v1/threads?limit=1&cursor=invalid"))
          .status,
      ).toBe(400);
      expect(
        (await harness.app.request("/api/v1/threads?cursor=invalid")).status,
      ).toBe(400);
      expect(
        (await harness.app.request("/api/v1/threads?cursor=abc&offset=1"))
          .status,
      ).toBe(400);
    });
  });

  it("paginates sidebar-bootstrap globally across projects in chronological order and includes page-1 descendants in overview", async () => {
    await withTestHarness(async (harness) => {
      for (const projectId of ["proj_real_1", "proj_real_2", "proj_real_3"]) {
        harness.db
          .insert(projects)
          .values({
            id: projectId,
            kind: "standard",
            name: projectId,
            createdAt: 1,
            updatedAt: 1,
          })
          .run();
      }
      const projectIds = [
        PERSONAL_PROJECT_ID,
        "proj_real_1",
        "proj_real_2",
        "proj_real_3",
      ];
      for (let i = 0; i < 20; i++) {
        harness.db
          .insert(threads)
          .values({
            id: `thr_personal_old_${String(i).padStart(2, "0")}`,
            projectId: PERSONAL_PROJECT_ID,
            providerId: "codex",
            status: "idle",
            latestAttentionAt: 100 - i,
            createdAt: 100 - i,
            updatedAt: 100 - i,
          })
          .run();
      }
      for (let i = 0; i < 8; i++) {
        const ts = 5000 - i * 10;
        harness.db
          .insert(threads)
          .values({
            id: `thr_global_${i}`,
            projectId: projectIds[i % projectIds.length]!,
            providerId: "codex",
            status: i === 2 ? "active" : "idle",
            latestAttentionAt: ts,
            createdAt: ts,
            updatedAt: ts,
            pinnedAt: i === 7 ? 1 : null,
            pinSortKey: i === 7 ? "a" : null,
          })
          .run();
      }
      harness.db
        .insert(threads)
        .values({
          id: "thr_real_3_bumped",
          projectId: "proj_real_3",
          providerId: "codex",
          status: "idle",
          latestAttentionAt: 9000,
          createdAt: 50,
          updatedAt: 9000,
        })
        .run();
      harness.db
        .insert(threads)
        .values({
          id: "thr_child_of_global_1",
          projectId: "proj_real_1",
          parentThreadId: "thr_global_1",
          providerId: "codex",
          status: "idle",
          latestAttentionAt: 10,
          createdAt: 10,
          updatedAt: 10,
        })
        .run();

      const firstPageRes = await harness.app.request(
        "/api/v1/sidebar-bootstrap?limit=6&overview=true",
      );
      expect(firstPageRes.status).toBe(200);
      const firstPage = sidebarBootstrapResponseSchema.parse(
        await firstPageRes.json(),
      );
      const firstPageIds = [
        ...firstPage.personalProject.threads,
        ...firstPage.projects.flatMap((project) => project.threads),
      ].map((row) => row.id);
      expect(new Set(firstPageIds)).toEqual(
        new Set([
          "thr_global_7",
          "thr_global_2",
          "thr_real_3_bumped",
          "thr_global_0",
          "thr_global_1",
          "thr_global_3",
        ]),
      );
      expect(firstPage.overview?.descendants?.map((row) => row.id)).toEqual([
        "thr_child_of_global_1",
      ]);

      const complete = sidebarBootstrapResponseSchema.parse(
        await (await harness.app.request("/api/v1/sidebar-bootstrap")).json(),
      );
      const expectedByProject = new Map<string, string[]>([
        [
          PERSONAL_PROJECT_ID,
          complete.personalProject.threads.map((row) => row.id),
        ],
        ...complete.projects.map(
          (project) => [project.id, project.threads.map((row) => row.id)] as const,
        ),
      ]);

      const pagedByProject = new Map<string, string[]>();
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        const params = new URLSearchParams({ limit: "6" });
        if (cursor !== null) params.set("cursor", cursor);
        const res = await harness.app.request(
          "/api/v1/sidebar-bootstrap?" + params,
        );
        expect(res.status).toBe(200);
        const body = sidebarBootstrapResponseSchema.parse(await res.json());
        for (const project of [body.personalProject, ...body.projects]) {
          const bucket = pagedByProject.get(project.id) ?? [];
          bucket.push(...project.threads.map((row) => row.id));
          pagedByProject.set(project.id, bucket);
        }
        cursor = res.headers.get("X-BB-Next-Cursor");
        pageCount += 1;
      } while (cursor !== null);

      expect(pageCount).toBeGreaterThan(1);
      expect(pagedByProject).toEqual(expectedByProject);
    });
  });

  it("returns all 250 seeded threads each once when sdk.threads.list is called without a limit", async () => {
    await withTestHarness(async (harness) => {
      const expectedIds: string[] = [];
      for (let i = 0; i < 250; i++) {
        const id = `thr_sdk_all_${String(i).padStart(3, "0")}`;
        expectedIds.push(id);
        harness.db
          .insert(threads)
          .values({
            id,
            projectId: PERSONAL_PROJECT_ID,
            providerId: "codex",
            status: "idle",
            latestAttentionAt: 10_000 - (i % 40),
            createdAt: 1_000 + i,
            updatedAt: 10_000 - (i % 40),
          })
          .run();
      }

      const requests: URL[] = [];
      const sdk = createBbSdk({
        transport: createHttpTransport({
          baseUrl: "http://localhost",
          runtime: "node",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            requests.push(new URL(request.url));
            return harness.app.fetch(request);
          },
        }),
      });

      const rows = await sdk.threads.list();
      const ids = rows.map((row) => row.id);

      expect(rows).toHaveLength(250);
      expect(new Set(ids).size).toBe(250);
      expect(new Set(ids)).toEqual(new Set(expectedIds));
      expect(requests).toHaveLength(3);
    });
  });

  it("returns all 150 childThreads from sdk.status.get when a parent has more than one page of children", async () => {
    await withTestHarness(async (harness) => {
      harness.db
        .insert(threads)
        .values({
          id: "thr_status_parent",
          projectId: PERSONAL_PROJECT_ID,
          providerId: "codex",
          status: "active",
          latestAttentionAt: 20_000,
          createdAt: 20_000,
          updatedAt: 20_000,
        })
        .run();

      const expectedChildIds: string[] = [];
      for (let i = 0; i < 150; i++) {
        const id = `thr_status_child_${String(i).padStart(3, "0")}`;
        expectedChildIds.push(id);
        harness.db
          .insert(threads)
          .values({
            id,
            projectId: PERSONAL_PROJECT_ID,
            parentThreadId: "thr_status_parent",
            providerId: "codex",
            status: "idle",
            latestAttentionAt: 15_000 - (i % 30),
            createdAt: 2_000 + i,
            updatedAt: 15_000 - (i % 30),
          })
          .run();
      }

      const requests: URL[] = [];
      const sdk = createBbSdk({
        transport: createHttpTransport({
          baseUrl: "http://localhost",
          runtime: "node",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            requests.push(new URL(request.url));
            return harness.app.fetch(request);
          },
        }),
      });

      const status = await sdk.status.get({
        projectId: PERSONAL_PROJECT_ID,
        threadId: "thr_status_parent",
      });

      expect(status.thread?.id).toBe("thr_status_parent");
      expect(status.childThreads).toHaveLength(150);
      const childIds = (status.childThreads ?? []).map((row) => row.id);
      expect(new Set(childIds).size).toBe(150);
      expect(new Set(childIds)).toEqual(new Set(expectedChildIds));
    });
  });

  it("returns 50 rows in a single page request when sdk.threads.list receives limit 50", async () => {
    await withTestHarness(async (harness) => {
      for (let i = 0; i < 150; i++) {
        harness.db
          .insert(threads)
          .values({
            id: `thr_sdk_limited_${String(i).padStart(3, "0")}`,
            projectId: PERSONAL_PROJECT_ID,
            providerId: "codex",
            status: "idle",
            latestAttentionAt: 5_000 - i,
            createdAt: 5_000 - i,
            updatedAt: 5_000 - i,
          })
          .run();
      }

      const requests: URL[] = [];
      const sdk = createBbSdk({
        transport: createHttpTransport({
          baseUrl: "http://localhost",
          runtime: "node",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            requests.push(new URL(request.url));
            return harness.app.fetch(request);
          },
        }),
      });

      const rows = await sdk.threads.list({ limit: 50 });

      expect(rows).toHaveLength(50);
      expect(new Set(rows.map((row) => row.id)).size).toBe(50);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.searchParams.get("limit")).toBe("50");
      expect(requests[0]?.searchParams.has("cursor")).toBe(false);
    });
  });
});
