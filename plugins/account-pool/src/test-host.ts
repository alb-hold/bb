import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

export function createAccountPoolTestHost(
  ...args: Parameters<typeof createFakePluginHost>
) {
  const host = createFakePluginHost(...args);
  host.bb.storage.database().pragma("synchronous = OFF");
  return host;
}
