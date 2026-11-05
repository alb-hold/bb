import { expect, it } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

const readers = [
  "get",
  "list",
  "search",
  "status",
  "pin",
  "unpin",
  "update",
  "markRead",
  "markUnread",
  "reorderPinned",
] as const;
it.each(
  readers.flatMap((reader) =>
    [false, true].map((clean) => ({ reader, clean })),
  ),
)(
  "projects clean=$clean consistently for $reader SDK and plugin readers",
  async ({ reader, clean }) => {
    const thread = {
      id: "thread-exited",
      status: "error",
      projectId: "project",
      parentThreadId: null,
      runtime: {
        displayStatus: "error",
        ...(clean ? { nativeSessionExit: "clean" } : {}),
      },
    };
    const group = { total: 1, results: [{ thread, matches: [] }] };
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch: async (input) => {
          const path = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input
                : input.url,
          ).pathname;
          return Response.json(
            path === "/api/v1/threads/search"
              ? { active: group, archived: group }
              : path === "/api/v1/threads" || path.endsWith("/pin-order")
                ? [thread]
                : path.endsWith("/timeline")
                  ? {}
                  : thread,
          );
        },
      }),
    });
    const expected = {
      status: clean ? "idle" : "error",
      runtime: {
        displayStatus: clean ? "idle" : "error",
        ...(clean ? { nativeSessionExit: "clean" } : {}),
      },
    };
    const args = { threadId: thread.id };
    if (reader === "status") {
      expect(await sdk.status.get(args)).toMatchObject({
        thread: { status: expected.status },
        childThreads: [expected],
      });
    } else if (reader === "search") {
      expect(await sdk.threads.search({ query: "exit" })).toMatchObject({
        active: { results: [{ thread: expected }] },
        archived: { results: [{ thread: expected }] },
      });
    } else if (reader === "list") {
      expect(await sdk.threads.list()).toMatchObject([expected]);
    } else if (reader === "reorderPinned") {
      expect(
        await sdk.threads.reorderPinned({
          ...args,
          previousThreadId: null,
          nextThreadId: null,
        }),
      ).toMatchObject([expected]);
    } else if (reader === "update") {
      expect(
        await sdk.threads.update({ ...args, title: "updated" }),
      ).toMatchObject(expected);
    } else {
      expect(await sdk.threads[reader](args)).toMatchObject(expected);
    }
  },
);
