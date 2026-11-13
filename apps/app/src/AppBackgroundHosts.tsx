import { defineSplit } from "@/lib/define-split";

export const AppUpdateHost = defineSplit({
  id: "app-update-host",
  load: () =>
    import("./components/app-update/AppUpdateHost").then(
      (module) => module.AppUpdateHost,
    ),
  loading: () => null,
  error: () => null,
  tier: "intent",
});

export const ServerMoveOverlay = defineSplit({
  id: "server-move-overlay",
  load: () =>
    import("./components/machines/ServerMoveOverlay").then(
      (module) => module.ServerMoveOverlay,
    ),
  loading: () => null,
  error: () => null,
  tier: "intent",
});
