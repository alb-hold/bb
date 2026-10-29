import { execHostFile } from "@bb/process-utils";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectWorkspaceProcesses } from "./workspace-processes.js";

function lsofRunFromExecFileError(error: unknown): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  if (!(error instanceof Error)) {
    return { stdout: "", stderr: "", exitCode: -1 };
  }
  const code =
    "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  const stdout =
    "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const exitCode =
    typeof code === "number"
      ? code
      : typeof code === "string" && /^\d+$/.test(code)
        ? Number(code)
        : -1;
  return { stdout, stderr, exitCode };
}

async function execLsofLikeDaemon(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execHostFile("lsof", args, {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    return lsofRunFromExecFileError(error);
  }
}

function darwinLsofPasses(uid: string) {
  return {
    cwd: ["-a", "-u", uid, "-d", "cwd", "-n", "-Fpn"] as const,
    files: ["-u", uid, "-n", "-Fpn"] as const,
  };
}

async function waitForLsof(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

it.skipIf(process.platform !== "darwin")(
  "finds live cwd and open-file holders via real execHostFile lsof",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bb-ws-inspect-"));
    const holdFile = join(workspace, "hold.dat");
    await writeFile(holdFile, "hold\n");
    const cwdChild = spawn("sleep", ["300"], {
      cwd: workspace,
      detached: true,
      stdio: "ignore",
    });
    cwdChild.unref();
    const fileChild = spawn(
      "bash",
      ["-c", 'exec 3<>"$1"; sleep 300', "_", holdFile],
      { detached: true, stdio: "ignore" },
    );
    fileChild.unref();
    try {
      await waitForLsof();
      const uid = String(process.getuid!());
      const passes = darwinLsofPasses(uid);
      const cwdRun = await execLsofLikeDaemon(passes.cwd);
      const filesRun = await execLsofLikeDaemon(passes.files);
      expect(cwdRun.stderr).toBe("");
      expect(filesRun.stderr).toBe("");
      const inspection = await inspectWorkspaceProcesses(workspace);
      expect(inspection.supported).toBe(true);
      expect(inspection.unreadablePids).toEqual([]);
      expect(inspection.pids).toContain(cwdChild.pid);
      expect(inspection.pids).toContain(fileChild.pid);
      expect(inspection.pids.length).toBeLessThanOrEqual(5);
    } finally {
      for (const pid of [cwdChild.pid, fileChild.pid]) {
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            undefined;
          }
        }
      }
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "finds no pids in an empty workspace directory",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bb-ws-inspect-empty-"));
    try {
      const uid = String(process.getuid!());
      const scopedEmpty = await execLsofLikeDaemon([
        "-a",
        "-u",
        uid,
        "+D",
        workspace,
        "-n",
        "-Fpn",
      ]);
      expect(scopedEmpty.exitCode).toBe(1);
      expect(scopedEmpty.stdout).toBe("");
      expect(scopedEmpty.stderr).toBe("");
      expect(await inspectWorkspaceProcesses(workspace)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
