import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { bb, evaluate, connect, delay, save } from "./diagnostics.mjs";
const threads = JSON.parse(
  readFileSync(
    "/private/tmp/claude-501/-Users-alexandrebrandizzi-projects-bb-fork/2fd33d31-1177-417d-b7cc-9f3a23af08f3/scratchpad/council/threads.json",
  ),
).slice(0, 60);
const c = await connect();
const rows = [];
let terminalVisits = 0;
const mutate = (expr) => {
  const safety = JSON.parse(bb("safety-status"));
  if (safety.quarantined || !safety.certified)
    throw Error("Input certificate missing");
  return evaluate(expr);
};
const read = async (expr) =>
  (
    await c.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value;
const initial = await read("performance.timeOrigin");
for (let i = 0; i <= 300; i++) {
  if (i) {
    const terminal = i % 7 === 0;
    const t = terminal
      ? { id: "thr_ti5myaruiv" }
      : i % 10 === 0
        ? { id: "thr_8ixs4xd9wq" }
        : threads[i % threads.length];
    if (terminal) terminalVisits++;
    mutate(
      `history.pushState(null,'','/threads/${t.id}');dispatchEvent(new PopStateEvent('popstate'));true`,
    );
    await delay(350);
    const state = await read(
      `({path:location.pathname,rows:document.querySelectorAll('[data-timeline-row-id]').length,terminal:document.querySelectorAll('.xterm').length,origin:performance.timeOrigin})`,
    );
    if (!state.path.endsWith(t.id) || state.origin !== initial)
      throw Error("SPA navigation failed " + JSON.stringify(state));
    if (i % 10 === 0) {
      mutate(
        `(()=>{const r=document.querySelector('[data-timeline-row-id]');let s=r;while(s&&!(s.scrollHeight>s.clientHeight+10&&/auto|scroll/.test(getComputedStyle(s).overflowY)))s=s.parentElement;if(s){s.scrollTop=0;return true}return false})()`,
      );
    }
    if (i % 25 === 0) {
      mutate(
        `document.querySelector('button[aria-label^="Show right panel"]')?.click();true`,
      );
      await delay(150);
      mutate(
        `document.querySelector('button[aria-label^="Hide right panel"]')?.click();true`,
      );
      mutate(
        `dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',metaKey:true,bubbles:true}));true`,
      );
      await delay(150);
      mutate(
        `dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));true`,
      );
    }
  }
  if (i % 25 === 0) {
    await delay(500);
    await c.send("HeapProfiler.collectGarbage");
    await c.send("HeapProfiler.collectGarbage");
    const heap = await c.send("Runtime.getHeapUsage");
    const dom = await c.send("Memory.getDOMCounters");
    const live = await read(
      `({connected:document.querySelectorAll('*').length,xtermDOM:document.querySelectorAll('.xterm').length,canvas:document.querySelectorAll('canvas').length,path:location.pathname})`,
    );
    let footprint;
    try {
      footprint = execFileSync(
        "/usr/bin/footprint",
        ["-p", process.env.RENDERER_PID],
        { encoding: "utf8" },
      );
    } catch (e) {
      footprint = e.stderr?.toString() || String(e);
    }
    writeFileSync(`r5-slices/perf/footprint-${i}.txt`, footprint);
    rows.push({
      navigation: i,
      terminalVisits,
      heapMiB: heap.usedSize / 1048576,
      ...dom,
      ...live,
    });
    save("soak.json", rows);
    console.log(rows.at(-1));
  }
}
c.close();
