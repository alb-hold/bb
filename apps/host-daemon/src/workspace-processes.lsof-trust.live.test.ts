import { execHostFile } from "@bb/process-utils";
import { expect, it } from "vitest";
import { lsofRunIsTrustworthy } from "./workspace-processes.js";

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

it.skipIf(process.platform !== "darwin")(
  "treats real execHostFile stderr on exit 1 as untrustworthy",
  async () => {
    try {
      await execHostFile("sh", ["-c", "echo warn >&2; exit 1"]);
      expect.unreachable("expected non-zero exit");
    } catch (error) {
      const run = lsofRunFromExecFileError(error);
      expect(run.stderr).toContain("warn");
      expect(run.exitCode).toBe(1);
      expect(lsofRunIsTrustworthy(run)).toBe(false);
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "treats real lsof warning stderr as untrustworthy",
  async () => {
    const uid = String(process.getuid!());
    const missing = `/tmp/bb-lsof-missing-${process.pid}-${Date.now()}`;
    try {
      await execHostFile("lsof", ["-n", "-Fpn", "-u", uid, missing]);
      expect.unreachable("expected lsof to exit non-zero");
    } catch (error) {
      const run = lsofRunFromExecFileError(error);
      expect(run.stderr.trim().length).toBeGreaterThan(0);
      expect(lsofRunIsTrustworthy(run)).toBe(false);
    }
  },
);
