import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { accountPoolHostContract } from "./host-contract.js";
import { createHostProxy } from "./host-proxy.js";

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
      return result;
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
