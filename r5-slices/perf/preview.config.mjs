import { createReadStream } from "node:fs";
import { resolve } from "node:path";
const app = resolve("apps/app");
const plugin = resolve("plugins/composer/dist");
const origin = (proxy) => {
  proxy.on("proxyReq", (req) =>
    req.setHeader("origin", "http://localhost:16706"),
  );
  proxy.on("proxyReqWs", (req) =>
    req.setHeader("origin", "http://localhost:16706"),
  );
};
export default {
  root: app,
  build: { outDir: app + "/dist" },
  plugins: [
    {
      name: "slice-composer-preview",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          const match = req.url?.match(
            /^\/api\/v1\/plugin-app-assets\/b8008bfe471efeaf\/(app\.(?:js|css))(?:\?.*)?$/,
          );
          if (!match) return next();
          res.setHeader(
            "Content-Type",
            match[1].endsWith(".js") ? "text/javascript" : "text/css",
          );
          res.setHeader("Cache-Control", "no-store");
          createReadStream(plugin + "/" + match[1]).pipe(res);
        });
      },
    },
  ],
  preview: {
    host: "127.0.0.1",
    port: 16820,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:24706",
        changeOrigin: true,
        configure: origin,
      },
      "/ws": {
        target: "http://127.0.0.1:24706",
        changeOrigin: true,
        ws: true,
        configure: origin,
      },
    },
  },
};
