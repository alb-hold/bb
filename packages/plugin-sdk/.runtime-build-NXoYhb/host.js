// src/host-contract.ts
function experimental_defineHostEntry(args) {
  return {
    experimental_apiVersion: 1,
    contract: args.contract,
    handlers: args.handlers,
    ...args.experimental_signals === void 0 ? {} : { experimental_signals: args.experimental_signals },
    ...args.dispose === void 0 ? {} : { dispose: args.dispose }
  };
}

// src/native-roots-contract.ts
import { z as z2 } from "zod";

// ../domain/src/provider-skill-roots.ts
function isAbsoluteProviderSkillRootPath(value) {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  const drive = /^[a-zA-Z]:\//u.exec(normalized);
  const rest = drive ? normalized.slice(drive[0].length) : normalized.slice(1);
  if (!drive && !normalized.startsWith("/")) {
    return false;
  }
  return rest.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function isRelativeProviderSkillRootPath(value) {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[a-zA-Z]:\//u.test(normalized) && normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// ../domain/src/native-roots.ts
import { z } from "zod";
var PROVIDER_NATIVE_ROOTS_MAX = 32;
var PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}:$/u;
var nativeRootNamePrefixSchema = z.string().refine(
  (value) => value === "" || PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN.test(value),
  "A root name prefix is a plugin-name-like token ending in ':'"
);
var nativeRootManifestPathSchema = z.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "A manifest marker is a relative path without dot segments"
);
var relativeNativeRootPathSchema = z.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Roots must be relative paths without dot segments"
);
var absoluteNativeRootPathSchema = z.string().min(1).refine(
  isAbsoluteProviderSkillRootPath,
  "Absolute roots must be absolute paths without dot segments"
);
var providerNativeRootInputSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    /** Skills nest in subdirectories (the agent scans recursively). */
    recursive: z.boolean().optional(),
    /**
     * Scan the same relative directory in every ancestor of the workspace
     * up to the repository root (`project` roots only).
     */
    ancestors: z.boolean().optional(),
    /**
     * Prepended to every name under the root, a vendor plugin's
     * `plugin-name:`; a prefixed root is listed as a plugin root.
     */
    namePrefix: nativeRootNamePrefixSchema.optional(),
    /**
     * A file, relative to a skill directory under this root, that marks the
     * directory as a vendor plugin rather than a skill (Claude's
     * `.claude-plugin/plugin.json`): bb skips such a directory. The plugin
     * that knows the vendor layout declares it; core names no vendor path.
     */
    skipIfManifest: nativeRootManifestPathSchema.optional()
  }).strict()
]);
var providerNativeRootsInputSchema = z.object({
  user: z.array(providerNativeRootInputSchema).optional(),
  project: z.array(providerNativeRootInputSchema).optional()
}).strict();
var providerNativeRootSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean(),
  ancestors: z.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  /** Absent: every skill-shaped directory under the root is a skill. */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
function uniqueByPath(roots) {
  return new Set(roots.map((root) => root.path)).size === roots.length;
}
function nativeRootSideSchema(side) {
  return z.array(
    providerNativeRootSchema.extend({ path: relativeNativeRootPathSchema }).superRefine((root, context) => {
      if (root.ancestors && side !== "project") {
        context.addIssue({
          code: "custom",
          message: "Only project roots may walk ancestors"
        });
      }
    })
  ).max(PROVIDER_NATIVE_ROOTS_MAX).refine(uniqueByPath, "Roots must not repeat a path");
}
var providerNativeRootsSchema = z.object({
  user: nativeRootSideSchema("user"),
  project: nativeRootSideSchema("project")
}).strict();
var EMPTY_PROVIDER_NATIVE_ROOTS = Object.freeze({
  user: Object.freeze([]),
  project: Object.freeze([])
});
var providerResolvedNativeRootShapeSchema = z.enum([
  "skills",
  "skill",
  "skill-file",
  "commands",
  "command-file"
]);
var resolvedNativeRootFieldsSchema = z.object({
  path: absoluteNativeRootPathSchema,
  origin: z.enum(["user", "project"]),
  recursive: z.boolean(),
  /** Only with origin `project`, for a path inside the workspace. */
  ancestors: z.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  shape: providerResolvedNativeRootShapeSchema,
  /**
   * `skill-file` only: the skill name when the file's frontmatter names
   * none. A vendor plugin's root SKILL.md takes the plugin's name; absent
   * means the parent directory's name.
   */
  fallbackName: z.string().min(1).optional(),
  /**
   * `skills` only: a file, relative to a skill directory under this root,
   * that marks the directory as a vendor plugin rather than a skill; the
   * daemon skips such a directory (see the declared root's `skipIfManifest`).
   */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
var providerResolvedNativeRootSchema = resolvedNativeRootFieldsSchema.superRefine((root, context) => {
  if (root.skipIfManifest !== void 0 && root.shape !== "skills") {
    context.addIssue({
      code: "custom",
      message: "Only a skills root carries a manifest marker"
    });
  }
  if (root.ancestors && root.origin !== "project") {
    context.addIssue({
      code: "custom",
      message: "Only project roots may walk ancestors"
    });
  }
  if (root.fallbackName !== void 0 && root.shape !== "skill-file") {
    context.addIssue({
      code: "custom",
      message: "Only a skill-file root carries a fallback name"
    });
  }
});
var providerResolvedNativeRootInputSchema = resolvedNativeRootFieldsSchema.partial({
  recursive: true,
  ancestors: true,
  namePrefix: true,
  shape: true
});
function normalizeProviderResolvedNativeRoot(root, side) {
  return {
    path: root.path,
    origin: root.origin,
    recursive: root.recursive ?? false,
    ancestors: root.ancestors ?? false,
    namePrefix: root.namePrefix ?? "",
    shape: root.shape ?? (side === "skills" ? "skills" : "commands"),
    ...root.fallbackName === void 0 ? {} : { fallbackName: root.fallbackName },
    ...side === "skills" && root.skipIfManifest !== void 0 ? { skipIfManifest: root.skipIfManifest } : {}
  };
}
var resolvedSkillShapes = /* @__PURE__ */ new Set([
  "skills",
  "skill",
  "skill-file"
]);
var resolvedCommandShapes = /* @__PURE__ */ new Set([
  "commands",
  "command-file"
]);
var PROVIDER_RESOLVED_NATIVE_ROOTS_MAX = 256;
var providerResolvedNativeRootsSchema = z.object({
  skills: z.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedSkillShapes.has(root.shape),
      "A skills root needs a skill shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX),
  commands: z.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedCommandShapes.has(root.shape),
      "A commands root needs a command shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX)
}).strict();
var EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS = Object.freeze({
  skills: Object.freeze([]),
  commands: Object.freeze([])
});
var providerNativeRootSetSchema = z.object({
  skills: providerNativeRootsSchema,
  commands: providerNativeRootsSchema,
  resolved: providerResolvedNativeRootsSchema
}).strict();

// src/rpc-contract.ts
function defineRpcContract(contract) {
  return contract;
}

// src/native-roots-contract.ts
var experimental_nativeRootsResolveInputSchema = z2.object({
  /**
   * The provider being listed. One plugin may register several providers
   * (the ACP plugin registers one per agent) from one host entry.
   */
  providerId: z2.string().min(1),
  /** The workspace, or null when bb lists without one (user roots only). */
  cwd: z2.string().min(1).nullable()
}).strict();
var experimental_nativeRootsResolveOutputSchema = z2.object({
  skills: z2.array(providerResolvedNativeRootInputSchema).optional(),
  commands: z2.array(providerResolvedNativeRootInputSchema).optional()
}).strict().transform((value) => ({
  skills: (value.skills ?? []).slice(0, PROVIDER_RESOLVED_NATIVE_ROOTS_MAX).map((root) => normalizeProviderResolvedNativeRoot(root, "skills")),
  commands: (value.commands ?? []).slice(0, PROVIDER_RESOLVED_NATIVE_ROOTS_MAX).map((root) => normalizeProviderResolvedNativeRoot(root, "commands"))
})).pipe(providerResolvedNativeRootsSchema);
function describeIssues(issues) {
  return issues.map(
    (issue) => issue.path.length === 0 ? issue.message : `${issue.path.map(String).join(".")}: ${issue.message}`
  ).join("; ");
}
function filterResolvedRootSide(side, roots, dropped, warn, warned) {
  const rootSchema = providerResolvedNativeRootsSchema.shape[side].element;
  const kept = [];
  for (const root of roots) {
    const shape = providerResolvedNativeRootInputSchema.safeParse(root);
    const result = shape.success ? rootSchema.safeParse(normalizeProviderResolvedNativeRoot(root, side)) : shape;
    if (result.success) {
      kept.push(root);
      continue;
    }
    const reason = describeIssues(result.error.issues);
    dropped.push({ side, path: root.path, reason });
    warnOnce(
      warned,
      warn,
      `${side}\0${root.path}\0${reason}`,
      `resolveNativeRoots: dropped the ${side} root "${root.path}": ${reason}`
    );
  }
  if (kept.length <= PROVIDER_RESOLVED_NATIVE_ROOTS_MAX) {
    return { kept, truncated: 0 };
  }
  const truncated = kept.length - PROVIDER_RESOLVED_NATIVE_ROOTS_MAX;
  warnOnce(
    warned,
    warn,
    `${side}\0truncated\0${kept.length}`,
    `resolveNativeRoots: kept the first ${PROVIDER_RESOLVED_NATIVE_ROOTS_MAX} of ${kept.length} ${side} roots; dropped ${truncated} from "${kept[PROVIDER_RESOLVED_NATIVE_ROOTS_MAX]?.path}" on`
  );
  return { kept: kept.slice(0, PROVIDER_RESOLVED_NATIVE_ROOTS_MAX), truncated };
}
var warnedForWorker = /* @__PURE__ */ new Set();
function warnOnce(warned, warn, key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}
function experimental_filterResolvedNativeRoots(answer, options) {
  const dropped = [];
  const warned = options.warned ?? warnedForWorker;
  const skills = filterResolvedRootSide(
    "skills",
    answer.skills ?? [],
    dropped,
    options.warn,
    warned
  );
  const commands = filterResolvedRootSide(
    "commands",
    answer.commands ?? [],
    dropped,
    options.warn,
    warned
  );
  return {
    answer: { skills: skills.kept, commands: commands.kept },
    dropped,
    truncated: { skills: skills.truncated, commands: commands.truncated }
  };
}
var experimental_nativeRootsHostContract = defineRpcContract({
  resolveNativeRoots: {
    input: experimental_nativeRootsResolveInputSchema,
    output: experimental_nativeRootsResolveOutputSchema
  }
});

// src/vendor-plugin-roots.ts
import fs from "node:fs/promises";
import path from "node:path";
import { z as z3 } from "zod";
var RootCollector = class {
  skills = [];
  commands = [];
  seen = {
    skills: /* @__PURE__ */ new Set(),
    commands: /* @__PURE__ */ new Set()
  };
  add(side, root) {
    if (this.seen[side].has(root.path)) {
      return;
    }
    this.seen[side].add(root.path);
    this[side].push(root);
  }
};
function normalizePluginPathList(value) {
  if (value === void 0) {
    return [];
  }
  return typeof value === "string" ? [value] : [...value];
}
function isPathWithinDirectory(directoryPath, candidatePath) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === "" || !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
function resolvePluginRelativePath(pluginRootPath, relativePath) {
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const resolvedPath = path.resolve(pluginRootPath, relativePath);
  return isPathWithinDirectory(pluginRootPath, resolvedPath) ? resolvedPath : null;
}
async function resolvePluginComponentKind(componentPath, origin) {
  try {
    const stat = await fs.lstat(componentPath);
    if (stat.isFile()) {
      return "file";
    }
    if (stat.isDirectory()) {
      return "directory";
    }
    if (!stat.isSymbolicLink() || origin !== "user") {
      return "missing";
    }
    const targetStat = await fs.stat(componentPath);
    if (targetStat.isFile()) {
      return "file";
    }
    return targetStat.isDirectory() ? "directory" : "missing";
  } catch {
    return "missing";
  }
}
async function resolveSkillDirectoryShape(componentPath, origin) {
  const skillFileKind = await resolvePluginComponentKind(
    path.join(componentPath, "SKILL.md"),
    origin
  );
  return skillFileKind === "file" ? "skill" : "skills";
}
async function addConventionalRoots(collector, plugin, namePrefix) {
  const rootSkillFilePath = path.join(plugin.rootPath, "SKILL.md");
  const rootSkillFileKind = await resolvePluginComponentKind(
    rootSkillFilePath,
    plugin.origin
  );
  if (rootSkillFileKind === "file") {
    collector.add("skills", {
      path: rootSkillFilePath,
      origin: plugin.origin,
      namePrefix,
      shape: "skill-file",
      fallbackName: plugin.name
    });
  }
  const skillsRootPath = path.join(plugin.rootPath, "skills");
  const skillsRootKind = await resolvePluginComponentKind(
    skillsRootPath,
    plugin.origin
  );
  if (skillsRootKind === "directory") {
    collector.add("skills", {
      path: skillsRootPath,
      origin: plugin.origin,
      namePrefix,
      shape: "skills"
    });
  }
  const commandsRootPath = path.join(plugin.rootPath, "commands");
  const commandsRootStat = await fs.lstat(commandsRootPath).catch(() => null);
  if (commandsRootStat?.isDirectory()) {
    collector.add("commands", {
      path: commandsRootPath,
      origin: plugin.origin,
      namePrefix,
      shape: "commands"
    });
  }
}
async function addManifestSkillRoots(collector, plugin, namePrefix, recursive) {
  for (const entry of normalizePluginPathList(plugin.skills)) {
    const componentPath = resolvePluginRelativePath(plugin.rootPath, entry);
    if (componentPath === null) {
      continue;
    }
    const componentKind = await resolvePluginComponentKind(
      componentPath,
      plugin.origin
    );
    if (componentKind === "file" && path.basename(componentPath) === "SKILL.md") {
      collector.add("skills", {
        path: componentPath,
        origin: plugin.origin,
        namePrefix,
        shape: "skill-file"
      });
      continue;
    }
    if (componentKind !== "directory") {
      continue;
    }
    if (recursive) {
      collector.add("skills", {
        path: componentPath,
        origin: plugin.origin,
        recursive: true,
        namePrefix,
        shape: "skills"
      });
      continue;
    }
    collector.add("skills", {
      path: componentPath,
      origin: plugin.origin,
      namePrefix,
      shape: await resolveSkillDirectoryShape(componentPath, plugin.origin)
    });
  }
}
async function addManifestCommandRoots(collector, plugin, namePrefix) {
  for (const entry of normalizePluginPathList(plugin.commands)) {
    const componentPath = resolvePluginRelativePath(plugin.rootPath, entry);
    if (componentPath === null) {
      continue;
    }
    const stat = await fs.lstat(componentPath).catch(() => null);
    if (stat === null) {
      continue;
    }
    if (stat.isFile() && componentPath.endsWith(".md")) {
      collector.add("commands", {
        path: componentPath,
        origin: plugin.origin,
        namePrefix,
        shape: "command-file"
      });
      continue;
    }
    if (stat.isDirectory()) {
      collector.add("commands", {
        path: componentPath,
        origin: plugin.origin,
        namePrefix,
        shape: "commands"
      });
    }
  }
}
async function experimental_resolveVendorPluginRoots(args) {
  const collector = new RootCollector();
  for (const plugin of args.plugins) {
    const namePrefix = `${plugin.name}:`;
    if (args.layout === "claude") {
      await addConventionalRoots(collector, plugin, namePrefix);
    }
    await addManifestSkillRoots(
      collector,
      plugin,
      namePrefix,
      args.layout === "grok"
    );
    await addManifestCommandRoots(collector, plugin, namePrefix);
  }
  return { skills: collector.skills, commands: collector.commands };
}
var CLAUDE_DIR_NAME = ".claude";
var CLAUDE_PLUGIN_MANIFEST_PATH = path.join(".claude-plugin", "plugin.json");
var CLAUDE_PLUGIN_INSTALLED_FILE_NAME = "installed_plugins.json";
var claudePluginScopeSchema = z3.enum(["managed", "project", "local", "user"]);
var claudeSettingsSchema = z3.object({
  enabledPlugins: z3.record(z3.string(), z3.boolean()).optional()
}).passthrough();
var claudeInstalledPluginEntrySchema = z3.object({
  gitCommitSha: z3.string().nullable().optional(),
  installPath: z3.string().min(1),
  scope: claudePluginScopeSchema
}).passthrough();
var claudeInstalledPluginsFileSchema = z3.object({
  plugins: z3.record(z3.string(), z3.array(claudeInstalledPluginEntrySchema))
}).passthrough();
var claudePluginPathListSchema = z3.union([z3.string(), z3.array(z3.string())]);
var claudePluginManifestSchema = z3.object({
  name: z3.string().min(1).optional(),
  defaultEnabled: z3.boolean().optional(),
  skills: claudePluginPathListSchema.optional(),
  commands: claudePluginPathListSchema.optional()
}).passthrough();
function resolveStoredPath(homeDir, storedPath) {
  if (storedPath === "~") {
    return homeDir;
  }
  if (storedPath.startsWith("~/")) {
    return path.join(homeDir, storedPath.slice(2));
  }
  return path.resolve(homeDir, storedPath);
}
function resolveClaudeConfigDir(homeDir, env) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolveStoredPath(homeDir, configured) : path.join(homeDir, CLAUDE_DIR_NAME);
}
async function readJsonFile(filePath, schema) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsedJson;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}
async function readDirectoryEntries(directoryPath) {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function directoryHasClaudePluginManifest(directoryPath) {
  try {
    const stat = await fs.lstat(
      path.join(directoryPath, CLAUDE_PLUGIN_MANIFEST_PATH)
    );
    return stat.isFile();
  } catch {
    return false;
  }
}
function readClaudePluginManifest(pluginRootPath) {
  return readJsonFile(
    path.join(pluginRootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    claudePluginManifestSchema
  );
}
function parseMarketplacePluginId(pluginId) {
  const separatorIndex = pluginId.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === pluginId.length - 1) {
    return null;
  }
  return {
    pluginName: pluginId.slice(0, separatorIndex),
    marketplaceName: pluginId.slice(separatorIndex + 1)
  };
}
function originForClaudePluginScope(scope) {
  return scope === "project" || scope === "local" ? "project" : "user";
}
function shouldIncludeInstalledClaudePlugin(cwd, plugin) {
  if (plugin.scope === "managed" || plugin.scope === "user") {
    return true;
  }
  return cwd !== null && isPathWithinDirectory(cwd, plugin.installPath);
}
async function readClaudeEnabledPluginSettings(settingsFiles) {
  const enabledPlugins = /* @__PURE__ */ new Map();
  for (const settingsFile of settingsFiles) {
    const settings = await readJsonFile(settingsFile, claudeSettingsSchema);
    for (const [pluginId, enabled] of Object.entries(
      settings?.enabledPlugins ?? {}
    )) {
      enabledPlugins.set(pluginId, enabled);
    }
  }
  return enabledPlugins;
}
function resolveClaudeSettingsFiles(dirs) {
  const files = [path.join(dirs.claudeDir, "settings.json")];
  if (dirs.cwd !== null) {
    files.push(
      path.join(dirs.cwd, CLAUDE_DIR_NAME, "settings.json"),
      path.join(dirs.cwd, CLAUDE_DIR_NAME, "settings.local.json")
    );
  }
  return files;
}
async function readClaudeInstalledPluginReferences(dirs) {
  const installedPlugins = await readJsonFile(
    path.join(dirs.claudeDir, "plugins", CLAUDE_PLUGIN_INSTALLED_FILE_NAME),
    claudeInstalledPluginsFileSchema
  );
  if (!installedPlugins) {
    return [];
  }
  const references = [];
  for (const [id, entries] of Object.entries(installedPlugins.plugins)) {
    for (const entry of entries) {
      references.push({
        id,
        installPath: resolveStoredPath(dirs.homeDir, entry.installPath),
        scope: entry.scope,
        gitCommitSha: entry.gitCommitSha ?? null
      });
    }
  }
  return references;
}
async function findFallbackClaudePluginRoot(dirs, plugin) {
  const pluginId = parseMarketplacePluginId(plugin.id);
  if (!pluginId) {
    return null;
  }
  const pluginCacheRootPath = path.join(
    dirs.claudeDir,
    "plugins",
    "cache",
    pluginId.marketplaceName,
    pluginId.pluginName
  );
  const candidates = [];
  for (const entry of await readDirectoryEntries(pluginCacheRootPath)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidatePath = path.join(pluginCacheRootPath, entry.name);
    if (!await directoryHasClaudePluginManifest(candidatePath)) {
      continue;
    }
    try {
      const stat = await fs.stat(candidatePath);
      candidates.push({ rootPath: candidatePath, modifiedAtMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  const commitPrefix = plugin.gitCommitSha?.slice(0, 12);
  if (commitPrefix) {
    const commitMatch = candidates.find(
      (candidate) => path.basename(candidate.rootPath).startsWith(commitPrefix)
    );
    if (commitMatch) {
      return commitMatch.rootPath;
    }
  }
  return candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0]?.rootPath ?? null;
}
function isPluginEnabled(enabledPlugins, pluginId, manifest) {
  return enabledPlugins.get(pluginId) ?? manifest.defaultEnabled ?? true;
}
function vendorPlugin(rootPath, name, origin, manifest) {
  return {
    rootPath,
    name,
    origin,
    skills: manifest.skills,
    commands: manifest.commands
  };
}
async function resolveInstalledClaudePlugins(dirs, enabledPlugins) {
  const plugins = [];
  for (const plugin of await readClaudeInstalledPluginReferences(dirs)) {
    if (!shouldIncludeInstalledClaudePlugin(dirs.cwd, plugin)) {
      continue;
    }
    const rootPath = await directoryHasClaudePluginManifest(
      plugin.installPath
    ) ? plugin.installPath : await findFallbackClaudePluginRoot(dirs, plugin);
    if (rootPath === null) {
      continue;
    }
    const manifest = await readClaudePluginManifest(rootPath);
    if (!manifest || !isPluginEnabled(enabledPlugins, plugin.id, manifest)) {
      continue;
    }
    const pluginId = parseMarketplacePluginId(plugin.id);
    plugins.push(
      vendorPlugin(
        rootPath,
        manifest.name ?? pluginId?.pluginName ?? path.basename(rootPath),
        originForClaudePluginScope(plugin.scope),
        manifest
      )
    );
  }
  return plugins;
}
async function isSkillsDirectoryPluginEntry(entry, entryPath, origin) {
  if (entry.isDirectory()) {
    return directoryHasClaudePluginManifest(entryPath);
  }
  if (!entry.isSymbolicLink() || origin !== "user") {
    return false;
  }
  try {
    const stat = await fs.stat(entryPath);
    return stat.isDirectory() && await directoryHasClaudePluginManifest(entryPath);
  } catch {
    return false;
  }
}
async function resolveSkillsDirectoryClaudePlugins(skillsRootPath, origin, enabledPlugins) {
  const plugins = [];
  const entries = (await readDirectoryEntries(skillsRootPath)).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    const pluginRootPath = path.join(skillsRootPath, entry.name);
    if (!await isSkillsDirectoryPluginEntry(entry, pluginRootPath, origin)) {
      continue;
    }
    const manifest = await readClaudePluginManifest(pluginRootPath);
    if (!manifest) {
      continue;
    }
    const pluginName = manifest.name ?? entry.name;
    if (!isPluginEnabled(enabledPlugins, `${pluginName}@skills-dir`, manifest)) {
      continue;
    }
    plugins.push(vendorPlugin(pluginRootPath, pluginName, origin, manifest));
  }
  return plugins;
}
async function experimental_resolveClaudePluginRoots(args) {
  const dirs = {
    claudeDir: resolveClaudeConfigDir(args.homeDir, args.env),
    cwd: args.cwd === null ? null : path.resolve(args.cwd),
    homeDir: args.homeDir
  };
  const enabledPlugins = await readClaudeEnabledPluginSettings(
    resolveClaudeSettingsFiles(dirs)
  );
  const plugins = await resolveInstalledClaudePlugins(dirs, enabledPlugins);
  if (dirs.cwd !== null) {
    plugins.push(
      ...await resolveSkillsDirectoryClaudePlugins(
        path.join(dirs.cwd, CLAUDE_DIR_NAME, "skills"),
        "project",
        enabledPlugins
      )
    );
  }
  plugins.push(
    ...await resolveSkillsDirectoryClaudePlugins(
      path.join(dirs.claudeDir, "skills"),
      "user",
      enabledPlugins
    )
  );
  const roots = await experimental_resolveVendorPluginRoots({
    plugins,
    layout: "claude"
  });
  return { claudeDir: dirs.claudeDir, ...roots };
}

// ../process-utils/src/spawn.ts
import crossSpawn from "cross-spawn";
function spawnPortableProcess(request) {
  return crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide: true
  });
}
function assertPortableOutputProcess(child) {
  if (child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach output-only stdio");
  }
}
function spawnPortableOutputProcess(request) {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["ignore", "pipe", "pipe"]
  });
  assertPortableOutputProcess(child);
  return child;
}

// ../process-utils/src/cwd-processes.ts
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
function isPathUnderDirectory(candidate, directory) {
  const normalized = candidate.endsWith(" (deleted)") ? candidate.slice(0, -" (deleted)".length) : candidate;
  return normalized === directory || normalized.startsWith(`${directory}${sep}`);
}
async function listLinuxProcessCwds() {
  const entries = await readdir("/proc");
  const results = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) {
        return;
      }
      try {
        const cwd = await readlink(`/proc/${entry}/cwd`);
        results.push({ pid: Number(entry), cwd });
      } catch {
      }
    })
  );
  return results;
}
async function listLsofProcessCwds() {
  const child = spawnPortableOutputProcess({
    command: "lsof",
    args: ["-a", "-d", "cwd", "-F", "pn", "-w", "-n"]
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.resume();
  await new Promise((resolveExit) => {
    child.once("error", () => resolveExit());
    child.once("exit", () => resolveExit());
  });
  const results = [];
  let pid = null;
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      results.push({ pid, cwd: line.slice(1) });
    }
  }
  return results;
}
async function resolveSweepDirectory(directory) {
  const resolved = resolve(directory);
  let ancestor = dirname(resolved);
  const missing = [basename(resolved)];
  for (; ; ) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch {
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonical = join(ancestor, ...missing);
  try {
    if ((await lstat(canonical)).isSymbolicLink()) {
      return null;
    }
  } catch {
  }
  return canonical;
}
async function listProcessesWithCwdUnder(args) {
  if (process.platform === "win32") {
    return [];
  }
  const directories = (await Promise.all(args.directories.map(resolveSweepDirectory))).filter((directory) => directory !== null);
  if (directories.length === 0) {
    return [];
  }
  const all = process.platform === "linux" ? await listLinuxProcessCwds() : await listLsofProcessCwds();
  return all.filter(
    (entry) => entry.pid !== process.pid && directories.some(
      (directory) => isPathUnderDirectory(entry.cwd, directory)
    )
  );
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
var MAX_CWD_SWEEP_ROUNDS = 5;
function signalProcesses(targets, signal, signalled) {
  for (const target of targets) {
    try {
      process.kill(target.pid, signal);
      signalled.set(target.pid, target);
    } catch {
    }
  }
}
async function killProcessesWithCwdUnder(args) {
  const graceMs = args.graceMs ?? 2e3;
  const signalled = /* @__PURE__ */ new Map();
  for (let round = 0; round < MAX_CWD_SWEEP_ROUNDS; round += 1) {
    const targets = await listProcessesWithCwdUnder({
      directories: args.directories
    });
    if (targets.length === 0) {
      break;
    }
    signalProcesses(targets, "SIGTERM", signalled);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && targets.some((target) => isProcessAlive(target.pid))) {
      await delay(50);
    }
    const survivors = await listProcessesWithCwdUnder({
      directories: args.directories
    });
    if (survivors.length === 0) {
      break;
    }
    signalProcesses(survivors, "SIGKILL", signalled);
    await delay(50);
  }
  return Array.from(signalled.values());
}

// ../process-utils/src/environment.ts
function sanitizeInheritedChildProcessEnv(args) {
  const sanitizedEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === void 0) {
      continue;
    }
    const normalizedKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (normalizedKey === "NODE_ENV" || normalizedKey.startsWith("BB_")) {
      continue;
    }
    sanitizedEnv[normalizedKey === "PATH" ? "PATH" : key] = value;
  }
  if (args.shellPath !== void 0) {
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

// ../process-utils/src/process-info.ts
import { execFile } from "node:child_process";
import path2 from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return readWindowsProcess(pid);
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "etime=", "-o", "command="],
      {
        timeout: 5e3,
        maxBuffer: 1024 * 1024
      }
    );
    const match = stdout.trim().match(/^(\S+)\s+([\s\S]+)$/u);
    if (match === null) return null;
    const elapsed = parseElapsedSeconds(match[1] ?? "");
    return {
      command: match[2] ?? null,
      startedAt: elapsed === null ? null : Date.now() - elapsed * 1e3
    };
  } catch {
    return null;
  }
}
async function readWindowsProcess(pid) {
  try {
    const pending = execFileAsync(
      path2.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { @{ command = $_.CommandLine; startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`
        ].join("; ")
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3e4,
        maxBuffer: 1024 * 1024
      }
    );
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const value = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || !("command" in value) || !("startedAt" in value) || typeof value.command !== "string" && value.command !== null || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))
      return null;
    return { command: value.command, startedAt: value.startedAt };
  } catch {
    return null;
  }
}
function parseElapsedSeconds(rawElapsed) {
  const match = rawElapsed.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/u);
  if (match === null) {
    return null;
  }
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

// ../process-utils/src/performance-diagnostics.ts
import { Session } from "node:inspector/promises";
var PROFILE_RETENTION_MS = 12 * 60 * 60 * 1e3;
var MAX_PROFILE_BYTES = 12 * 1024 * 1024;

// src/kill-processes.ts
function experimental_killProcessesWithCwdUnder(args) {
  if ("directory" in args && typeof args.directory === "string")
    return killProcessesWithCwdUnder({
      ...args,
      directories: [args.directory]
    });
  return killProcessesWithCwdUnder(args);
}

// src/process-identity.ts
function experimental_readProcessIdentity(pid) {
  return readProcessIdentity(pid);
}
export {
  experimental_defineHostEntry,
  experimental_filterResolvedNativeRoots,
  experimental_killProcessesWithCwdUnder,
  experimental_nativeRootsHostContract,
  experimental_nativeRootsResolveInputSchema,
  experimental_nativeRootsResolveOutputSchema,
  experimental_readProcessIdentity,
  experimental_resolveClaudePluginRoots,
  experimental_resolveVendorPluginRoots,
  sanitizeInheritedChildProcessEnv as experimental_sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess as experimental_spawnPortableOutputProcess
};
