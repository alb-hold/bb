import { createSettledWorkSchedule } from "./input-idle-work";
import {
  downloadSplitInBackground,
  prepareBackgroundSplit,
} from "./split-prefetch";

export { createSettledWorkSchedule } from "./input-idle-work";

export function scheduleSettledSplitDownloads(
  ids: readonly string[],
  isActive: () => boolean,
): () => void {
  const schedule = createSettledWorkSchedule(isActive);
  void (async () => {
    for (const id of ids) {
      if (!isActive()) return;
      await downloadSplitInBackground(id, schedule.whenIdle, schedule.run);
    }
  })()
    .catch(() => undefined)
    .finally(schedule.cancel);
  return schedule.cancel;
}

const warming = new Set<string>();
export function warmSplitWhenQuiet(
  id: string,
  load: () => Promise<void>,
): void {
  if (warming.has(id)) return;
  warming.add(id);
  const schedule = createSettledWorkSchedule(() => true);
  void prepareBackgroundSplit(id, schedule.run)
    .then(() => schedule.run(load))
    .then(() => undefined)
    .catch(() => {
      warming.delete(id);
    })
    .finally(schedule.cancel);
}
