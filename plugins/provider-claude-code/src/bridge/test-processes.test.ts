import { ChildProcess, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackTestProcess } from "./test-processes.js";

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
});

function exitedLeader(): () => Promise<void> {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: pid });
  const cleanup = trackTestProcess(child);
  child.exitCode = 0;
  child.emit("close", 0, null);
  return cleanup;
}

describe("test process group teardown", () => {
  it("kills a surviving grandchild after the leader exits and awaits its termination", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValueOnce(`${pid} S\n`)
      .mockReturnValue(`${pid} Z\n`);
    const cleanup = exitedLeader();
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

  it("never signals a fully exited group, even when other groups are live", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue(`${pid} Z\n${pid + 1} S\n`);
    await exitedLeader()();
    expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
    expect(kill).not.toHaveBeenCalled();
  });
});
