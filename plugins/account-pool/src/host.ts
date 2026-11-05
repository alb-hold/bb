import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { accountPoolHostContract } from "./host-contract.js";
import { createHostProxy } from "./host-proxy.js";

const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

function mergedNoProxy(
  existing: string | undefined,
  serverUrl: string,
): string {
  const entries = (existing ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  let hubHost: string[] = [];
  try {
    hubHost = [new URL(serverUrl).hostname.replace(/^\[|\]$/gu, "")];
  } catch {
    hubHost = [];
  }
  return [...new Set([...entries, ...LOOPBACK_NO_PROXY, ...hubHost])].join(",");
}

let proxy: ReturnType<typeof createHostProxy> | null = null;
let lease: { dispose(): Promise<void> } | null = null;

export default experimental_defineHostEntry({
  contract: accountPoolHostContract,
  handlers: {
    async ensureProxy(input, context) {
      const serverUrl = process.env.BB_SERVER_URL;
      if (serverUrl === undefined || serverUrl === "")
        throw new Error("The host daemon did not provide BB_SERVER_URL.");
      proxy ??= createHostProxy({
        dataDir: context.experimental_paths.dataDir,
      });
      const result = await proxy.ensure({ ...input, serverUrl });
      lease ??= context.experimental_retainWorker();
      return {
        ...result,
        noProxy: mergedNoProxy(
          process.env.NO_PROXY ?? process.env.no_proxy,
          serverUrl,
        ),
      };
    },
  },
  async dispose() {
    const closing = proxy;
    const held = lease;
    proxy = null;
    lease = null;
    await held?.dispose();
    await closing?.close();
  },
});
