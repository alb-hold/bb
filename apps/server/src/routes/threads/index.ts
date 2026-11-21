import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import type { ResolvePluginRpcCaller } from "../../request-context.js";
import { registerThreadActionRoutes } from "./actions.js";
import { registerThreadBaseRoutes } from "./base.js";
import { registerThreadDataRoutes } from "./data.js";
import { registerThreadInteractionRoutes } from "./interactions.js";
import { registerThreadTabRoutes } from "./tabs.js";
import { registerThreadRowStateRoutes } from "./row-state.js";

export function registerThreadRoutes(
  app: Hono,
  deps: AppDeps,
  plugins: { resolveRpcCaller: ResolvePluginRpcCaller },
): void {
  registerThreadBaseRoutes(app, deps, plugins);
  registerThreadActionRoutes(app, deps, plugins);
  registerThreadDataRoutes(app, deps);
  registerThreadInteractionRoutes(app, deps);
  registerThreadTabRoutes(app, deps);
  registerThreadRowStateRoutes(app, deps);
}
