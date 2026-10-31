import { ChildProcess, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as helper from "./test-processes.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const originalPlatform = process.platform;
const pid = 12345;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.mocked(execFileSync).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function leader(): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: pid });
  return child;
}

function exited(child: ChildProcess): void {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

describe("test process group teardown", () => {
  it("signals a live leader's whole group and awaits the surviving grandchild's termination", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      exited(child);
      return true;
    });
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValue(`${pid} Z\n`);
    let completed = false;
    const pending = cleanup().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
    expect(completed).toBe(false);
    await pending;
    expect(completed).toBe(true);
  });

  it("never signals an already exited leader's group while waiting for remaining members", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    exited(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValue(`${pid} Z\n`);
    await cleanup();
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails visibly without signalling when an already exited leader's group still has writers", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    exited(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue(`${pid} S\n`);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(5_000);
    await expect(cleanup()).rejects.toThrow(
      `Test process group ${pid} still has live writers`,
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("routes an explicit kill through the live-leader check and does not signal it again during cleanup", async () => {
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      exited(child);
      return true;
    });
    vi.mocked(execFileSync).mockReturnValue(`${pid} Z\n`);
    expect(helper.killTestProcessGroup(child, "SIGKILL")).toBe(true);
    expect(helper.killTestProcessGroup(child, "SIGKILL")).toBe(false);
    await cleanup();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, "SIGKILL");
  });

  it("bounds waiting for a leader that never reports exit", async () => {
    vi.useFakeTimers();
    const child = leader();
    const cleanup = helper.trackTestProcess(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const result = expect(cleanup()).rejects.toThrow(
      `Test process group ${pid} still has live writers`,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, "SIGKILL");
  });
});
