import { build } from "esbuild";
import { resolve, relative } from "node:path";
import { expect, it } from "vitest";

it("keeps hidden panels, SDK UI, menu bodies and extended glyphs outside their startup import closures", async () => {
  const app = resolve(import.meta.dirname, "..");
  const entries = {
    home: "src/views/RootComposeView.tsx",
    model: "src/components/pickers/ModelReasoningPicker.tsx",
    voice: "src/components/promptbox/usePromptVoice.tsx",
    boot: "src/main.tsx",
    sdk: "src/lib/plugin-sdk-app-impl.tsx",
    thread: "src/components/thread/ThreadActionsMenu.tsx",
    picker: "src/components/pickers/OptionPicker.tsx",
    workspace: "src/views/SplitWorkspaceRoute.tsx",
    icons: "../../packages/shared-ui/src/components/ui/icon.tsx",
  };
  const result = await build({
    absWorkingDir: app,
    entryPoints: Object.values(entries),
    bundle: true,
    packages: "external",
    alias: {
      "@": resolve(app, "src"),
      "@bb/shared-ui/icon": resolve(
        app,
        "../../packages/shared-ui/src/components/ui/icon.tsx",
      ),
      "@bb/shared-ui/icon-extended": resolve(
        app,
        "../../packages/shared-ui/src/components/ui/icon-extended.tsx",
      ),
    },
    write: false,
    metafile: true,
    format: "esm",
    outdir: "startup-graph",
    loader: {
      ".css": "empty",
      ".md": "text",
      ".svg": "empty",
      ".png": "empty",
      ".woff2": "empty",
    },
    logLevel: "silent",
  });
  const graph = result.metafile.inputs;
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const visit = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      for (const dependency of graph[path]?.imports ?? []) {
        if (!dependency.external && dependency.kind !== "dynamic-import")
          visit(dependency.path);
      }
    };
    visit(relative(app, resolve(app, entry)));
    return seen;
  };
  const forbidden = {
    home: [
      "src/views/RootComposePanelTabContent.tsx",
      "src/hooks/useVoiceInput.ts",
      "src/components/pickers/ModelReasoningPickerBody.tsx",
    ],
    model: ["src/components/pickers/ModelReasoningPickerBody.tsx"],
    voice: [
      "src/hooks/useVoiceInput.ts",
      "src/components/promptbox/usePromptVoiceRuntime.tsx",
    ],
    boot: [
      "src/hooks/useVoiceInput.ts",
      "src/components/pickers/ModelReasoningPickerBody.tsx",
    ],
    sdk: [
      "src/components/plugin/PluginNewThreadComposer.tsx",
      "src/components/plugin/PluginProviderModelPicker.tsx",
      "src/components/plugin/PluginPermissionModePicker.tsx",
      "src/components/plugin/PluginBranchPicker.tsx",
      "src/components/ui/image-lightbox.tsx",
    ],
    thread: [
      "src/components/thread/ThreadMenuItems.tsx",
      "src/components/thread/ThreadActionMenuItems.tsx",
    ],
    picker: ["src/components/pickers/OptionPickerItems.tsx"],
    workspace: ["../../packages/shared-ui/src/components/ui/icon-extended.tsx"],
    icons: ["../../packages/shared-ui/src/components/ui/icon-extended.tsx"],
  };
  for (const [entry, source] of Object.entries(entries)) {
    const eager = closure(source);
    expect(eager.size).toBeGreaterThan(1);
    for (const hidden of forbidden[entry as keyof typeof forbidden])
      expect(eager.has(hidden), `${entry} statically imports ${hidden}`).toBe(
        false,
      );
  }
});
