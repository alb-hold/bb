import type { ThreadDetailView } from "./ThreadDetailView";

let pending: Promise<typeof ThreadDetailView> | null = null;

export function loadThreadDetailView() {
  pending ??= import("./ThreadDetailView")
    .then((module) => module.ThreadDetailView)
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
