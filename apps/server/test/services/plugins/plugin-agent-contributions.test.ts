import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  SkillTreeRegistry,
  resolveProjectSkillSourceFromContent,
  resolveSkillCatalogEntries,
} from "../../../src/services/skills/injected-skills.js";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../../src/services/threads/thread-commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  testLogger,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

async function writeSkill(rootPath: string, name: string): Promise<string> {
  const dir = join(rootPath, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Use ${name} in plugin skill tests.`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

async function writePlugin(
  dir: string,
  options: {
    name: string;
    serverSource?: string;
    bbSkills?: string[];
    skillNames?: string[];
    skillsDirName?: string;
  },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Agent contributions fixture",
        description: "Agent contributions plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.bbSkills ? { skills: options.bbSkills } : {}),
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    options.serverSource ?? "export default function plugin() {}",
  );
  for (const skillName of options.skillNames ?? []) {
    await writeSkill(
      join(rootDir, options.skillsDirName ?? "skills"),
      skillName,
    );
  }
  return rootDir;
}

describe("plugin skills tier", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-skills-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("layers plugin skills below data-dir and project skills", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-skiller",
      skillNames: ["alpha", "beta", "gamma"],
    });
    await service.installPath(rootDir);

    const dataDir = join(workDir, "data");
    await writeSkill(join(dataDir, "skills"), "beta");
    const projectGamma = await writeSkill(
      join(workDir, "project-skills"),
      "gamma",
    );
    const projectGammaSource = resolveProjectSkillSourceFromContent(
      testLogger,
      {
        candidatePath: projectGamma,
        content: await readFile(join(projectGamma, "SKILL.md"), "utf8"),
        directoryName: "gamma",
      },
    );
    if (projectGammaSource === null) {
      throw new Error("Expected a project skill source");
    }

    const skillTreeRegistry = new SkillTreeRegistry();
    const entries = resolveSkillCatalogEntries(testLogger, {
      dataDir,
      pluginSkillRoots: service.listSkillRootContributions(),
      projectSkillSources: [projectGammaSource],
      skillTreeRegistry,
    });
    const sources = entries.map((entry) => entry.runtimeSource);
    const byName = new Map(sources.map((source) => [source.name, source]));

    const alpha = byName.get("alpha");
    const beta = byName.get("beta");
    expect(alpha?.kind).toBe("tree");
    expect(beta?.kind).toBe("tree");
    if (alpha?.kind !== "tree" || beta?.kind !== "tree") {
      throw new Error("Expected server-owned tree sources");
    }
    expect(alpha.sourceType).toBe("data-dir");
    expect(
      entries.find((entry) => entry.runtimeSource.name === "alpha")?.provenance,
    ).toEqual({ kind: "plugin", pluginId: "skiller" });
    expect(beta.sourceType).toBe("data-dir");
    expect(byName.get("gamma")).toMatchObject({
      kind: "workspace-path",
      sourceRootPath: projectGamma,
    });
    expect(byName.get("gamma")?.sourceType).toBe("project");
    expect(sources).toHaveLength(byName.size);
  });

  it("manifest bb.skills relocates the convention root and the experiment gates the tier", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-relocated",
      bbSkills: ["./custom/*"],
      skillNames: ["relocated-skill"],
      skillsDirName: "custom",
    });
    await service.installPath(rootDir);

    expect(service.listSkillRootContributions()).toEqual([
      { pluginId: "relocated", rootPath: join(rootDir, "custom") },
    ]);
    const sources = resolveSkillCatalogEntries(testLogger, {
      dataDir: join(workDir, "data"),
      pluginSkillRoots: service.listSkillRootContributions(),
      skillTreeRegistry: new SkillTreeRegistry(),
    }).map((entry) => entry.runtimeSource);
    expect(sources.map((source) => source.name)).toEqual(["relocated-skill"]);
  });
});

describe("plugin agent contributions reach thread runtime config", () => {
  let harness: TestAppHarness;
  let pluginsDir: string;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    pluginsDir = await mkdtemp(join(tmpdir(), "bb-plugin-runtime-test-"));
  });

  it("refuses to resolve without an environment whose resolver fails or times out twice", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    const service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(pluginsDir, "timeout-data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2_000,
      providerEnvResolveTimeoutMs: 10,
    });
    try {
      const root = await writePlugin(pluginsDir, {
        name: "bb-plugin-env-failures",
        serverSource: `
          export default function plugin(bb) {
            bb.providers.experimental_contributeEnv("codex", () => {
              throw new Error("resolver exploded with sk-ant-sentinel-0451");
            });
            bb.providers.experimental_contributeEnv("claude-code", () => new Promise(() => {}));
          }
        `,
      });
      await service.installPath(root);
      const context = {
        threadId: "thread-timeout",
        projectId: "project-timeout",
        hostId: "host-timeout",
      };

      const failure = await service
        .resolveProviderEnv({ providerId: "codex", context })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toMatchObject({
        status: 503,
        body: { code: "provider_environment_unavailable" },
      });
      expect(JSON.stringify(failure)).not.toContain("sk-ant-sentinel-0451");
      expect(String(failure)).not.toContain("sk-ant-sentinel-0451");
      await expect(
        service.resolveProviderEnv({ providerId: "claude-code", context }),
      ).rejects.toMatchObject({
        status: 503,
        body: { code: "provider_environment_unavailable" },
      });
    } finally {
      await service.stop();
    }
  });

  it("calls a timed-out resolver once per resolution, never overlapping a second call", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    const service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(pluginsDir, "retry-data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2_000,
      providerEnvResolveTimeoutMs: 20,
    });
    try {
      const root = await writePlugin(pluginsDir, {
        name: "bb-plugin-env-slow",
        serverSource: `
          export default function plugin(bb) {
            let calls = 0;
            let inFlight = 0;
            let maxInFlight = 0;
            bb.providers.experimental_contributeEnv("claude-code", async () => {
              calls += 1;
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              try {
                if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 200));
                return [{ name: "RESOLVER_CALLS", value: calls + ":" + maxInFlight, reason: "observed" }];
              } finally {
                inFlight -= 1;
              }
            });
          }
        `,
      });
      await service.installPath(root);
      const context = {
        threadId: "thread-slow",
        projectId: "project-slow",
        hostId: "host-slow",
      };

      await expect(
        service.resolveProviderEnv({ providerId: "claude-code", context }),
      ).rejects.toMatchObject({
        body: { code: "provider_environment_unavailable" },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(
        service.resolveProviderEnv({ providerId: "claude-code", context }),
      ).resolves.toEqual({
        entries: [
          {
            name: "RESOLVER_CALLS",
            value: "2:1",
            reason: "observed",
            source: { plugin: "env-slow" },
          },
        ],
      });
    } finally {
      await service.stop();
    }
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
    await rm(pluginsDir, { recursive: true, force: true });
  });

  it("plugin skills reach the thread.start command and update after reload", async () => {
    const rootDir = await writePlugin(pluginsDir, {
      name: "bb-plugin-ctxdemo",
      skillNames: ["ctx-skill"],
      serverSource: `
        export default function plugin() {}
      `,
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");

    const { host } = seedHostSession(harness.deps, {
      id: "host-plugin-agent-contributions",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "plugin-agent-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const execution = await buildExecutionOptions(
      harness.deps,
      { model: "gpt-5" },
      { threadId: thread.id },
    );
    const buildCommand = (requestValue: number) =>
      buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("hello"),
        projectId: project.id,
        providerId: "codex",
        requestId: encodeClientTurnRequestIdNumber({ value: requestValue }),
        syncGeneratedTitle: false,
        thread,
      });

    const command = await buildCommand(1);
    expect(command.injectedSkillSources).toContainEqual(
      expect.objectContaining({
        kind: "tree",
        name: "ctx-skill",
        entryPath: "SKILL.md",
      }),
    );
    await writeSkill(join(rootDir, "skills"), "late-skill");
    await harness.pluginService.reload("ctxdemo");
    const reloaded = await buildCommand(2);
    expect(
      reloaded.injectedSkillSources.map((source) => source.name),
    ).toContain("late-skill");
  });

  it("resolves provider environment per command and keeps the first plugin on conflicts", async () => {
    const firstRoot = await writePlugin(pluginsDir, {
      name: "bb-plugin-env-first",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", (context) => [
            {
              name: "PLUGIN_CONTEXT",
              value: context.threadId + ":" + context.projectId + ":" + context.hostId,
              reason: "Expose resolution context",
            },
            {
              name: "SHARED_TOKEN",
              value: "first",
              reason: "First registration wins",
            },
          ]);
        }
      `,
    });
    const secondRoot = await writePlugin(pluginsDir, {
      name: "bb-plugin-env-second",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", () => [
            {
              name: "SHARED_TOKEN",
              value: "second",
              reason: "Conflicting registration",
            },
            {
              name: "PLUGIN_PROXY_URL",
              value: { serverPath: "/plugins/env-second/proxy" },
              reason: "Use the server auth proxy",
            },
          ]);
        }
      `,
    });
    await harness.pluginService.installPath(firstRoot);
    await harness.pluginService.installPath(secondRoot);

    const { host } = seedHostSession(harness.deps, {
      id: "host-provider-env",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "provider-env-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const execution = await buildExecutionOptions(
      harness.deps,
      { model: "gpt-5" },
      { threadId: thread.id },
    );
    const command = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello"),
      projectId: project.id,
      providerId: "codex",
      requestId: encodeClientTurnRequestIdNumber({ value: 3 }),
      syncGeneratedTitle: false,
      thread,
    });

    expect(command.contributedEnv).toEqual([
      {
        name: "PLUGIN_CONTEXT",
        value: `${thread.id}:${project.id}:${host.id}`,
        reason: "Expose resolution context",
        source: { plugin: "env-first" },
      },
      {
        name: "SHARED_TOKEN",
        value: "first",
        reason: "First registration wins",
        source: { plugin: "env-first" },
      },
      {
        name: "PLUGIN_PROXY_URL",
        value: { serverPath: "/plugins/env-second/proxy" },
        reason: "Use the server auth proxy",
        source: { plugin: "env-second" },
      },
    ]);
    const nativeEnv = await harness.pluginService.resolveProviderEnv({
      providerId: "codex",
      context: {
        threadId: thread.id,
        projectId: project.id,
        hostId: host.id,
        experimental_runtimeKind: "native",
      },
    });
    expect(nativeEnv.entries).toEqual(command.contributedEnv);
  });

  it("does not build a thread start command without a failing plugin's environment", async () => {
    const root = await writePlugin(pluginsDir, {
      name: "bb-plugin-env-broken",
      serverSource: `
        export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", () => {
            throw new Error("routing unavailable for sk-ant-sentinel-0452");
          });
        }
      `,
    });
    await harness.pluginService.installPath(root);
    const { host } = seedHostSession(harness.deps, {
      id: "host-provider-env-broken",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "provider-env-broken-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const execution = await buildExecutionOptions(
      harness.deps,
      { model: "gpt-5" },
      { threadId: thread.id },
    );

    const failure = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello"),
      projectId: project.id,
      providerId: "codex",
      requestId: encodeClientTurnRequestIdNumber({ value: 5 }),
      syncGeneratedTitle: false,
      thread,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(JSON.stringify(failure)).not.toContain("sk-ant-sentinel-0452");
    expect(String(failure)).not.toContain("sk-ant-sentinel-0452");
    await expect(
      buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("hello"),
        projectId: project.id,
        providerId: "codex",
        requestId: encodeClientTurnRequestIdNumber({ value: 4 }),
        syncGeneratedTitle: false,
        thread,
      }),
    ).rejects.toMatchObject({
      body: { code: "provider_environment_unavailable" },
    });
  });
});
