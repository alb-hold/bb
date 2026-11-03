import { register } from "tsx/esm/api";

register();
const { createConnection, migrate, upsertInstalledPlugin } = await import(
  "../../../../packages/db/src/index.ts"
);
const [databasePath, pluginDir] = process.argv.slice(2);
const db = createConnection(databasePath);
migrate(db);
upsertInstalledPlugin(db, {
  id: "stuck-dispose",
  source: `path:${pluginDir}`,
  provenance: { kind: "direct" },
  sourceIntent: { kind: "path", canonicalPath: pluginDir },
  exactResolution: { kind: "path" },
  updateState: {
    lastCheckAt: null,
    availableCompatibleVersion: null,
    newestIncompatibleVersion: null,
    statusDetail: null,
  },
  activeArtifactId: null,
  rootDir: pluginDir,
  version: "0.1.0",
  enabled: true,
  enabledFollowsDefault: false,
});
db.$client.close();
