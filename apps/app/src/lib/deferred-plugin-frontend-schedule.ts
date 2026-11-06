import { whenHomeBackgroundWorkMayStart } from "./home-composer-ready";
import { whenRouteSurfaceMounted } from "./plugin-frontend-boot-schedule";
import { createSettledWorkSchedule } from "./input-idle-work";
import { prepareBackgroundSplit } from "./split-prefetch";

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
  const waitForDeferredLoad = async () => {
    ensure();
    await whenRouteSurfaceMounted();
    await whenHomeBackgroundWorkMayStart();
    await yieldBetweenDeferredLoads();
  };
  const downloadDeferredModule = (url: string) =>
    runDeferredWork(async () => {
      try {
        const response = await fetch(url, {
          cache: "force-cache",
          priority: "low",
        });
        if (response.ok) await response.arrayBuffer();
      } catch {}
    });
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
