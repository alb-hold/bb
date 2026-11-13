import { preloadPluginModule } from "./plugin-module-preload";
import { whenHomeBackgroundWorkMayStart } from "./home-composer-ready";
import { whenRouteSurfaceMounted } from "./plugin-frontend-boot-schedule";
import { createSettledWorkSchedule } from "./input-idle-work";
import { prepareBackgroundSplit } from "./split-prefetch";
import { expectedSurfaceProviderId } from "./plugin-surface-providers";

export function createDeferredPluginFrontendSchedule() {
  let schedule: ReturnType<typeof createSettledWorkSchedule> | null = null;
  const ensure = () => (schedule ??= createSettledWorkSchedule(() => true));
  const dispose = () => {
    schedule?.cancel();
    schedule = null;
  };
  const yieldBetweenDeferredLoads = async () => {
    await whenRouteSurfaceMounted();
    await ensure().whenIdle();
  };
  const runDeferredWork = async <T>(work: () => Promise<T>) => {
    await whenRouteSurfaceMounted();
    return ensure().run(work);
  };
  const waitForDeferredLoad = async (
    candidatePluginIds?: ReadonlySet<string>,
  ) => {
    ensure();
    await whenRouteSurfaceMounted();
    const threadListProvider = expectedSurfaceProviderId("thread-list");
    if (
      candidatePluginIds === undefined ||
      (threadListProvider !== null &&
        candidatePluginIds.has(threadListProvider))
    ) {
      await whenHomeBackgroundWorkMayStart();
    }
    await yieldBetweenDeferredLoads();
  };
  const downloadDeferredModule = async (url: string): Promise<void> => {
    await runDeferredWork(() => preloadPluginModule(url, "low"));
  };
  const prepareDeferredRuntime = async (id: string) => {
    await prepareBackgroundSplit(id, (work) => runDeferredWork(work));
  };
  return {
    waitForDeferredLoad,
    yieldBetweenDeferredLoads,
    downloadDeferredModule,
    runDeferredWork,
    prepareDeferredRuntime,
    dispose,
  };
}
