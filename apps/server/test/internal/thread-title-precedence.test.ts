import { getThread, setAiServiceSelection, updateThread } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { inferThreadMetadata } from "../../src/services/threads/thread-metadata-inference.js";
import { generateAndApplyThreadTitle } from "../../src/services/threads/title-generation.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

async function setup() {
  const harness = await createTestAppHarness();
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "active",
    title: null,
    titleFallback: "Please improve the project naming behavior",
  });
  updateThread(harness.db, harness.hub, thread.id, { title: null });
  return { harness, session, thread };
}

async function postAgentName(
  harness: TestAppHarness,
  sessionId: string,
  threadId: string,
  threadName: string,
) {
  const events: HostDaemonEventEnvelope[] = [
    {
      threadId,
      event: {
        type: "thread/name/updated",
        threadId,
        providerThreadId: `provider-${threadId}`,
        scope: threadScope(),
        source: "agent",
        threadName,
      },
    },
  ];
  return harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId,
      eventGroups: groupHostDaemonEvents(events),
    }),
  });
}

describe("thread title precedence", () => {
  it("does not accept a two-character provider name", async () => {
    const { harness, session, thread } = await setup();
    let calls = 0;
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-short-test",
      pluginId: "title-short-test-plugin",
      complete: async () => {
        calls += 1;
        throw new Error("temporary service failure");
      },
    });
    try {
      const response = await postAgentName(
        harness,
        session.id,
        thread.id,
        "OK",
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(calls).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(getThread(harness.db, thread.id)?.title).toBe(
        thread.titleFallback,
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("does not use a provider name that prefixes the first assistant reply", async () => {
    const { harness, session, thread } = await setup();
    let calls = 0;
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-prefix-test",
      pluginId: "title-prefix-test-plugin",
      complete: async () => {
        calls += 1;
        throw new Error("temporary service failure");
      },
    });
    try {
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: `provider-${thread.id}`,
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Please inspect the repository guidance before changing the title pipeline.",
          },
        },
      });
      const response = await postAgentName(
        harness,
        session.id,
        thread.id,
        "Please inspect the repository guidance",
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(calls).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(getThread(harness.db, thread.id)?.title).toBe(
        thread.titleFallback,
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("prefers bb's generated title over a provider name", async () => {
    const { harness, session, thread } = await setup();
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-test",
      pluginId: "title-test-plugin",
      complete: async () => "Improve project naming behavior",
    });
    try {
      const response = await postAgentName(
        harness,
        session.id,
        thread.id,
        "Please improve the project naming behavior now",
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(getThread(harness.db, thread.id)?.title).toBe(
          "Improve project naming behavior",
        ),
      );
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Improve project naming behavior",
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("keeps a later explicit rename over an earlier provider name", async () => {
    const { harness, session, thread } = await setup();
    let finish: ((value: string) => void) | undefined;
    let calls = 0;
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-explicit-test",
      pluginId: "title-explicit-test-plugin",
      complete: async () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const response = await postAgentName(
        harness,
        session.id,
        thread.id,
        "Provider generated title",
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(calls).toBe(1));
      updateThread(harness.db, harness.hub, thread.id, {
        title: "Manually chosen title",
      });
      finish?.("Improve project naming behavior");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Manually chosen title",
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("retries once after a failed title service call", async () => {
    const { harness, thread } = await setup();
    let calls = 0;
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-retry-test",
      pluginId: "title-retry-test-plugin",
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary service failure");
        return "Improve project naming behavior";
      },
    });
    try {
      const result = await generateAndApplyThreadTitle(harness.deps, {
        input: [
          {
            type: "text",
            text: "Please improve the project naming behavior now",
            mentions: [],
          },
        ],
        threadId: thread.id,
      });
      expect(calls).toBe(2);
      expect(result.titleApplied).toBe(true);
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Improve project naming behavior",
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("applies the prompt fallback after both title attempts fail", async () => {
    const { harness, thread } = await setup();
    let calls = 0;
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-fallback-after-failure-test",
      pluginId: "title-fallback-after-failure-test-plugin",
      complete: async () => {
        calls += 1;
        throw new Error("persistent title service failure");
      },
    });
    try {
      const result = await generateAndApplyThreadTitle(harness.deps, {
        input: [
          {
            type: "text",
            text: thread.titleFallback ?? "",
            mentions: [],
          },
        ],
        threadId: thread.id,
      });
      expect(calls).toBe(2);
      expect(result.titleApplied).toBe(true);
      expect(getThread(harness.db, thread.id)?.title).toBe(
        thread.titleFallback,
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("applies the prompt fallback when title inference is unavailable", async () => {
    const { harness, thread } = await setup();
    setAiServiceSelection(harness.db, "thread-title", { mode: "off" });
    try {
      const result = await inferThreadMetadata(harness.deps, {
        input: [
          {
            type: "text",
            text: thread.titleFallback ?? "",
            mentions: [],
          },
        ],
        provisioningId: "provisioning-no-transcript",
        threadId: thread.id,
        writeTranscript: false,
      });
      expect(result).toEqual({
        titleApplied: true,
        title: thread.titleFallback,
      });
      expect(getThread(harness.db, thread.id)?.title).toBe(
        thread.titleFallback,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a generated title that prefixes the first assistant reply", async () => {
    const { harness, thread } = await setup();
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-generated-quality-test",
      pluginId: "title-generated-quality-test-plugin",
      complete: async () => "OK",
    });
    try {
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: `provider-${thread.id}`,
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "OK, I will inspect the title behavior.",
          },
        },
      });
      const result = await generateAndApplyThreadTitle(harness.deps, {
        input: [
          {
            type: "text",
            text: thread.titleFallback ?? "",
            mentions: [],
          },
        ],
        threadId: thread.id,
      });
      expect(result.outcome.metadata?.title).toBe("OK");
      expect(result.titleApplied).toBe(true);
      expect(getThread(harness.db, thread.id)?.title).toBe(
        thread.titleFallback,
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });

  it("uses a valid provider name only after title generation fails", async () => {
    const { harness, session, thread } = await setup();
    let calls = 0;
    const service = registerFakeAiService(harness.deps.aiServices, {
      id: "title-fallback-test",
      pluginId: "title-fallback-test-plugin",
      complete: async () => {
        calls += 1;
        throw new Error("service unavailable for this attempt");
      },
    });
    try {
      const response = await postAgentName(
        harness,
        session.id,
        thread.id,
        "Useful provider thread name",
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(calls).toBe(2));
      await vi.waitFor(() =>
        expect(getThread(harness.db, thread.id)?.title).toBe(
          "Useful provider thread name",
        ),
      );
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "Useful provider thread name",
      );
    } finally {
      service.dispose();
      await harness.cleanup();
    }
  });
});
