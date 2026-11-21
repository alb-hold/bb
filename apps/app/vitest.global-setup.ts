import {
  findChromium,
  warmUpChromium,
} from "../../plugins/thread-list/vitest.chromium.js";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    appChromiumPath: string | null;
  }
}

export default async function setup(project: TestProject) {
  const chromiumPath = findChromium();
  project.provide("appChromiumPath", chromiumPath);
  if (chromiumPath !== null) await warmUpChromium(chromiumPath);
}
