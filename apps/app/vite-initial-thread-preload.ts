import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function initialThreadPreload(): Plugin {
  let base = "/";
  return {
    name: "bb:initial-thread-preload",
    apply: "build",
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: fileURLToPath(
          new URL("./src/lib/initial-terminal-connect.ts", import.meta.url),
        ),
        fileName: "assets/initial-terminal-connect.js",
      });
    },
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
        const entries: Record<string, string> = {};
        const visit = (file: string, files: Set<string>) => {
          if (files.has(file)) return;
          files.add(file);
          const chunk = bundle[file];
          if (chunk?.type === "chunk")
            chunk.imports.forEach((dep) => visit(dep, files));
        };
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          const modules = Object.keys(chunk.modules);
          if (
            modules.some((id) =>
              id.endsWith("/src/views/SplitWorkspaceRoute.tsx"),
            )
          ) {
            entries.workspace = `${base}${chunk.fileName}`;
            visit(chunk.fileName, route);
          }
          if (
            modules.some((id) =>
              id.endsWith("/src/views/thread-detail/ThreadDetailView.tsx"),
            )
          ) {
            entries.thread = `${base}${chunk.fileName}`;
            visit(chunk.fileName, route);
          }
          if (
            modules.some(
              (id) => id.includes("/@xterm/") && !id.endsWith(".css"),
            )
          ) {
            visit(chunk.fileName, terminal);
          }
          if (
            modules.some((id) =>
              id.endsWith(
                "/src/components/thread/terminal/ThreadTerminalPanel.tsx",
              ),
            )
          ) {
            entries.panel = `${base}${chunk.fileName}`;
            visit(chunk.fileName, panel);
          }
        }
        const assets = JSON.stringify({
          entries,
          route: [...route].map((file) => `${base}${file}`),
          terminal: [...terminal].map((file) => `${base}${file}`),
          panel: [...panel].map((file) => `${base}${file}`),
        }).replaceAll("<", "\\u003c");
        return [
          {
            tag: "script",
            attrs: { id: "bb-initial-thread-preload" },
            injectTo: "head-prepend",
            children: `(()=>{const match=/^(?:\\/projects\\/[^/]+)?\\/threads\\/([^/]+)\\/?$/.exec(location.pathname);if(!match)return;const assets=${assets};const seen=new Set();const preload=(files,priority="auto")=>{for(const href of files){if(seen.has(href))continue;seen.add(href);const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="";link.fetchPriority=priority;link.href=href;document.head.append(link)}};const warm=(name,href,files)=>{if(!href)return;const start=performance.now();performance.mark("terminal-head-"+name+"-import-start");import(href).then(()=>{const responses=files.flatMap(file=>performance.getEntriesByName(new URL(file,location.href).href,"resource")).map(entry=>entry.responseEnd);performance.mark("terminal-head-"+name+"-import-end",{detail:{elapsed:performance.now()-start,lastResponseEnd:Math.max(0,...responses),resources:responses.length}})},()=>performance.mark("terminal-head-"+name+"-import-failed"))};const whenRootExists=fn=>{if(document.getElementById("root")){fn();return}const observer=new MutationObserver(()=>{if(!document.getElementById("root"))return;observer.disconnect();fn()});observer.observe(document.documentElement,{childList:true,subtree:true})};let threadId;try{threadId=decodeURIComponent(match[1])}catch{return}const path="/api/v1/threads/"+encodeURIComponent(threadId)+"/native-terminal";globalThis.performance?.mark?.("terminal-initial-metadata-requested");const response=fetch(path,{priority:"high"});globalThis.__bbInitialNativeTerminalRequest={path,response};const lookup=response.then(r=>{globalThis.performance?.mark?.("terminal-initial-metadata-received");return r.ok?r.clone().json():null});preload(assets.route);whenRootExists(()=>{warm("workspace",assets.entries.workspace,assets.route);warm("thread",assets.entries.thread,assets.route)});const timeout=setTimeout(()=>preload(assets.terminal,"low"),50);lookup.then(view=>{clearTimeout(timeout);if(view&&typeof view==="object"&&view.threadId===threadId&&typeof view.providerId==="string"){const recordPath="/api/v1/threads/"+encodeURIComponent(threadId);globalThis.performance?.mark?.("terminal-head-thread-record-requested");const recordResponse=fetch(recordPath,{priority:"high"});globalThis.__bbInitialNativeTerminalRequest.thread={path:recordPath,response:recordResponse};recordResponse.then(()=>globalThis.performance?.mark?.("terminal-head-thread-record-received"),()=>{});preload(assets.terminal);preload(assets.panel);whenRootExists(()=>warm("panel",assets.entries.panel,assets.panel))}}).catch(()=>{})})()`,
          },
          {
            tag: "script",
            attrs: {
              id: "bb-initial-terminal-connect",
            },
            children: `if(globalThis.__bbInitialNativeTerminalRequest)import(${JSON.stringify(`${base}assets/initial-terminal-connect.js`)})`,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}
