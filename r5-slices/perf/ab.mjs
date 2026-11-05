import { bb, connect, delay, save } from "./diagnostics.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("r5-slices/perf/raw/perf-r5-ab", { recursive: true });
const c = await connect();
const results = [];
const mutate = (...args) => {
  const s = JSON.parse(bb("safety-status"));
  if (s.quarantined || !s.certified) throw Error("Unsafe adapter");
  return bb(...args);
};
for (const mode of ["adapter-ready", "settled"])
  for (let pair = 0; pair < 6; pair++)
    for (const port of pair % 2 ? [16820, 16800] : [16800, 16820]) {
      mutate("goto", `http://127.0.0.1:${port}/`);
      mutate(
        "eval",
        `localStorage.removeItem('bb.promptbox.contents-draft-3');true`,
      );
      mutate("goto", `http://127.0.0.1:${port}/`);
      for (let i = 0; i < 100; i++) {
        const r = await c.send("Runtime.evaluate", {
          expression: '!!document.querySelector("[contenteditable=true]")',
          returnByValue: true,
        });
        if (r.result.value) break;
        await delay(50);
      }
      const empty = await c.send("Runtime.evaluate", {
        expression:
          'document.querySelector("[contenteditable=true]").textContent',
        returnByValue: true,
      });
      if (empty.result.value.trim()) throw Error("Nonempty initial draft");
      mutate(
        "eval",
        'document.querySelector("[contenteditable=true]").focus();performance.mark("adapter-composer-ready");true',
      );
      await delay(mode === "settled" ? 3000 : 40);
      let events = [];
      c.on("Tracing.dataCollected", (d) => events.push(...d.value));
      await c.send("Profiler.enable");
      await c.send("Profiler.setSamplingInterval", { interval: 100 });
      await c.send("Profiler.start");
      await c.send("Tracing.start", {
        categories:
          "toplevel,devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing",
        transferMode: "ReportEvents",
      });
      mutate("press", "[contenteditable=true]", "a");
      await delay(100);
      const done = new Promise((r) => c.on("Tracing.tracingComplete", r));
      await c.send("Tracing.end");
      await done;
      const { profile } = await c.send("Profiler.stop");
      const name = `${mode}-${pair}-${port}`;
      writeFileSync(
        `r5-slices/perf/raw/perf-r5-ab/${name}.profile.json`,
        JSON.stringify(profile),
      );
      writeFileSync(
        `r5-slices/perf/raw/perf-r5-ab/${name}.trace.json`,
        JSON.stringify(events),
      );
      const first = events.find(
        (e) => e.name === "EventDispatch" && e.args?.data?.type === "keydown",
      );
      if (!first) throw Error("Missing keydown");
      const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
      let ts = profile.startTime;
      const sums = new Map();
      for (let j = 0; j < profile.samples.length; j++) {
        const dt = Math.max(0, profile.timeDeltas[j]);
        ts += profile.timeDeltas[j];
        if (ts >= first.ts && ts < first.ts + 50000) {
          const f = nodes.get(profile.samples[j]).callFrame;
          const key = `${f.functionName || "(anonymous)"} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
          sums.set(key, (sums.get(key) || 0) + dt / 1000);
        }
      }
      const tasks = events.filter(
        (e) =>
          e.name === "RunTask" &&
          e.ph === "X" &&
          e.pid === first.pid &&
          e.tid === first.tid &&
          e.ts >= first.ts - 2000 &&
          e.ts < first.ts + 48000,
      );
      const buckets = [...sums];
      const row = {
        mode,
        pair,
        port,
        taskWallMs: tasks.reduce((s, e) => s + e.dur, 0) / 1000,
        taskThreadCpuMs: tasks.reduce((s, e) => s + (e.tdur || 0), 0) / 1000,
        jsSelfMs: buckets
          .filter(
            ([k]) => !/^\((idle|program|garbage collector|root)\)/.test(k),
          )
          .reduce((s, [, v]) => s + v, 0),
        engineBuckets: buckets.filter(([k]) =>
          /^\((idle|program|garbage collector|root)\)/.test(k),
        ),
        top10: buckets
          .filter(
            ([k]) => !/^\((idle|program|garbage collector|root)\)/.test(k),
          )
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
        raw: `r5-slices/perf/raw/perf-r5-ab/${name}`,
      };
      results.push(row);
      save("ab.json", results);
      console.log(JSON.stringify(row));
    }
c.close();
