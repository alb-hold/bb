import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SlowDbQueryLogFields,
  ThreadListClientKind,
  ThreadListRequestShape,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { describe, expect, it } from "vitest";
import { createPluginRpcCallerRegistry } from "../../src/services/plugins/plugin-rpc-caller.js";
import { initDb } from "../../src/db.js";
import {
  createTestAppHarness,
  installTestBuiltinPlugin,
  testLogger,
} from "../helpers/test-app.js";

interface CapturedSlowQuery {
  fields: SlowDbQueryLogFields & {
    clientKind?: ThreadListClientKind;
    requestShape?: ThreadListRequestShape;
  };
  message: string;
}

describe("thread list slow query attribution", () => {
  it("records normalized query shape and existing client headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-thread-list-log-"));
    const records: CapturedSlowQuery[] = [];
    const logger = {
      ...testLogger,
      info(...args: Parameters<Logger["info"]>): void {
        const fields = args[0];
        const message = args[1];
        if (
          message === "Slow DB query" &&
          typeof fields === "object" &&
          fields !== null
        ) {
          records.push({
            fields: fields as CapturedSlowQuery["fields"],
            message,
          });
        }
      },
      warn(): void {},
    };
    const db = initDb(join(directory, "bb.db"), {
      logger,
      slowQueryThresholdMs: 0,
    });
    const harness = await createTestAppHarness({ db });
    try {
      const cases = [
        {
          headers: { "user-agent": "node" },
          expectedClientKind: { appSurface: "api", userAgentKind: "node" },
        },
        {
          headers: {
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
            "x-bb-app-surface": "web",
          },
          expectedClientKind: { appSurface: "web", userAgentKind: "browser" },
        },
      ] as const;

      for (const testCase of cases) {
        records.length = 0;
        const response = await harness.app.request(
          "/api/v1/threads?includeHidden=true&limit=7&offset=2",
          { headers: testCase.headers },
        );
        expect(response.status).toBe(200);
        const record = records.find(
          (entry) => entry.fields.eventLoopWork === "GET /api/v1/threads",
        );
        expect(record).toBeDefined();
        expect(record?.fields).toMatchObject({
          clientKind: testCase.expectedClientKind,
          requestShape: {
            archived: "absent",
            filters: [],
            includeHidden: true,
            limit: 7,
            offset: 2,
          },
        });
      }

      await installTestBuiltinPlugin(harness, "keep-awake");
      const pluginCallers = createPluginRpcCallerRegistry();
      const callerCredential = pluginCallers.issue("keep-awake");
      const callerToken = callerCredential.token;
      harness.pluginService.resolveRpcCaller = pluginCallers.resolve;
      for (const [token, expectedPluginId] of [
        [callerToken, "keep-awake"],
        ["not-a-real-plugin-caller-token", undefined],
      ] as const) {
        records.length = 0;
        const response = await harness.app.request(
          "/api/v1/threads?includeHidden=true",
          { headers: { "x-bb-plugin-caller": token, "user-agent": "node" } },
        );
        expect(response.status).toBe(200);
        const record = records.find(
          (entry) => entry.fields.eventLoopWork === "GET /api/v1/threads",
        );
        expect(record).toBeDefined();
        expect(record?.fields.clientKind?.pluginId).toBe(expectedPluginId);
        expect(JSON.stringify(record)).not.toContain(callerToken);
      }
      callerCredential.revoke();

      records.length = 0;
      const privateId = "thr_private_value_must_not_be_logged";
      const privateAuthorization = "Bearer authorization_must_not_be_logged";
      const privateCookie = "session=cookie_must_not_be_logged";
      const response = await harness.app.request(
        `/api/v1/threads?threadIds=${privateId}`,
        {
          headers: {
            authorization: privateAuthorization,
            cookie: privateCookie,
            "user-agent": "node",
          },
        },
      );
      expect(response.status).toBe(200);
      const record = records.find(
        (entry) => entry.fields.eventLoopWork === "GET /api/v1/threads",
      );
      expect(record?.fields.requestShape).toMatchObject({
        filters: ["threadIds"],
      });
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(privateId);
      expect(serialized).not.toContain(privateAuthorization);
      expect(serialized).not.toContain(privateCookie);
      expect(serialized).not.toContain("authorization");
      expect(serialized).not.toContain("cookie");
    } finally {
      await harness.cleanup();
      db.$client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
