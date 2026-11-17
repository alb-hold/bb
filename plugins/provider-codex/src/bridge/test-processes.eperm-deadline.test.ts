import { ChildProcess, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainTestProcessCleanups,
  trackTestProcess,
} from "./test-processes.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
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
    it.each([10, 100, 1_000])(
      "drains %i expired EPERM cleanups with no ps, no wait, and wall time under the cap",
      async (count) => {
        const wallCapMs = 250;
        let clock = 1_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        const kill = vi.spyOn(process, "kill").mockImplementation(() => {
          clock += 1;
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        });
        const cleanups = Array.from({ length: count }, (_, index) =>
          trackTestProcess(leader(8000 + index), 60_000),
        );
        const wallStart = performance.now();
        const failure = await drainTestProcessCleanups(cleanups, -1).then(
          () => undefined,
          (error: unknown) => error,
        );
        const wallMs = performance.now() - wallStart;
        console.log(`EXPIRED DRAIN N=${count} wallMs=${wallMs.toFixed(2)}`);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toHaveLength(count);
        expect(kill).toHaveBeenCalledTimes(count);
        expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
        expect(cleanups).toHaveLength(0);
        expect(wallMs).toBeLessThan(wallCapMs);
      },
    );

    it.each([
      { name: "a fast ps names both writers", psCostMs: 1 },
      { name: "a ps slower than the deadline reports expiry", psCostMs: 1_500 },
    ])("two leaking cleanups with $name", async ({ psCostMs }) => {
      const deadlineMs = 1_000;
      let clock = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      vi.mocked(execFileSync).mockImplementation((() => {
        clock += psCostMs;
        return "7000 S 7001 sh -c writer-a\n7100 S 7101 sh -c writer-b\n";
      }) as unknown as typeof execFileSync);
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      });
      const cleanups = [7000, 7100].map((pid) =>
        trackTestProcess(leader(pid), 60_000),
      );
      const failure = await drainTestProcessCleanups(
        cleanups,
        deadlineMs,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const message = (failure as AggregateError).message;
      if (psCostMs < deadlineMs) {
        expect(message).toContain("pid 7001 (sh -c writer-a)");
        expect(message).toContain("pid 7101 (sh -c writer-b)");
        expect(message).not.toContain("deadline expired before diagnosis");
      } else {
        expect(message).toContain("deadline expired before diagnosis");
      }
    });

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
