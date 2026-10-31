import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuitGuard,
  queryQuitActivity,
  type QuitActivity,
} from "../src/quit-guard.js";
import { registerDesktopShutdownSignalHandlers } from "../src/desktop-shutdown.js";

const source = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
const handlerSource = source.slice(
  source.indexOf("function handleBeforeQuit("),
  source.indexOf(
    "\nasync function finishQuit",
    source.indexOf("function handleBeforeQuit("),
  ),
);

function harness(
  activity: QuitActivity | Error | "timeout",
  confirmed = false,
) {
  const stopOwnedRuntime = vi.fn(async () => {});
  const confirm = vi.fn(async () => confirmed);
  const queryActivity = vi.fn(async () => {
    if (activity === "timeout") return new Promise<QuitActivity>(() => {});
    if (activity instanceof Error) throw activity;
    return activity;
  });
  const app = { quit: () => handleBeforeQuit({ preventDefault: vi.fn() }) };
  const guard = createQuitGuard({
    queryActivity,
    confirm,
    finishQuit: stopOwnedRuntime,
    quitApplication: () => app.quit(),
  });
  const handleBeforeQuit: (event: { preventDefault(): void }) => void =
    new Function(
      "quitGuard",
      "finishQuit",
      "app",
      `let quitting = false; let stoppingForQuit = false; let appImageRelaunchPath = null; ${handlerSource.replace("event: Event", "event").replace("): void", ")")}\nreturn handleBeforeQuit;`,
    )(guard, stopOwnedRuntime, app);
  return { guard, app, confirm, queryActivity, stopOwnedRuntime };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => vi.useRealTimers());

describe("handleBeforeQuit", () => {
  it.each([false, true])("active, confirm=%s", async (confirmed) => {
    vi.useFakeTimers();
    const h = harness({ activeThreads: 16, nativeTerminals: 0 }, confirmed);
    h.guard.requestUserQuit();
    await flush();
    expect(h.confirm).toHaveBeenCalledWith(
      { activeThreads: 16, nativeTerminals: 0 },
      expect.any(AbortSignal),
    );
    expect(h.stopOwnedRuntime).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  });

  it("guards an idle thread with an attached native terminal", async () => {
    vi.useFakeTimers();
    const h = harness({ activeThreads: 0, nativeTerminals: 1 });
    h.guard.requestUserQuit();
    await flush();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.stopOwnedRuntime).not.toHaveBeenCalled();
  });

  it.each([1999, 2001])("second Cmd+Q at %sms", async (elapsed) => {
    vi.useFakeTimers();
    const h = harness("timeout");
    h.confirm.mockImplementation(() => new Promise(() => {}));
    h.guard.requestUserQuit();
    await vi.advanceTimersByTimeAsync(elapsed);
    h.guard.requestUserQuit();
    await flush();
    expect(h.stopOwnedRuntime).toHaveBeenCalledTimes(elapsed <= 2000 ? 1 : 0);
  });

  it("idle quits without prompting", async () => {
    vi.useFakeTimers();
    const h = harness({ activeThreads: 0, nativeTerminals: 0 });
    h.guard.requestUserQuit();
    await flush();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.stopOwnedRuntime).toHaveBeenCalledOnce();
  });

  it.each([new Error("offline"), "timeout"] as const)(
    "unknown count prompts: %s",
    async (activity) => {
      vi.useFakeTimers();
      const h = harness(activity);
      h.guard.requestUserQuit();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.confirm).toHaveBeenCalledWith(null, expect.any(AbortSignal));
      expect(h.stopOwnedRuntime).not.toHaveBeenCalled();
    },
  );

  it("updater app.quit bypasses a pending prompt", async () => {
    vi.useFakeTimers();
    const h = harness("timeout");
    h.guard.requestUserQuit();
    h.app.quit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.stopOwnedRuntime).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s bypasses the prompt",
    async (signal) => {
      vi.useFakeTimers();
      const h = harness(new Error("offline"));
      const listeners = new Map<string, () => void>();
      registerDesktopShutdownSignalHandlers({
        processEvents: {
          on: (name, listener) => {
            listeners.set(name, listener);
          },
        },
        stopOwnedRuntime: async () => {},
        exitProcess: () => {},
        quitApplication: () => h.app.quit(),
      });
      listeners.get(signal)?.();
      await flush();
      expect(h.queryActivity).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.stopOwnedRuntime).toHaveBeenCalledOnce();
    },
  );
});

it("reads hidden/archived threads and live native terminals through existing APIs", async () => {
  const urls: string[] = [];
  const result = await queryQuitActivity({
    serverUrl: "http://localhost:3000",
    signal: new AbortController().signal,
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      const data = url.endsWith("native-terminal")
        ? { terminal: { status: "running" } }
        : url.endsWith("archived=true")
          ? []
          : [
              { id: "thread1", status: "idle", nativeTerminal: true },
              { id: "thread2", status: "active" },
            ];
      return new Response(JSON.stringify(data));
    },
  });
  expect(result).toEqual({ activeThreads: 1, nativeTerminals: 1 });
  expect(urls).toContain(
    "http://localhost:3000/api/v1/threads?includeHidden=true&archived=true",
  );
});
