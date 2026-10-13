import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runSandboxedScript,
  sandboxDisposeFailureCount,
  type SandboxRunArgs,
} from "./sandbox.js";

const PRELUDE = `
globalThis.host = async (name, ...args) =>
  JSON.parse(await __bbHost(name, JSON.stringify(args)));
globalThis.print = (line) => __bbLog(String(line));
`;

const MIB = 1024 * 1024;
const GENEROUS_CPU_LIMITS = {
  synchronousDeadlineMs: 5_000,
  cpuBudgetMs: 5_000,
};

function run(code: string, overrides: Partial<SandboxRunArgs> = {}) {
  return runSandboxedScript({
    code,
    prelude: PRELUDE,
    hostFunctions: {},
    ...overrides,
  });
}

describe("runSandboxedScript", () => {
  let failuresBefore = 0;
  let expectedFailures = 0;

  beforeEach(() => {
    failuresBefore = sandboxDisposeFailureCount();
    expectedFailures = 0;
  });

  afterEach(() => {
    expect(sandboxDisposeFailureCount() - failuresBefore).toBe(
      expectedFailures,
    );
  });

  it("returns the script's JSON value and its logs", async () => {
    const result = await run(
      `print("hello"); return { sum: [1, 2, 3].reduce((a, b) => a + b, 0) };`,
    );
    expect(result).toEqual({ ok: true, value: { sum: 6 }, logs: "hello\n" });
  });

  it("returns null when the script returns nothing", async () => {
    expect(await run(`const unused = 1;`)).toEqual({
      ok: true,
      value: null,
      logs: "",
    });
  });

  it("awaits host functions and passes JSON both ways", async () => {
    const result = await run(
      `const a = await host("double", 4); const b = await host("double", a.value); return b;`,
      {
        hostFunctions: {
          double: async ([value]) => ({ value: Number(value) * 2 }),
        },
      },
    );
    expect(result).toEqual({ ok: true, value: { value: 16 }, logs: "" });
  });

  it("surfaces a host function failure as a catchable error", async () => {
    const result = await run(
      `try { await host("fail"); } catch (error) { return "caught: " + error.message; }`,
      {
        hostFunctions: {
          fail: async () => {
            throw new Error("not allowed");
          },
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      value: "caught: not allowed",
      logs: "",
    });
  });

  it("reports a thrown error with its message", async () => {
    const result = await run(`throw new TypeError("bad input");`);
    expect(result).toMatchObject({ ok: false, error: "TypeError: bad input" });
  });

  it("reports a syntax error instead of throwing", async () => {
    const result = await run(`return (;`);
    expect(result.ok).toBe(false);
  });

  it("interrupts a synchronous infinite loop", async () => {
    const result = await run(`while (true) {}`, {
      limits: { synchronousDeadlineMs: 50 },
    });
    expect(result.ok).toBe(false);
  });

  it("stops a script that swallows the interrupt and keeps spinning", async () => {
    const startedAt = Date.now();
    const result = await run(
      `for (;;) { try { await (async () => { for (;;) {} })(); } catch {} }`,
      { limits: { synchronousDeadlineMs: 100, cpuBudgetMs: 400 } },
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain(
      "computed for too long",
    );
  });

  it("stops a script that multiplies spinning promise chains", async () => {
    const startedAt = Date.now();
    const result = await run(
      `const spin = () => (async () => { for (;;) {} })().catch(() => { spin(); spin(); }); spin(); await new Promise(() => {});`,
      { limits: { synchronousDeadlineMs: 100, cpuBudgetMs: 400 } },
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
  });

  it("stops an endless chain of cheap microtasks", async () => {
    const startedAt = Date.now();
    const result = await run(`for (;;) { await null; }`, {
      limits: { synchronousDeadlineMs: 100, cpuBudgetMs: 400 },
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
  });

  it("charges computation across bb calls to one total budget", async () => {
    let calls = 0;
    const result = await run(
      `for (;;) { const until = Date.now() + 60; while (Date.now() < until) {} await host("tick"); }`,
      {
        limits: { synchronousDeadlineMs: 200, cpuBudgetMs: 300 },
        hostFunctions: {
          tick: async () => {
            calls += 1;
            return null;
          },
        },
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain(
      "computed for too long",
    );
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(12);
  });

  it("does not charge time spent waiting on a bb call", async () => {
    const result = await run(`await host("slow"); return "done";`, {
      limits: { synchronousDeadlineMs: 50, cpuBudgetMs: 100 },
      hostFunctions: {
        slow: () =>
          new Promise((resolve) => setTimeout(() => resolve(null), 300)),
      },
    });
    expect(result).toMatchObject({ ok: true, value: "done" });
  });

  it("reports unbounded recursion as an error and keeps working", async () => {
    for (let round = 0; round < 12; round += 1) {
      const overflow = await run(`const f = () => f(); f();`);
      expect(overflow).toMatchObject({ ok: false });
      expect(overflow.ok === false && overflow.error).toContain("stack");
    }
    expect(await run(`return 7;`)).toMatchObject({ ok: true, value: 7 });
  });

  it("recovers when tearing a script down fails", async () => {
    let failed = 0;
    for (let round = 0; round < 3; round += 1) {
      const before = sandboxDisposeFailureCount();
      await run(`const f = () => f(); f();`, {
        limits: { maxStackBytes: 1024 * 1024 },
      });
      failed += sandboxDisposeFailureCount() - before;
      expect(await run(`return 7;`)).toMatchObject({ ok: true, value: 7 });
    }
    expectedFailures = failed;
    expect(failed).toBeGreaterThan(0);
  });

  it("stops a script that awaits forever at the total deadline", async () => {
    const result = await run(`await new Promise(() => {});`, {
      limits: { totalDeadlineMs: 80 },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("was stopped");
  });

  it("stops a script whose host call never settles and aborts that call", async () => {
    let aborted = false;
    const result = await run(`await host("hang");`, {
      limits: { totalDeadlineMs: 80 },
      hostFunctions: {
        hang: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      },
    });
    expect(result.ok).toBe(false);
    expect(aborted).toBe(true);
  });

  it("stops when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const pending = run(`await new Promise(() => {});`, {
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: "The call was cancelled.",
    });
  });

  it("limits the number of host calls", async () => {
    const result = await run(
      `for (let i = 0; i < 5; i += 1) await host("noop"); return "done";`,
      {
        limits: { maxHostCalls: 3 },
        hostFunctions: { noop: async () => null },
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("at most 3");
  });

  it("refuses host functions that were not provided, including inherited names", async () => {
    const result = await run(
      `const out = []; for (const name of ["missing", "constructor", "toString", "__proto__"]) { try { await host(name); out.push("ran"); } catch (error) { out.push("refused"); } } return out;`,
    );
    expect(result).toMatchObject({
      ok: true,
      value: ["refused", "refused", "refused", "refused"],
    });
  });

  it("has no access to Node or network globals", async () => {
    const result = await run(
      `return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer, typeof XMLHttpRequest, typeof WebSocket, typeof module];`,
    );
    expect(result).toMatchObject({
      ok: true,
      value: new Array(8).fill("undefined"),
    });
  });

  it("blocks eval", async () => {
    const result = await run(
      `try { return eval("1 + 1"); } catch (error) { return error.message; }`,
    );
    expect(result).toMatchObject({
      ok: true,
      value: "eval is unavailable here",
    });
  });

  it("blocks dynamic code generation through function constructors", async () => {
    const result = await run(
      `const attempts = [() => Function("return 1")(), () => (async () => {}).constructor("return 1")(), () => (function* () {}).constructor("yield 1")()]; return attempts.map((attempt) => { try { attempt(); return "ran"; } catch { return "blocked"; } });`,
    );
    expect(result).toMatchObject({
      ok: true,
      value: ["blocked", "blocked", "blocked"],
    });
  });

  it("fails cleanly when the script exhausts its memory limit", async () => {
    const result = await run(
      `const chunks = []; while (true) chunks.push(new Array(100000).fill("x"));`,
      { limits: { memoryLimitBytes: 4 * MIB, ...GENEROUS_CPU_LIMITS } },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("too much memory");
    expect(result.ok === false && result.error).not.toContain(
      "computed for too long",
    );
  });

  describe("memory limit", () => {
    const originalMemory = WebAssembly.Memory;
    let memories: WebAssembly.Memory[] = [];

    beforeEach(() => {
      memories = [];
      WebAssembly.Memory = class extends originalMemory {
        constructor(descriptor: WebAssembly.MemoryDescriptor) {
          super(descriptor);
          memories.push(this);
        }
      };
    });

    afterEach(() => {
      WebAssembly.Memory = originalMemory;
    });

    const HEAP_BASE_BYTES = 16 * MIB;
    const LIMIT_BYTES = 16 * MIB;
    const SCRIPTS: Record<string, string> = {
      arrays: `const chunks = []; while (true) chunks.push(new Array(100000).fill("x"));`,
      "many strings": `const chunks = []; while (true) chunks.push("x".repeat(1000000) + chunks.length);`,
      "one huge string": `return "x".repeat(900 * 1024 * 1024).length;`,
      "typed arrays": `const chunks = []; while (true) chunks.push(new Uint8Array(1000000));`,
      "one huge typed array": `return new Uint8Array(1500 * 1024 * 1024).length;`,
      objects: `const chunks = []; while (true) chunks.push({ a: 1, b: [1, 2], c: "y" });`,
    };

    it.each(Object.entries(SCRIPTS))(
      "stops %s on the memory limit, not the CPU budget",
      async (_name, code) => {
        const startedAt = Date.now();
        const result = await run(code, {
          limits: { memoryLimitBytes: LIMIT_BYTES, ...GENEROUS_CPU_LIMITS },
        });
        const elapsedMs = Date.now() - startedAt;
        expect(result).toMatchObject({ ok: false });
        expect(result.ok === false && result.error).toContain(
          "too much memory",
        );
        expect(result.ok === false && result.error).not.toContain(
          "computed for too long",
        );
        expect(elapsedMs).toBeLessThan(2_000);
        expect(memories).toHaveLength(1);
        expect(memories[0]?.buffer.byteLength).toBeLessThanOrEqual(
          HEAP_BASE_BYTES + LIMIT_BYTES,
        );
      },
    );

    it("reports exhaustion as a memory stop when the engine cannot even build its out-of-memory error", async () => {
      const limits = { memoryLimitBytes: 4 * MIB, ...GENEROUS_CPU_LIMITS };
      const engineThrew = await run(
        `const chunks = []; try { while (true) chunks.push({ a: 1, b: [1, 2], c: "y" }); } catch (error) { chunks.length = 0; return error === null ? "null" : "an error"; }`,
        { limits },
      );
      expect(engineThrew).toMatchObject({ ok: true, value: "null" });
      const result = await run(SCRIPTS.objects ?? "", { limits });
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.error).toContain("too much memory");
    });

    it("reports a script's own throw of null as that value after it allocated past half the limit", async () => {
      const allocated = await run(
        `const chunks = []; for (let i = 0; i < 24; i += 1) chunks.push(new Uint8Array(1024 * 1024)); throw null;`,
        { limits: { memoryLimitBytes: LIMIT_BYTES, ...GENEROUS_CPU_LIMITS } },
      );
      const heapBytes = memories[0]?.buffer.byteLength ?? 0;
      expect(heapBytes - HEAP_BASE_BYTES).toBeGreaterThanOrEqual(
        LIMIT_BYTES / 2,
      );
      expect(heapBytes).toBeLessThan(HEAP_BASE_BYTES + LIMIT_BYTES);
      const plain = await run(`throw null;`, {
        limits: { memoryLimitBytes: LIMIT_BYTES, ...GENEROUS_CPU_LIMITS },
      });
      expect(plain).toMatchObject({ ok: false, error: "null" });
      expect(allocated).toEqual(plain);
    });

    it("reports a script's own throw of null without any allocation as that value", async () => {
      const result = await run(`throw null;`);
      expect(result).toMatchObject({ ok: false, error: "null" });
    });

    it("lets the heap grow to the limit before stopping a script", async () => {
      await run(SCRIPTS.arrays ?? "", {
        limits: { memoryLimitBytes: LIMIT_BYTES },
      });
      expect(memories[0]?.buffer.byteLength).toBeGreaterThan(
        HEAP_BASE_BYTES + LIMIT_BYTES / 2,
      );
    });

    it("gives each run its own heap", async () => {
      await run(SCRIPTS.arrays ?? "", {
        limits: { memoryLimitBytes: LIMIT_BYTES },
      });
      const second = await run(`return [1, 2, 3].length;`, {
        limits: { memoryLimitBytes: LIMIT_BYTES },
      });
      expect(second).toMatchObject({ ok: true, value: 3 });
      expect(memories).toHaveLength(2);
      expect(memories[1]?.buffer.byteLength).toBe(HEAP_BASE_BYTES);
    });

    it("still reports a compute-bound script as a CPU stop", async () => {
      const result = await run(`while (true) {}`, {
        limits: { memoryLimitBytes: LIMIT_BYTES, synchronousDeadlineMs: 50 },
      });
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.error).toContain(
        "computed for too long",
      );
      expect(result.ok === false && result.error).not.toContain(
        "too much memory",
      );
    });
  });

  it("caps log output", async () => {
    const result = await run(
      `for (let i = 0; i < 100; i += 1) print("x".repeat(50)); return 1;`,
      { limits: { maxLogChars: 200 } },
    );
    expect(result.ok).toBe(true);
    expect(result.logs.length).toBeLessThan(260);
    expect(result.logs).toContain("[log output truncated]");
  });

  it("runs many scripts in a row without leaking state between them", async () => {
    await run(`globalThis.leak = 42;`);
    const result = await run(`return typeof globalThis.leak;`);
    expect(result).toMatchObject({ ok: true, value: "undefined" });
  });
});
