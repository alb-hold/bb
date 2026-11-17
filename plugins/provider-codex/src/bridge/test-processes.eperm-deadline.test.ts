import { ChildProcess, execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainTestProcessCleanups,
  trackTestProcess,
} from "./test-processes.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function leader(pid: number): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: pid });
  return child;
}

describe.runIf(process.platform !== "win32")(
  "EPERM diagnostics under a shared deadline",
  () => {
    it("runs no ps once the shared deadline has passed and bounds the drain by the deadline plus one ps call", async () => {
      const deadlineMs = 1_000;
      const psCostMs = 400;
      let clock = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const psTimeouts: number[] = [];
      vi.mocked(execFileSync).mockImplementation(((
        _command: string,
        _args: string[],
        options: { timeout: number },
      ) => {
        psTimeouts.push(options.timeout);
        clock += psCostMs;
        return "7000 S 7001 sh -c leaked-writer-loop\n";
      }) as unknown as typeof execFileSync);
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      });
      const pids = [7000, 7000, 7000, 7000, 7000, 7000];
      const cleanups = pids.map((pid) =>
        trackTestProcess(leader(pid), 60_000),
      );
      const started = clock;
      const failure = await drainTestProcessCleanups(
        cleanups,
        deadlineMs,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const message = (failure as AggregateError).message;
      expect(message).toContain("pid 7001 (sh -c leaked-writer-loop)");
      expect(message).toContain("deadline expired before diagnosis");
      expect(cleanups).toHaveLength(0);
      expect(clock - started).toBeLessThanOrEqual(deadlineMs + psCostMs);
      expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(
        Math.ceil(deadlineMs / psCostMs),
      );
      for (const timeout of psTimeouts)
        expect(timeout).toBeLessThanOrEqual(deadlineMs);
    });
  },
);
