import { parentPort } from "node:worker_threads";
import { renderTerminalScreenInline } from "./terminal-screen-render.js";

if (!parentPort) throw new Error("Terminal screen worker requires a parent port");

parentPort.on("message", async (message: {
  id: number;
  args: Parameters<typeof renderTerminalScreenInline>[0];
}) => {
  try {
    const result = await renderTerminalScreenInline(message.args);
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
