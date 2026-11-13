import { sdk } from "@/lib/sdk";
export { classifyProviderCliInstallFailure } from "./provider-cli-install-failure";

export async function waitForInstall(args: { hostId: string; jobId: string }) {
  const settled = await sdk.hosts.experimental_providerCliInstallJobs.wait(args);
  if (settled.state === "running") {
    throw new Error("Provider CLI install did not finish");
  }
  if (settled.state === "failed") throw new Error(settled.error);
  return settled.events;
}
