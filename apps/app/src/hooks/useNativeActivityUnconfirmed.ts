import { isNativeActivityUnconfirmed } from "@bb/client-core";
import type { ThreadRuntimeState } from "@bb/domain";
import { useSecondTick } from "./useSecondTick";

export function useNativeActivityUnconfirmed(
  runtime: ThreadRuntimeState | undefined,
): boolean {
  const now = useSecondTick();
  return runtime === undefined || runtime.nativeActivity === undefined
    ? false
    : isNativeActivityUnconfirmed(runtime, now);
}
