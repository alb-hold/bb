import type { Plugin } from "vite";

export function initialThreadPreload(): Plugin {
  let base = "/";
  return {
    name: "bb:initial-thread-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        if (!bundle) return [];
        const route = new Set<string>();
        const terminal = new Set<string>();
        const panel = new Set<string>();
        const visit = (file: string, files: Set<string>) => {
          if (files.has(file)) return;
          files.add(file);
          const chunk = bundle[file];
          if (chunk?.type === "chunk") chunk.imports.forEach((dep) => visit(dep, files));
        };
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          const modules = Object.keys(chunk.modules);
          if (modules.some((id) => id.endsWith("/src/views/thread-detail/ThreadDetailView.tsx"))) {
            visit(chunk.fileName, route);
          }
          if (modules.some((id) => id.includes("/@xterm/") && !id.endsWith(".css"))) {
            visit(chunk.fileName, terminal);
          }
          if (modules.some((id) => id.endsWith("/src/components/thread/terminal/ThreadTerminalPanel.tsx"))) {
            visit(chunk.fileName, panel);
          }
        }
        const assets = JSON.stringify({
          route: [...route].map((file) => `${base}${file}`),
          terminal: [...terminal].map((file) => `${base}${file}`),
          panel: [...panel].map((file) => `${base}${file}`),
        }).replaceAll("<", "\\u003c");
        return [{
          tag: "script",
          attrs: { id: "bb-initial-thread-preload" },
          injectTo: "head-prepend",
          children: `(()=>{const match=/^(?:\\/projects\\/[^/]+)?\\/threads\\/([^/]+)\\/?$/.exec(location.pathname);if(!match)return;const assets=${assets};const seen=new Set();const preload=(files,priority="auto")=>{for(const href of files){if(seen.has(href))continue;seen.add(href);const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="";link.fetchPriority=priority;link.href=href;document.head.append(link)}};preload(assets.route);let threadId;try{threadId=decodeURIComponent(match[1])}catch{return}const timeout=setTimeout(()=>preload(assets.terminal,"low"),50);fetch("/api/v1/threads/"+encodeURIComponent(threadId)+"/native-terminal").then(r=>r.ok?r.json():null).then(view=>{clearTimeout(timeout);if(view&&typeof view==="object"&&view.threadId===threadId&&typeof view.providerId==="string"){preload(assets.terminal);preload(assets.panel)}}).catch(()=>{})})()`,
        }];
      },
    },
  };
}
