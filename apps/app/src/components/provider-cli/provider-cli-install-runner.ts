import type { ProviderCliInstallEvent } from "@bb/host-daemon-contract";
import type { ProviderCliInstallJob } from "./provider-cli-install-store";
import { sdk } from "@/lib/sdk";
export { classifyProviderCliInstallFailure } from "./provider-cli-install-failure";

export async function runServerInstall(
  job: ProviderCliInstallJob,
  trackedServerJobIds: Set<string>,
): Promise<ProviderCliInstallEvent[]> {
  const { hostId, issue } = job;
  const jobId =
    job.serverJobId ??
    (
      await sdk.hosts.experimental_startProviderCliInstall({
        hostId,
        provider: issue.provider,
        actionKind: issue.action.kind,
      })
    ).id;
  trackedServerJobIds.add(jobId);
  const settled = await sdk.hosts.experimental_providerCliInstallJobs.wait({
    hostId,
    jobId,
  });
  if (settled.state === "running") {
    throw new Error("Provider CLI install did not finish");
  }
  if (settled.state === "failed") throw new Error(settled.error);
  return settled.events;
}
