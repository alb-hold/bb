import type {
  ProviderUsage,
  ProviderUsageResponse,
} from "@bb/host-daemon-contract";
import { threadScope, turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { minimalProviderRegistration } from "../helpers/provider-registry.js";
import {
  seedEvent,
  seedHost,
  seedHostSession,
  seedPrimaryHost,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const USAGE_RESPONSE: ProviderUsageResponse = {
  codex: {
    status: "ok",
    accountEmail: "codex@example.com",
    planLabel: "Plus",
    windows: [{ label: "5-hour", usedPercent: 42, resetsAt: null }],
  },
  "claude-code": { status: "unauthenticated" },
  "acp-cursor": { status: "unauthenticated" },
  "acp-opencode": {
    status: "ok",
    accountEmail: "opencode@example.com",
    planLabel: "Pro",
    windows: [{ label: "weekly", usedPercent: 18, resetsAt: null }],
  },
};

const ALWAYS_VISIBLE_USAGE_RESPONSE: ProviderUsageResponse = {
  codex: USAGE_RESPONSE.codex,
  "claude-code": USAGE_RESPONSE["claude-code"],
};

const ALWAYS_VISIBLE_PROVIDER_IDS = ["codex", "claude-code"];

function providerUsage(providerId: string): ProviderUsage | null {
  return USAGE_RESPONSE[providerId] ?? null;
}

function handleUsageRequest(
  request: Parameters<
    Parameters<typeof registerHostRpcResponder>[1]["handle"]
  >[0],
  installedOnlyProvidersInstalled = false,
) {
  if (request.command.type === "provider.health") {
    return {
      ok: true as const,
      result: {
        supported: true as const,
        health: {
          status: installedOnlyProvidersInstalled
            ? ("ready" as const)
            : ("not_installed" as const),
          statusMessage: null,
          accountEmail: null,
          planLabel: null,
          installedVersion: null,
          minimumSupportedVersion: null,
          canInstall: false,
          canUpdate: false,
          loginCommand: null,
        },
      },
    };
  }
  if (request.command.type === "provider.usage") {
    const usage = providerUsage(request.command.providerId);
    return usage === null
      ? { ok: true as const, result: { supported: false as const } }
      : {
          ok: true as const,
          result: { supported: true as const, usage },
        };
  }
  throw new Error(`Unexpected command ${request.command.type}`);
}

describe("GET /api/v1/system/usage-limits", () => {
  it("shares concurrent usage requests but refreshes on explicit reload and reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "shared-usage",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        async handle(request) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return handleUsageRequest(request, true);
        },
      });
      const read = async (refresh = false) => {
        const response = await harness.app.request(
          `/api/v1/system/usage-limits?hostId=${host.id}&refresh=${refresh}`,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(USAGE_RESPONSE);
      };
      const count = () =>
        responder.requests.filter(
          (request) => request.command.type === "provider.usage",
        ).length;
      try {
        await Promise.all(Array.from({ length: 8 }, read));
        expect(
          responder.requests.flatMap((request) =>
            request.command.type === "provider.usage"
              ? [request.command.providerId]
              : [],
          ),
        ).toEqual(["codex", "claude-code", "acp-cursor", "acp-opencode"]);
        expect(count()).toBe(4);
        await read();
        expect(count()).toBe(4);
        await Promise.all(Array.from({ length: 8 }, () => read(true)));
        expect(count()).toBe(8);
        await read();
        expect(count()).toBe(8);
        harness.hub.notifyHost(host.id, ["host-connected"]);
        await read();
        expect(count()).toBe(12);
      } finally {
        responder.unregister();
      }
    });
  });

  it("retries provider usage errors instead of retaining them", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "retry-usage",
      });
      let probes = 0;
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle(request) {
          if (request.command.type === "provider.usage" && ++probes === 1) {
            return {
              ok: true,
              result: {
                supported: true,
                usage: {
                  status: "error",
                  message: "offline",
                  accountEmail: null,
                  planLabel: null,
                },
              },
            };
          }
          return handleUsageRequest(request);
        },
      });
      try {
        const url = `/api/v1/system/usage-limits?hostId=${host.id}&providerId=codex`;
        const failed = await harness.app.request(url);
        expect(await failed.json()).toEqual({
          codex: {
            status: "error",
            message: "offline",
            accountEmail: null,
            planLabel: null,
          },
        });
        const recovered = await harness.app.request(url);
        expect(await recovered.json()).toEqual({ codex: USAGE_RESPONSE.codex });
        expect(probes).toBe(2);
      } finally {
        responder.unregister();
      }
    });
  });

  it.each(["unauthenticated", "expired"] as const)(
    "reports a %s provider as unreadable, not unusable, while the account pool supplies its credentials",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: `pool-usage-${status}`,
        });
        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle(request) {
            if (request.command.type === "provider.usage") {
              return {
                ok: true,
                result: { supported: true, usage: { status } },
              };
            }
            return handleUsageRequest(request);
          },
        });
        const url = `/api/v1/system/usage-limits?hostId=${host.id}&providerId=codex&refresh=true`;
        try {
          const withoutPool = await harness.app.request(url);
          expect(await withoutPool.json()).toEqual({ codex: { status } });
          const contribute = (pluginId: string | null) =>
            setPluginAgentContributions({
              listSkillRootContributions: () => [],
              listAgentTools: () => [],
              listInstructionContributions: () => [],
              findAgentTool: () => undefined,
              invokeAgentTool: async () => ({
                success: false,
                contentItems: [{ type: "inputText", text: "unused" }],
              }),
              resolveMention: async () => ({ ok: false, error: "unused" }),
              resolveProviderEnvHealth: async ({ providerId }) =>
                providerId === "codex" && pluginId !== null
                  ? {
                      pluginId,
                      label: "Proxied",
                      statusMessage:
                        "Credentials are provided by the Account Pooler hub.",
                    }
                  : null,
            });
          contribute("some-other-plugin");
          const fromOtherPlugin = await harness.app.request(url);
          expect(await fromOtherPlugin.json()).toEqual({ codex: { status } });
          contribute(null);
          const noContribution = await harness.app.request(url);
          expect(await noContribution.json()).toEqual({ codex: { status } });
          contribute("account-pool");
          const withPool = await harness.app.request(url);
          expect(await withPool.json()).toEqual({
            codex: {
              status: "error",
              message:
                "Routed through the account pool; there are no subscription windows from a local login.",
              planLabel: null,
              accountEmail: null,
            },
          });
        } finally {
          setPluginAgentContributions(undefined);
          responder.unregister();
        }
      });
    },
  );

  it("does not start a usage probe the provider did not declare", async () => {
    await withTestHarness(async (harness) => {
      harness.deps.providerRegistry.register(
        minimalProviderRegistration({
          pluginId: "provider-no-usage",
          info: {
            id: "no-usage",
            pluginId: "provider-no-usage",
            displayName: "No Usage",
            logoUrl: null,
            available: true,
            maintenance: { health: false, usage: false, installation: false },
            capabilities: {
              supportsThreadArchive: false,
              supportsThreadRename: false,
              supportsServiceTier: false,
              supportsNativeUserQuestion: false,
              supportsFork: false,
              supportsSessionRewind: false,
              modelCatalogScope: "workspace",
              permissionModes: ["full"],
            },
            composerActions: [],
            completedTurnDisplay: "collapse",
          },
          serverCapabilities: {
            reasoningLevels: ["medium"],
            fork: "none",
            supportsManualCompaction: false,
          },
        }),
      );
      const primary = seedHostSession(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: handleUsageRequest,
      });

      const response = await harness.app.request("/api/v1/system/usage-limits");

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual(ALWAYS_VISIBLE_USAGE_RESPONSE);
      expect(
        responder.requests.some(
          (request) =>
            request.command.type === "provider.usage" &&
            request.command.providerId === "no-usage",
        ),
      ).toBe(false);
      expect(
        responder.requests.flatMap((request) =>
          request.command.type === "provider.health"
            ? [request.command.providerId]
            : [],
        ),
      ).toEqual(["acp-cursor", "acp-opencode"]);
    });
  });

  it("loads one provider without waiting for its peers", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHostSession(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: handleUsageRequest,
      });

      const response = await harness.app.request(
        "/api/v1/system/usage-limits?providerId=codex",
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ codex: USAGE_RESPONSE.codex });
      expect(
        responder.requests.flatMap((request) =>
          request.command.type === "provider.usage"
            ? [request.command.providerId]
            : [],
        ),
      ).toEqual(["codex"]);
      expect(
        responder.requests.some(
          (request) => request.command.type === "provider.health",
        ),
      ).toBe(false);
    });
  });

  it("continues to use the primary machine when no host is selected", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHostSession(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: handleUsageRequest,
      });

      const response = await harness.app.request("/api/v1/system/usage-limits");

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual(ALWAYS_VISIBLE_USAGE_RESPONSE);
      expect(
        responder.requests.flatMap((request) =>
          request.command.type === "provider.usage"
            ? [request.command.providerId]
            : [],
        ),
      ).toEqual(ALWAYS_VISIBLE_PROVIDER_IDS);
    });
  });

  it("reports usage for an installed-only provider once its CLI is installed", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHostSession(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: (request) => handleUsageRequest(request, true),
      });

      const response = await harness.app.request("/api/v1/system/usage-limits");

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual(USAGE_RESPONSE);
      expect(
        responder.requests.flatMap((request) =>
          request.command.type === "provider.usage"
            ? [request.command.providerId]
            : [],
        ),
      ).toEqual([
        ...ALWAYS_VISIBLE_PROVIDER_IDS,
        "acp-cursor",
        "acp-opencode",
      ]);
    });
  });

  it("omits an installed provider when its runtime does not support usage and caches that result until refresh", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHostSession(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: (request) =>
          request.command.type === "provider.usage" &&
          request.command.providerId === "acp-opencode"
            ? { ok: true as const, result: { supported: false as const } }
            : handleUsageRequest(request, true),
      });
      const read = async (refresh = false) => {
        const response = await harness.app.request(
          `/api/v1/system/usage-limits${refresh ? "?refresh=true" : ""}`,
        );
        expect(response.status).toBe(200);
        expect(await readJson(response)).toEqual({
          codex: USAGE_RESPONSE.codex,
          "claude-code": USAGE_RESPONSE["claude-code"],
          "acp-cursor": USAGE_RESPONSE["acp-cursor"],
        });
      };
      const count = () =>
        responder.requests.filter(
          (request) =>
            request.command.type === "provider.usage" &&
            request.command.providerId === "acp-opencode",
        ).length;

      await read();
      expect(count()).toBe(1);
      await read();
      expect(count()).toBe(1);
      await read(true);
      expect(count()).toBe(2);
    });
  });

  it("routes an explicit machine selection to that host daemon", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const remote = seedHostSession(harness.deps, {
        id: "host-remote",
        name: "builder",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: remote.host.id,
        sessionId: remote.session.id,
        handle: handleUsageRequest,
      });

      const response = await harness.app.request(
        `/api/v1/system/usage-limits?hostId=${remote.host.id}`,
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual(ALWAYS_VISIBLE_USAGE_RESPONSE);
      expect(
        responder.requests.flatMap((request) =>
          request.command.type === "provider.usage"
            ? [request.command.providerId]
            : [],
        ),
      ).toEqual(ALWAYS_VISIBLE_PROVIDER_IDS);
    });
  });

  it("aggregates local acp-antigravity-acp thread usage events into 5-hour and 7-day windows", async () => {
    await withTestHarness(async (harness) => {
      const now = Date.now();
      const hourMs = 60 * 60 * 1_000;
      const dayMs = 24 * hourMs;
      const { host, session, thread } = seedThreadFixture(harness, {
        session: { id: "host-antigravity" },
        thread: { providerId: "acp-antigravity-acp" },
      });
      seedPrimaryHost(harness.deps, host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: handleUsageRequest,
      });

      // Event older than 7 days: should be excluded from both windows.
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 1,
        createdAt: now - 8 * dayMs,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-sess-1",
          contextWindowUsage: {
            usedTokens: 10_000,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 2,
        createdAt: now - 8 * dayMs + 1_000,
        type: "turn/completed",
        scope: turnScope("turn-old"),
        data: { providerThreadId: "agy-sess-1", status: "completed" },
      });

      // Event 2 days ago (inside 7d, outside 5h): +15,000 tokens, 1 turn.
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 3,
        createdAt: now - 2 * dayMs,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-sess-1",
          contextWindowUsage: {
            usedTokens: 25_000,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 4,
        createdAt: now - 2 * dayMs + 1_000,
        type: "turn/completed",
        scope: turnScope("turn-2d"),
        data: { providerThreadId: "agy-sess-1", status: "completed" },
      });

      // Event 1 hour ago (inside 5h and 7d): +12,500 tokens, 1 turn.
      const recentAt = now - hourMs;
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 5,
        createdAt: recentAt,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-sess-1",
          contextWindowUsage: {
            usedTokens: 37_500,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      // Repeated identical reading should not double-count.
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 6,
        createdAt: recentAt + 500,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-sess-1",
          contextWindowUsage: {
            usedTokens: 37_500,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 7,
        createdAt: recentAt + 1_000,
        type: "turn/completed",
        scope: turnScope("turn-1h"),
        data: { providerThreadId: "agy-sess-1", status: "completed" },
      });
      // Compaction drop (37,500 -> 10,000) adds the post-compaction occupancy (10,000).
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 8,
        createdAt: recentAt + 2_000,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-sess-1",
          contextWindowUsage: {
            usedTokens: 10_000,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-sess-1",
        sequence: 9,
        createdAt: recentAt + 3_000,
        type: "turn/completed",
        scope: turnScope("turn-compacted"),
        data: { providerThreadId: "agy-sess-1", status: "completed" },
      });

      try {
        const response = await harness.app.request(
          `/api/v1/system/usage-limits?hostId=${host.id}&providerId=acp-antigravity-acp`,
        );
        expect(response.status).toBe(200);
        const body = (await readJson(response)) as ProviderUsageResponse;
        expect(body["acp-antigravity-acp"]).toEqual({
          status: "ok",
          accountEmail: null,
          planLabel: null,
          windows: [],
          localUsage: {
            source: "local-events",
            estimated: true,
            lastActivityAt: recentAt + 3_000,
            windows: [
              {
                label: "5 hour",
                windowMinutes: 300,
                tokens: 22_500,
                turns: 2,
              },
              {
                label: "7 day",
                windowMinutes: 10_080,
                tokens: 37_500,
                turns: 3,
              },
            ],
          },
        });
      } finally {
        responder.unregister();
      }
    });
  });

  it("sums thread/tokenUsage/updated events for acp-antigravity-acp without double-counting repeats", async () => {
    await withTestHarness(async (harness) => {
      const now = Date.now();
      const { host, session, thread } = seedThreadFixture(harness, {
        session: { id: "host-antigravity-token-usage" },
        thread: { providerId: "acp-antigravity-acp" },
      });
      seedPrimaryHost(harness.deps, host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: handleUsageRequest,
      });

      const recentAt = now - 10 * 60 * 1_000;
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-tok-1",
        sequence: 1,
        createdAt: recentAt,
        type: "thread/tokenUsage/updated",
        scope: turnScope("turn-1"),
        data: {
          providerThreadId: "agy-tok-1",
          tokenUsage: {
            last: {
              inputTokens: 1_000,
              cachedInputTokens: 0,
              outputTokens: 500,
              reasoningOutputTokens: 0,
              totalTokens: 1_500,
            },
            total: {
              inputTokens: 1_000,
              cachedInputTokens: 0,
              outputTokens: 500,
              reasoningOutputTokens: 0,
              totalTokens: 1_500,
            },
            modelContextWindow: 1_048_576,
          },
        },
      });
      // Duplicate emission with the same cumulative total should be ignored.
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-tok-1",
        sequence: 2,
        createdAt: recentAt + 1_000,
        type: "thread/tokenUsage/updated",
        scope: turnScope("turn-1"),
        data: {
          providerThreadId: "agy-tok-1",
          tokenUsage: {
            last: {
              inputTokens: 1_000,
              cachedInputTokens: 0,
              outputTokens: 500,
              reasoningOutputTokens: 0,
              totalTokens: 1_500,
            },
            total: {
              inputTokens: 1_000,
              cachedInputTokens: 0,
              outputTokens: 500,
              reasoningOutputTokens: 0,
              totalTokens: 1_500,
            },
            modelContextWindow: 1_048_576,
          },
        },
      });

      try {
        const response = await harness.app.request(
          `/api/v1/system/usage-limits?hostId=${host.id}`,
        );
        expect(response.status).toBe(200);
        const body = (await readJson(response)) as ProviderUsageResponse;
        expect(body["acp-antigravity-acp"]).toEqual({
          status: "ok",
          accountEmail: null,
          planLabel: null,
          windows: [],
          localUsage: {
            source: "local-events",
            estimated: false,
            lastActivityAt: recentAt,
            windows: [
              {
                label: "5 hour",
                windowMinutes: 300,
                tokens: 1_500,
                turns: 1,
              },
              {
                label: "7 day",
                windowMinutes: 10_080,
                tokens: 1_500,
                turns: 1,
              },
            ],
          },
        });
      } finally {
        responder.unregister();
      }
    });
  });

  it("counts mixed-stream threads without dropping context-only turns or double-counting turns with both", async () => {
    await withTestHarness(async (harness) => {
      const now = Date.now();
      const recentAt = now - 20 * 60 * 1_000;
      const { host, session, thread } = seedThreadFixture(harness, {
        session: { id: "host-antigravity-mixed" },
        thread: { providerId: "acp-antigravity-acp" },
      });
      seedPrimaryHost(harness.deps, host.id);
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: handleUsageRequest,
      });

      // Turn 1 emits both contextWindowUsage (10,000) and tokenUsage (1,200) -> counts 1,200 (no double count).
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-mixed-1",
        sequence: 1,
        createdAt: recentAt,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-mixed-1",
          contextWindowUsage: {
            usedTokens: 10_000,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-mixed-1",
        sequence: 2,
        createdAt: recentAt + 500,
        type: "thread/tokenUsage/updated",
        scope: turnScope("turn-1"),
        data: {
          providerThreadId: "agy-mixed-1",
          tokenUsage: {
            last: {
              inputTokens: 900,
              cachedInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
              totalTokens: 1_200,
            },
            total: {
              inputTokens: 900,
              cachedInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
              totalTokens: 1_200,
            },
            modelContextWindow: 1_048_576,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-mixed-1",
        sequence: 3,
        createdAt: recentAt + 1_000,
        type: "turn/completed",
        scope: turnScope("turn-1"),
        data: { providerThreadId: "agy-mixed-1", status: "completed" },
      });

      // Turn 2 emits only contextWindowUsage (10,000 -> 14,500) -> counts +4,500 delta.
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-mixed-1",
        sequence: 4,
        createdAt: recentAt + 2_000,
        type: "thread/contextWindowUsage/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "agy-mixed-1",
          contextWindowUsage: {
            usedTokens: 14_500,
            modelContextWindow: 1_048_576,
            estimated: false,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "agy-mixed-1",
        sequence: 5,
        createdAt: recentAt + 3_000,
        type: "turn/completed",
        scope: turnScope("turn-2"),
        data: { providerThreadId: "agy-mixed-1", status: "completed" },
      });

      try {
        const response = await harness.app.request(
          `/api/v1/system/usage-limits?hostId=${host.id}&providerId=acp-antigravity-acp`,
        );
        expect(response.status).toBe(200);
        const body = (await readJson(response)) as ProviderUsageResponse;
        expect(body["acp-antigravity-acp"]).toEqual({
          status: "ok",
          accountEmail: null,
          planLabel: null,
          windows: [],
          localUsage: {
            source: "local-events",
            estimated: true,
            lastActivityAt: recentAt + 3_000,
            windows: [
              {
                label: "5 hour",
                windowMinutes: 300,
                tokens: 5_700,
                turns: 2,
              },
              {
                label: "7 day",
                windowMinutes: 10_080,
                tokens: 5_700,
                turns: 2,
              },
            ],
          },
        });
      } finally {
        responder.unregister();
      }
    });
  });
});
