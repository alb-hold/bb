import { upsertHost } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { createServerClient } from "../../../host-daemon/src/server-client.js";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

function createLogger() {
  return {
    debug() {},
    error() {},
    info() {},
    warn() {},
  };
}

function sessionArgs(hostId: string) {
  return {
    activeThreads: [],
    adoptedThreads: [],
    dataDir: `/tmp/${hostId}`,
    hostId,
    hostName: "Protocol Host",
    instanceId: `instance-${hostId}`,
    loadedEnvironments: [],
    localApiPort: 38_888,
    undeliveredEventThreadIds: [],
  };
}

describe("production daemon protocol wiring", () => {
  it("sends the compiled daemon protocol version and opens a session", async () => {
    const server = await startTestServer();
    const hostId = "host-production-protocol-version";
    try {
      const hostKey = createTestDaemonHostKey({ hostId });
      upsertHost(server.db, server.hub, { id: hostId, name: "Protocol Host" });
      let requestProtocolVersion: number | undefined;
      const client = createServerClient({
        fetchFn: async (input, init) => {
          const url = input instanceof URL ? input.href : String(input);
          if (url.endsWith("/internal/session/open")) {
            const payload: unknown = JSON.parse(String(init?.body));
            if (
              payload === null ||
              typeof payload !== "object" ||
              !("protocolVersion" in payload) ||
              typeof payload.protocolVersion !== "number"
            )
              throw new Error("session request omitted protocolVersion");
            requestProtocolVersion = payload.protocolVersion;
          }
          return fetch(input, init);
        },
        getSessionId: () => "",
        hostKey,
        logger: createLogger(),
        serverUrl: server.baseUrl,
      });

      const response = await client.openSession(sessionArgs(hostId));

      expect(requestProtocolVersion).toBe(HOST_DAEMON_PROTOCOL_VERSION);
      expect(response.sessionId).not.toBe("");
    } finally {
      await server.close();
    }
  });

  it("returns update-required details for a protocol 260 payload", async () => {
    const server = await startTestServer();
    const hostId = "host-old-protocol-version";
    try {
      const hostKey = createTestDaemonHostKey({ hostId });
      upsertHost(server.db, server.hub, { id: hostId, name: "Protocol Host" });
      server.hub.requestHostProtocolUpdateRetry(hostId);

      const response = await fetch(`${server.baseUrl}/internal/session/open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${hostKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...sessionArgs(hostId),
          hasMachineCredential: false,
          platform: "linux",
          protocolVersion: 260,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "protocol_version_mismatch",
        details: {
          retryUpdate: true,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
      });
    } finally {
      await server.close();
    }
  });
});
