import { createTerminalDataPlaneUpgrade } from "./child-upgrade.js";
import { TerminalDataPlaneChild } from "./data-plane-child.js";

function runTerminalDataPlaneChild(): void {
  if (process.send === undefined) {
    throw new Error(
      "The terminal data plane child must be started with an IPC channel",
    );
  }
  const child = new TerminalDataPlaneChild({
    exit: () => process.exit(0),
    rssBytes: () => process.memoryUsage.rss(),
    sendToMain: (message, onSent) => {
      if (!process.connected || process.send === undefined) {
        onSent();
        return;
      }
      try {
        process.send(message, undefined, undefined, () => onSent());
      } catch {
        onSent();
        child.shutdown();
      }
    },
    upgrade: createTerminalDataPlaneUpgrade(),
  });
  process.on("message", (raw, handle) => child.handleMainMessage(raw, handle));
  process.on("disconnect", () => child.shutdown());
  child.start();
}

runTerminalDataPlaneChild();
