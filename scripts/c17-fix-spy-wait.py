from pathlib import Path

p = Path(__file__).resolve().parents[1] / "plugins/account-pool/src/server.test.ts"
text = p.read_text()

broken = """    const fortyMsScheduledListeners = new Set<() => void>();
    timers.mockImplementation((handler, ms?, ...args) => {
      const id = setTimeout(handler, ms as number, ...(args as []));
      if (ms === 40) {
        for (const listener of fortyMsScheduledListeners) listener();
      }
      return id;
    });
    const fortyMsRetryRegisteredAfter = (
      afterIndex: number,
      matchingCountBefore: number,
    ) => {
      const registered = () => {
        const matchingCount = timers.mock.calls.filter(
          ([, ms]) => ms === 40,
        ).length;
        return (
          matchingCount > matchingCountBefore ||
          timers.mock.calls
            .slice(afterIndex)
            .some(([, ms]) => ms === 40)
        );
      };
      if (registered()) return Promise.resolve();
      const wallDeadline = Date.now() + 15_000;
      return new Promise<void>((resolve) => {
        const listener = () => {
          if (registered()) {
            fortyMsScheduledListeners.delete(listener);
            resolve();
          }
        };
        fortyMsScheduledListeners.add(listener);
        const step = () => {
          if (registered()) {
            fortyMsScheduledListeners.delete(listener);
            resolve();
            return;
          }
          if (Date.now() >= wallDeadline) {
            fortyMsScheduledListeners.delete(listener);
            resolve();
            return;
          }
          setImmediate(step);
        };
        step();
      }).then(async () => {
        expect(await Promise.resolve(registered())).toBe(true);
      });
    };
    const whenSetTimeoutDelayAfter = (
      delay: number,
      afterIndex: number,
      matchingCountBefore?: number,
    ) =>
      delay === 40 && matchingCountBefore !== undefined
        ? fortyMsRetryRegisteredAfter(afterIndex, matchingCountBefore)
        : pumpUntil(
            () =>
              timers.mock.calls
                .slice(afterIndex)
                .some(([, ms]) => ms === delay),
            60_000,
            0,
          );
"""

fixed = """    let lastSeenTimerCalls = timers.mock.calls.length;
    const fortyMsRetryRegisteredAfter = (
      afterIndex: number,
      matchingCountBefore: number,
    ) => {
      const registered = () => {
        const matchingCount = timers.mock.calls.filter(
          ([, ms]) => ms === 40,
        ).length;
        return (
          matchingCount > matchingCountBefore ||
          timers.mock.calls
            .slice(afterIndex)
            .some(([, ms]) => ms === 40)
        );
      };
      if (registered()) return Promise.resolve();
      const wallDeadline = Date.now() + 15_000;
      return new Promise<void>((resolve) => {
        const step = () => {
          const callsNow = timers.mock.calls.length;
          if (callsNow !== lastSeenTimerCalls) lastSeenTimerCalls = callsNow;
          if (registered()) {
            resolve();
            return;
          }
          if (Date.now() >= wallDeadline) {
            resolve();
            return;
          }
          setImmediate(step);
        };
        step();
      }).then(async () => {
        expect(await Promise.resolve(registered())).toBe(true);
      });
    };
    const whenSetTimeoutDelayAfter = (
      delay: number,
      afterIndex: number,
      matchingCountBefore?: number,
    ) =>
      delay === 40 && matchingCountBefore !== undefined
        ? fortyMsRetryRegisteredAfter(afterIndex, matchingCountBefore)
        : pumpUntil(
            () =>
              timers.mock.calls
                .slice(afterIndex)
                .some(([, ms]) => ms === delay),
            60_000,
            0,
          );
"""

if broken not in text:
    raise SystemExit("broken block not found")
p.write_text(text.replace(broken, fixed, 1))
print("ok")
