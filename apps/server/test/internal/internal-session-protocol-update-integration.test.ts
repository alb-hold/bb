import { upsertHost } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

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
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);
      expect((await response.json()).sessionId).not.toBe("");
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
