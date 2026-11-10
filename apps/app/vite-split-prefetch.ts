import type { Plugin } from "vite";

export function splitPrefetch(entries: Record<string, string>): Plugin {
  let base = "/";
  return {
    name: "bb:split-prefetch",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        if (bundle === undefined) return [];
        return Object.entries(entries).map(([id, modulePath]) => {
          const entry = Object.values(bundle).find(
            (chunk) =>
              chunk.type === "chunk" &&
              Object.keys(chunk.modules).some((module) =>
                module.endsWith(`/${modulePath}`),
              ),
          );
          if (entry === undefined)
            throw new Error(`Missing prefetch split: ${id}`);
          const files = new Set<string>();
          const seen = new Set<string>();
          const visit = (fileName: string) => {
            if (seen.has(fileName)) return;
            seen.add(fileName);
            const chunk = bundle[fileName];
            if (chunk?.type === "chunk") chunk.imports.forEach(visit);
            files.add(fileName);
          };
          visit(entry.fileName);
          return {
            tag: "script",
            attrs: { type: "application/json", id: `bb-prefetch-${id}` },
            children: JSON.stringify(
              [...files].map((file) => `${base}${file}`),
            ).replaceAll("<", "\\u003c"),
            injectTo: "head" as const,
          };
        });
      },
    },
  };
}
