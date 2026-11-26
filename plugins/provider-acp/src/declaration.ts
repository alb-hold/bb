import type {
  PluginProviderCapabilities,
  PluginProviderDeclaration,
  PluginProviderStrings,
} from "@get-bb/plugin-sdk";
import { ACP_FAMILY, type AcpAgentDefinition } from "./agents.js";

const ACP_BASE_CAPABILITIES: PluginProviderCapabilities = {
  supportsServiceTier: true,
  supportsNativeUserQuestion: false,
  supportsManualCompaction: false,
  supportsThreadArchive: false,
  supportsThreadRename: false,
  fork: "none",
  permissionModes: ["accept-edits", "full"],
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
};

const ACP_SERVICE_TIERS = [
  { id: "default", label: "Default" },
  { id: "fast", label: "Fast" },
] as const;

const DEFAULT_FORK = "none" as const;

const AGY_NATIVE_TERMINAL: NonNullable<
  PluginProviderDeclaration["experimental_nativeTerminal"]
> = {
  executable: "agy",
  launchArgs: ["--dangerously-skip-permissions"],
  workspaceArgs: ["--settings", '{"trustedWorkspaces":[{cwdJson}]}'],
  modelArgs: ["--model", "{model}"],
  promptArgs: ["-i", "{prompt}"],
  pastePlaceholders: ["[Pasted text #"],
  sessionRoot: { env: null, home: ".gemini/antigravity-cli" },
  session: {
    kind: "sqlite-discovered",
    resumeArgs: ["--resume", "{sessionId}"],
    sessionLog: {
      args: ["--log-file", "{logFile}"],
      prefixes: ["Created conversation ", "Streaming conversation "],
    },
    database: "conversation_summaries.db",
    transcript: "brain/{sessionId}/.system_generated/logs/transcript.jsonl",
    table: "conversation_summaries",
    idColumn: "conversation_id",
    workspaceUrisColumn: "workspace_uris",
    startedAtColumn: "last_user_input_time",
    transcriptStartedAtField: "created_at",
  },
  activity: {
    transcript: {
      working: [
        {
          equals: { type: "PLANNER_RESPONSE", source: "MODEL" },
          present: ["tool_calls.0"],
        },
        {
          equals: { type: "GENERIC", source: "MODEL", status: "RUNNING" },
        },
      ],
      idle: [
        {
          equals: {
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
          },
          absent: ["tool_calls.0"],
        },
      ],
      prompt: [
        {
          match: {
            equals: { type: "USER_INPUT", source: "USER_EXPLICIT" },
          },
          text: "content",
        },
      ],
      reply: [
        {
          match: {
            equals: {
              type: "PLANNER_RESPONSE",
              source: "MODEL",
              status: "DONE",
            },
            absent: ["tool_calls.0"],
          },
          text: "content",
        },
      ],
    },
  },
};

function isAntigravityAgent(agent: AcpAgentDefinition): boolean {
  return (
    agent.id === "acp-antigravity-acp" ||
    agent.id === "acp-agy" ||
    /(?:^|[\\/])agy$/u.test(agent.launch.command)
  );
}

function acpStrings(agent: AcpAgentDefinition): PluginProviderStrings {
  const signIn = agent.signInCommand;
  return {
    signInHint:
      signIn === undefined
        ? `Sign in to ${agent.displayName} on the machine, then reload.`
        : `Run \`${signIn}\` on the machine to sign in.`,
    expiredHint:
      signIn === undefined
        ? `Your ${agent.displayName} session expired. Sign in on the machine, then reload.`
        : `Your ${agent.displayName} session expired. Run \`${signIn}\`, then reload.`,
    installUrl: agent.installUrl ?? "https://agentclientprotocol.com",
    ...(agent.iconTint === undefined ? {} : { iconTint: agent.iconTint }),
  };
}

export function acpProviderDeclaration(
  agent: AcpAgentDefinition,
): PluginProviderDeclaration {
  return {
    id: agent.id,
    displayName: agent.displayName,
    family: ACP_FAMILY,
    ...(agent.icon === undefined ? {} : { icon: agent.icon }),
    strings: acpStrings(agent),
    serviceTiers: [...ACP_SERVICE_TIERS],
    ...(agent.visibility === undefined
      ? {}
      : { experimental_visibility: agent.visibility }),
    ...(agent.launch.nativeSkillRoots === undefined
      ? {}
      : {
          experimental_nativeSkillRoots: {
            user: [...agent.launch.nativeSkillRoots.user],
            project: [...agent.launch.nativeSkillRoots.project],
          },
        }),
    ...(agent.nativeRootsResolver === undefined
      ? {}
      : { experimental_resolvesNativeRoots: true }),
    ...(agent.guidedSignIn === true
      ? { internal_DO_NOT_USE_guidedSignIn: true }
      : {}),
    ...(isAntigravityAgent(agent)
      ? { experimental_nativeTerminal: AGY_NATIVE_TERMINAL }
      : {}),
    experimental_bridgeOptions: {
      ...(agent.id === "acp-antigravity-acp" ? { acpAgentId: agent.id } : {}),
      ...(agent.dialect === undefined ? {} : { acpDialect: agent.dialect }),
      ...(agent.parameterizedModelPicker === true
        ? { parameterizedModelPicker: true }
        : {}),
      ...(agent.primaryModels === undefined
        ? {}
        : { primaryModels: [...agent.primaryModels] }),
      acpLaunchSpec: { ...agent.launch },
    },
    models: { scope: agent.modelCatalogScope ?? "host" },
    maintenance: {
      health: true,
      usage: agent.providerUsage === true,
      installation: agent.providerInstallation === true,
    },
    capabilities: {
      ...ACP_BASE_CAPABILITIES,
      fork: agent.fork ?? DEFAULT_FORK,
      permissionModes: [...ACP_BASE_CAPABILITIES.permissionModes],
      ...(agent.supportsManualCompaction === true
        ? { supportsManualCompaction: true }
        : {}),
      ...(agent.reportsTokenUsage === undefined
        ? {}
        : { reportsTokenUsage: agent.reportsTokenUsage }),
      reasoningLevels:
        agent.reasoningLevels === undefined
          ? [...ACP_BASE_CAPABILITIES.reasoningLevels]
          : [...agent.reasoningLevels],
    },
    composerActions: [],
  };
}
