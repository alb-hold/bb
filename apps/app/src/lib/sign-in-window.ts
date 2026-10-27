import type {
  ExperimentalSignInWindow,
  ExperimentalSignInWindowOptions,
} from "@get-bb/plugin-sdk";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { randomUuid } from "@/lib/random-uuid";

export function openSignInWindow(
  options: ExperimentalSignInWindowOptions,
): ExperimentalSignInWindow | null {
  const desktop = getBbDesktopInfo();
  const open = desktop?.openSignInWindow;
  const close = desktop?.closeSignInWindow;
  if (desktop === null || open === undefined || close === undefined) {
    return null;
  }
  const id = randomUuid();
  const result = open
    .call(desktop, {
      id,
      url: options.url,
      ...(options.redirectUrlPrefix === undefined
        ? {}
        : { redirectUrlPrefix: options.redirectUrlPrefix }),
    })
    .catch(() => ({ reason: "closed" as const }));
  return {
    close: () => close.call(desktop, id),
    result,
  };
}
