import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectWorkspaceProcesses } from "./workspace-processes.js";

it.skipIf(process.platform !== "darwin")(
  "finds a live process with cwd in the workspace",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bb-ws-inspect-"));
    const child = spawn("sleep", ["300"], {
      cwd: workspace,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const inspection = await inspectWorkspaceProcesses(workspace);
      expect(inspection.supported).toBe(true);
      expect(inspection.pids).toContain(child.pid);
    } finally {
      process.kill(child.pid!, "SIGTERM");
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
