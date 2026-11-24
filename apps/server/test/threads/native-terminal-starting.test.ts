import { getThread } from "@bb/db";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  nativeTerminalThreadSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function waitForTerminalOpen(
  sentMessages: string[],
): Promise<TerminalOpenMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    for (const raw of sentMessages) {
      const parsed = hostDaemonServerWsMessageSchema.parse(JSON.parse(raw));
      if (parsed.type === "terminal.open") return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal.open");
}

describe("V3 server: new native thread stays starting until its terminal exists", () => {
  it("keeps thread status starting while initial native terminal open is in flight and settles to idle once created", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const seeded = seedHostSession(harness.deps, { id: "v3-start-host" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/v3-project",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/v3-workspace",
      projectId: project.id,
      status: "ready",
    });
    const sentMessages: string[] = [];
    harness.hub.registerDaemon(seeded.session.id, seeded.host.id, {
      close: vi.fn(),
      send: vi.fn((data: string) => {
        sentMessages.push(data);
      }),
    });

    const createResponse = await harness.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        providerId: "claude-code",
        origin: "cli",
        input: [],
        environment: { type: "reuse", environmentId: environment.id },
        nativeTerminal: true,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = threadResponseSchema.parse(await readJson(createResponse));

    const open = await waitForTerminalOpen(sentMessages);

    const duringOpenResponse = await harness.app.request(
      `/api/v1/threads/${created.id}`,
    );
    expect(duringOpenResponse.status).toBe(200);
    const duringOpen = threadResponseSchema.parse(
      await readJson(duringOpenResponse),
    );
    expect(duringOpen.status).toBe("starting");
    expect(duringOpen.runtime.displayStatus).toBe("starting");

    const nativeDuringOpenResponse = await harness.app.request(
      `/api/v1/threads/${created.id}/native-terminal`,
    );
    expect(nativeDuringOpenResponse.status).toBe(200);
    const nativeDuringOpen = nativeTerminalThreadSchema.parse(
      await readJson(nativeDuringOpenResponse),
    );
    expect(nativeDuringOpen.terminal).toBeNull();
    expect((nativeDuringOpen as { starting?: boolean }).starting).toBe(true);

    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/v3-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });

    await vi.waitFor(() => {
      expect(getThread(harness.db, created.id)?.status).toBe("idle");
    });

    const nativeAfterOpenResponse = await harness.app.request(
      `/api/v1/threads/${created.id}/native-terminal`,
    );
    expect(nativeAfterOpenResponse.status).toBe(200);
    const nativeAfterOpen = nativeTerminalThreadSchema.parse(
      await readJson(nativeAfterOpenResponse),
    );
    expect(nativeAfterOpen.terminal?.id).toBe(open.terminalId);
    expect(nativeAfterOpen.terminal?.status).toBe("running");
    expect((nativeAfterOpen as { starting?: boolean }).starting).toBeUndefined();
  });
});
