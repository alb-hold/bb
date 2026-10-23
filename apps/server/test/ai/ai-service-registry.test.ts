import { describe, expect, it, vi } from "vitest";
import {
  createAiServiceRegistry,
  type AiServiceRegistration,
} from "../../src/services/ai/ai-service-registry.js";
import { AI_STATUS_FALLBACK_WAIT_MS } from "../../src/services/ai/ai-tasks.js";

const ACME = { pluginId: "acme-plugin", serviceId: "acme" };

function service(
  status: AiServiceRegistration["status"],
  id = "acme",
  pluginId = "acme-plugin",
): AiServiceRegistration {
  return {
    id,
    displayName: "Acme",
    pluginId,
    builtin: false,
    complete: async () => "reply",
    transcribe: null,
    status,
  };
}

describe("AI service registry", () => {
  it("caches status for ten seconds and refreshes after", async () => {
    let clock = 1_000;
    const status = vi.fn(async () => ({ ready: true as const }));
    const registry = createAiServiceRegistry({ now: () => clock });
    registry.register(service(status));

    expect(registry.peekStatus(ACME)).toBeNull();
    await expect(registry.status(ACME)).resolves.toEqual({ ready: true });
    await registry.status(ACME);
    expect(status).toHaveBeenCalledTimes(1);

    clock += 10_001;
    await registry.status(ACME);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("keeps services with the same id from different plugins apart", async () => {
    const registry = createAiServiceRegistry();
    registry.register(service(null));
    registry.register(
      service(
        async () => ({ ready: false, message: "Other plugin" }),
        "acme",
        "other-plugin",
      ),
    );

    expect(registry.list().map((entry) => entry.pluginId)).toEqual([
      "acme-plugin",
      "other-plugin",
    ]);
    expect(registry.get(ACME)?.pluginId).toBe("acme-plugin");
    await expect(registry.status(ACME)).resolves.toEqual({ ready: true });
    await expect(
      registry.status({ pluginId: "other-plugin", serviceId: "acme" }),
    ).resolves.toEqual({ ready: false, message: "Other plugin" });
    expect(() => registry.register(service(null))).toThrow(
      'AI service "acme" is already registered by this plugin.',
    );
  });

  it("reports a throwing or invalid status as not ready", async () => {
    const registry = createAiServiceRegistry();
    registry.register(
      service(async () => {
        throw new Error("Sign in first");
      }),
    );
    registry.register(
      service(
        // @ts-expect-error — plugin code is untyped at runtime.
        async () => ({ ready: "yes" }),
        "broken",
      ),
    );

    await expect(registry.status(ACME)).resolves.toEqual({
      ready: false,
      message: "Sign in first",
    });
    await expect(
      registry.status({ pluginId: "acme-plugin", serviceId: "broken" }),
    ).resolves.toEqual({
      ready: false,
      message: "Reported an invalid status",
    });
  });

  it("notifies when readiness changes and when services come and go", async () => {
    const onStatusChange = vi.fn();
    let ready = false;
    let clock = 0;
    const registry = createAiServiceRegistry({
      onStatusChange,
      now: () => clock,
    });
    const registration = registry.register(
      service(async () =>
        ready ? { ready: true } : { ready: false, message: "Signed out" },
      ),
    );
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await registry.status(ACME);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    clock += 20_000;
    await registry.status(ACME);
    expect(onStatusChange).toHaveBeenCalledTimes(2);

    ready = true;
    clock += 20_000;
    await registry.status(ACME);
    expect(onStatusChange).toHaveBeenCalledTimes(3);

    registration.dispose();
    expect(onStatusChange).toHaveBeenCalledTimes(4);
    expect(registry.get(ACME)).toBeNull();
  });

  describe("slow status checks", () => {
    function slowStatus() {
      const answers: ((status: { ready: true }) => void)[] = [];
      const status = vi.fn(
        () =>
          new Promise<{ ready: true }>((resolve) => {
            answers.push(resolve);
          }),
      );
      return { status, answer: () => answers.shift()?.({ ready: true }) };
    }

    it("says Checking, not Not responding, while a first slow check runs, then keeps its late answer", async () => {
      vi.useFakeTimers();
      try {
        const onStatusChange = vi.fn();
        const registry = createAiServiceRegistry({ onStatusChange });
        const slow = slowStatus();
        registry.register(service(slow.status));
        onStatusChange.mockClear();

        const quick = registry.status(ACME);
        await vi.advanceTimersByTimeAsync(2_001);
        await expect(quick).resolves.toEqual({
          ready: false,
          message: "Checking",
        });

        await vi.advanceTimersByTimeAsync(1_500);
        slow.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(registry.peekStatus(ACME)).toEqual({ ready: true });
        expect(onStatusChange).toHaveBeenCalledTimes(1);
        expect(slow.status).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("answers with the last known status while a later check is slow", async () => {
      vi.useFakeTimers();
      try {
        let clock = 1_000;
        const registry = createAiServiceRegistry({ now: () => clock });
        const slow = slowStatus();
        registry.register(service(slow.status));
        const first = registry.status(ACME);
        slow.answer();
        await expect(first).resolves.toEqual({ ready: true });

        clock += 10_001;
        const later = registry.status(ACME);
        await vi.advanceTimersByTimeAsync(2_001);
        await expect(later).resolves.toEqual({ ready: true });
        expect(slow.status).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits for a slow check to finish before deciding whether a task can run", async () => {
      vi.useFakeTimers();
      try {
        const registry = createAiServiceRegistry();
        const slow = slowStatus();
        registry.register(service(slow.status));
        const settled = registry.settledStatus(ACME, 60_000);
        let result: unknown = null;
        void settled.then((status) => {
          result = status;
        });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(result).toBeNull();
        slow.answer();
        await expect(settled).resolves.toEqual({ ready: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("never answers a task with an expired ready status while the fresh check runs", async () => {
      vi.useFakeTimers();
      try {
        let clock = 1_000;
        const registry = createAiServiceRegistry({ now: () => clock });
        const slow = slowStatus();
        registry.register(service(slow.status));
        const first = registry.settledStatus(ACME, 9_000);
        slow.answer();
        await expect(first).resolves.toEqual({ ready: true });

        clock += 10_001;
        let result: unknown = null;
        const later = registry.settledStatus(ACME, 9_000);
        void later.then((status) => {
          result = status;
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(result).toBeNull();
        expect(slow.status).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(8_001);
        await expect(later).resolves.toEqual({
          ready: false,
          message: "Not responding",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("answers a task with the fresh check when an expired ready status turns not ready", async () => {
      vi.useFakeTimers();
      try {
        let clock = 1_000;
        let ready = true;
        const answers: (() => void)[] = [];
        const registry = createAiServiceRegistry({ now: () => clock });
        registry.register(
          service(
            () =>
              new Promise((resolve) => {
                answers.push(() =>
                  resolve(
                    ready
                      ? { ready: true }
                      : { ready: false, message: "Signed out" },
                  ),
                );
              }),
          ),
        );
        const first = registry.settledStatus(ACME, 9_000);
        answers.shift()?.();
        await expect(first).resolves.toEqual({ ready: true });

        ready = false;
        clock += 10_001;
        const later = registry.settledStatus(ACME, 9_000);
        await vi.advanceTimersByTimeAsync(1_000);
        answers.shift()?.();
        await expect(later).resolves.toEqual({
          ready: false,
          message: "Signed out",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits for a fresh check when the expired status was not ready", async () => {
      vi.useFakeTimers();
      try {
        let clock = 1_000;
        let ready = false;
        const answers: (() => void)[] = [];
        const registry = createAiServiceRegistry({ now: () => clock });
        registry.register(
          service(
            () =>
              new Promise((resolve) => {
                answers.push(() =>
                  resolve(
                    ready
                      ? { ready: true }
                      : { ready: false, message: "Signed out" },
                  ),
                );
              }),
          ),
        );
        const first = registry.settledStatus(ACME, 9_000);
        answers.shift()?.();
        await expect(first).resolves.toEqual({
          ready: false,
          message: "Signed out",
        });

        ready = true;
        clock += 10_001;
        let result: unknown = null;
        const later = registry.settledStatus(ACME, 9_000);
        void later.then((status) => {
          result = status;
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(result).toBeNull();
        answers.shift()?.();
        await expect(later).resolves.toEqual({ ready: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rechecks a service whose check hangs once the check is older than the status cache, for repeated quick task waits, and ignores the hung check's late result", async () => {
      vi.useFakeTimers();
      try {
        const answers: ((status: { ready: true }) => void)[] = [];
        let calls = 0;
        const registry = createAiServiceRegistry();
        registry.register(
          service(() => {
            calls += 1;
            if (calls === 1) return new Promise(() => {});
            return new Promise((resolve) => answers.push(resolve));
          }),
        );
        const wait = AI_STATUS_FALLBACK_WAIT_MS;
        const quickWaitAnswer = async () => {
          const status = registry.settledStatus(ACME, wait);
          await vi.advanceTimersByTimeAsync(wait + 1);
          return status;
        };

        await expect(quickWaitAnswer()).resolves.toEqual({
          ready: false,
          message: "Not responding",
        });
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(quickWaitAnswer()).resolves.toEqual({
          ready: false,
          message: "Not responding",
        });
        expect(calls).toBe(1);

        await vi.advanceTimersByTimeAsync(4_000);
        const recovered = registry.settledStatus(ACME, wait);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toBe(2);
        answers.shift()?.({ ready: true });
        await expect(recovered).resolves.toEqual({ ready: true });

        await vi.advanceTimersByTimeAsync(30_000);
        expect(registry.peekStatus(ACME)).toEqual({ ready: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports Not responding only when a check never answers", async () => {
      vi.useFakeTimers();
      try {
        const registry = createAiServiceRegistry();
        registry.register(service(() => new Promise(() => {})));
        const settled = registry.settledStatus(ACME, 60_000);
        await vi.advanceTimersByTimeAsync(30_001);
        await expect(settled).resolves.toEqual({
          ready: false,
          message: "Not responding",
        });
        expect(registry.peekStatus(ACME)).toEqual({
          ready: false,
          message: "Not responding",
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
