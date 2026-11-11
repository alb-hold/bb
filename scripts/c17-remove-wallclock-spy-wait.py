from pathlib import Path

p = Path(__file__).resolve().parents[1] / "plugins/account-pool/src/server.test.ts"
text = p.read_text()

wall_block = """    const yieldWallClock = (ms: number) =>
      new Promise<void>((resolve) => {
        const doneAt = Date.now() + ms;
        const step = () =>
          Date.now() >= doneAt ? resolve() : setImmediate(step);
        step();
      });
    await vi.advanceTimersByTimeAsync(30);
    await whenDeferredLogsAtLeast(2);
    await yieldWallClock(650);
    await whenSetTimeoutDelayAfter(
"""

if wall_block not in text:
    raise SystemExit("wallclock block not found")

replacement = """    await vi.advanceTimersByTimeAsync(30);
    await whenDeferredLogsAtLeast(2);
    await whenSetTimeoutDelayAfter(
"""

text = text.replace(wall_block, replacement, 1)

old_when_after = """    const whenSetTimeoutDelayAfter = (
      delay: number,
      afterIndex: number,
      matchingCountBefore?: number,
    ) =>
      pumpUntil(
        () => {
          const matchingCount = timers.mock.calls.filter(
            ([, ms]) => ms === delay,
          ).length;
          return (
            (matchingCountBefore !== undefined &&
              matchingCount > matchingCountBefore) ||
            timers.mock.calls
              .slice(afterIndex)
              .some(([, ms]) => ms === delay)
          );
        },
        200_000,
        0,
      );
"""

new_when_after = """    const fortyMsScheduledListeners = new Set<() => void>();
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

if old_when_after not in text:
    raise SystemExit("whenSetTimeoutDelayAfter block not found")
text = text.replace(old_when_after, new_when_after, 1)

p.write_text(text)
print("ok")
