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
  "deleted workspace file through tmp alias",
  async () => {
    const workspace =
      process.env.BB_R5_WS ?? (await mkdtemp(join(tmpdir(), "bb-r5-ws-")));
    const holdFile = join(workspace, "hold.dat");
    const created = process.env.BB_R5_WS === undefined;
    if (created) {
      await writeFile(holdFile, "hold\n");
    }
    const holder = spawn(
      "bash",
      ["-c", 'exec 3<>"$1"; sleep 300', "_", holdFile],
      { detached: true, stdio: "ignore" },
    );
    holder.unref();
    try {
      if (created) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await rm(holdFile, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const uid = String(process.getuid!());
      const passes = darwinLsofPasses(uid);
      const cwdRun = await execLsofLikeDaemon(passes.cwd);
      const filesRun = await execLsofLikeDaemon(passes.files);
      const alias = workspace.startsWith("/private/")
        ? workspace.replace(/^\/private\/tmp\//, "/tmp/")
        : workspace;
      const inspection = await inspectWorkspaceProcesses(alias);
      expect(cwdRun.stderr).toBe("");
      expect(filesRun.stderr).toBe("");
      expect(
        inspection.pids.includes(holder.pid!) ||
          inspection.unreadablePids.includes(holder.pid!),
      ).toBe(true);
    } finally {
      try {
        process.kill(holder.pid!, "SIGTERM");
      } catch {
        undefined;
      }
      if (created) await rm(workspace, { recursive: true, force: true });
    }
  },
);

function pathsForUnreadablePids(
  stdout: string,
  unreadablePids: number[],
): Map<number, string[]> {
  const byPid = new Map<number, string[]>();
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isFinite(parsed) ? parsed : undefined;
      continue;
    }
    if (line.startsWith("n") && pid !== undefined && unreadablePids.includes(pid)) {
      const path = line.slice(1);
      const bucket = byPid.get(pid);
      if (bucket === undefined) byPid.set(pid, [path]);
      else bucket.push(path);
    }
  }
  return byPid;
}

it.skipIf(process.platform !== "darwin" || !process.env.BB_R6_LOG)(
  "logs false-refusal evidence for empty workspaces",
  async () => {
    const uid = String(process.getuid!());
    const passes = darwinLsofPasses(uid);
    const tmpEmpty = await mkdtemp(join(tmpdir(), "bb-r6-empty-tmp-"));
    const homeEmpty = await mkdtemp(
      join(process.env.HOME ?? tmpdir(), "bb-r6-empty-home-"),
    );
    const cases = [
      { label: "b_tmp_empty", workspace: tmpEmpty },
      { label: "users_empty", workspace: homeEmpty },
    ];
    try {
      const lines: string[] = [`HEAD=${process.env.BB_R6_HEAD ?? "unknown"}`];
      for (const { label, workspace } of cases) {
        const cwdRun = await execLsofLikeDaemon(passes.cwd);
        const filesRun = await execLsofLikeDaemon(passes.files);
        const inspection = await inspectWorkspaceProcesses(workspace);
        lines.push(`=== ${label} workspace=${workspace} ===`);
        lines.push(
          JSON.stringify({
            supported: inspection.supported,
            pids: inspection.pids,
            unreadablePids: inspection.unreadablePids,
          }),
        );
        if (inspection.unreadablePids.length > 0) {
          const stdout = `${cwdRun.stdout}\n${filesRun.stdout}`;
          const paths = pathsForUnreadablePids(stdout, inspection.unreadablePids);
          for (const pid of inspection.unreadablePids) {
            lines.push(
              `unreadable_pid=${pid} paths=${JSON.stringify(paths.get(pid) ?? [])}`,
            );
          }
        }
      }
      const payload = lines.join("\n") + "\n";
      if (process.env.BB_R6_LOG_FILE) {
        await writeFile(process.env.BB_R6_LOG_FILE, payload);
      }
      console.log(payload);
    } finally {
      await rm(tmpEmpty, { recursive: true, force: true });
      await rm(homeEmpty, { recursive: true, force: true });
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
