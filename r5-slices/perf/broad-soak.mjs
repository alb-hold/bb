import {
  readFileSync,
  appendFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { bb, evaluate, connect, delay, save } from "./diagnostics.mjs";
const threads = JSON.parse(readFileSync("r5-slices/perf/seeded-chat-ids.json"));
if (new Set(threads.map((t) => t.id)).size < 60)
  throw Error("Insufficient distinct chats");
const c = await connect();
const rows = [],
  visits = [];
const distinct = new Set();
let terminalVisits = 0;
let panels = 0,
  palettes = 0,
  scrolls = 0;
let terminalPrototype;
await c.send("HeapProfiler.enable");
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
bb("safety-status");
bb("goto", "http://127.0.0.1:16820/threads/thr_ti5myaruiv");
await delay(1000);
const initial = await read("performance.timeOrigin");
console.log({ stage: "snapshot-start" });
async function snapshot(i) {
  const path = `r5-slices/perf/raw/broad-${i}.heapsnapshot`;
  const fd = openSync(path, "w");
  c.on("HeapProfiler.addHeapSnapshotChunk", (d) => writeSync(fd, d.chunk));
  await c.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  closeSync(fd);
  c.on("HeapProfiler.addHeapSnapshotChunk", () => {});
  const summary = JSON.parse(
    execFileSync("python3", ["r5-slices/perf/heap-summary.py", path], {
      encoding: "utf8",
    }),
  );
  save(`broad-heap-${i}.json`, summary);
  return summary;
}
async function count(prototype, context = false) {
  const { objects } = await c.send("Runtime.queryObjects", {
    prototypeObjectId: prototype,
    objectGroup: "soak-count",
  });
  const result = await c.send("Runtime.callFunctionOn", {
    objectId: objects.objectId,
    functionDeclaration: context
      ? "function(){return this.filter(c=>!c.isContextLost()).length}"
      : "function(){return this.length}",
    returnByValue: true,
  });
  await c.send("Runtime.releaseObjectGroup", { objectGroup: "soak-count" });
  return result.result.value;
}
const native = await snapshot(0);
for (const id of [...native.terminalIds].reverse()) {
  try {
    const { result } = await c.send("HeapProfiler.getObjectByHeapObjectId", {
      objectId: String(id),
      objectGroup: "wrapper",
    });
    const prototype = await c.send("Runtime.callFunctionOn", {
      objectId: result.objectId,
      functionDeclaration: "function(){return Object.getPrototypeOf(this)}",
      objectGroup: "terminal-prototype",
    });
    terminalPrototype = prototype.result.objectId;
    await c.send("Runtime.releaseObjectGroup", { objectGroup: "wrapper" });
    break;
  } catch {
    await c.send("Runtime.releaseObjectGroup", { objectGroup: "wrapper" });
  }
}

console.log({ stage: "prototype-ready", available: !!terminalPrototype });
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
    await delay(250);
    let state;
    for (let attempt = 0; attempt < 20; attempt++) {
      state = await read(
        `({path:location.pathname,rows:document.querySelectorAll('[data-timeline-row-id]').length,terminal:document.querySelectorAll('.xterm').length,origin:performance.timeOrigin})`,
      );
      if (terminal ? state.terminal > 0 : state.rows > 0) break;
      await delay(250);
    }
    if (!state.path.endsWith(t.id) || state.origin !== initial)
      throw Error("SPA navigation failed " + JSON.stringify(state));
    if (terminal ? state.terminal === 0 : state.rows === 0)
      throw Error("Thread content did not mount " + JSON.stringify(state));
    distinct.add(t.id);
    visits.push({ navigation: i, id: t.id, ...state });
    save("broad-visits.json", visits);
    if (!terminal && i % 10 === 0) {
      const scrolled = mutate(
        `(()=>{const r=document.querySelector('[data-timeline-row-id]');let s=r;while(s&&!(s.scrollHeight>s.clientHeight+10&&/auto|scroll/.test(getComputedStyle(s).overflowY)))s=s.parentElement;if(s){s.scrollTop=s.scrollHeight;return true}return false})()`,
      );
      if (!scrolled) throw Error("Long thread scroll container missing");
      await delay(100);
      mutate(
        `(()=>{const r=document.querySelector('[data-timeline-row-id]');let s=r;while(s&&!(s.scrollHeight>s.clientHeight+10&&/auto|scroll/.test(getComputedStyle(s).overflowY)))s=s.parentElement;s.scrollTop=0;return true})()`,
      );
      scrolls++;
    }
    if (i % 25 === 0) {
      mutate(
        `document.querySelector('button[aria-label^="Show right panel"]')?.click();true`,
      );
      await delay(300);
      const shown = await read(
        `!!document.querySelector('button[aria-label^="Hide right panel"]')`,
      );
      if (!shown) throw Error("Panel did not open");
      panels++;
      mutate(
        `document.querySelector('button[aria-label^="Hide right panel"]')?.click();true`,
      );
      mutate(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'P',code:'KeyP',metaKey:true,shiftKey:true,bubbles:true}));true`,
      );
      await delay(300);
      if (
        !(await read(
          `!!document.querySelector('[data-testid="command-palette"]')`,
        ))
      )
        throw Error("Palette did not open");
      palettes++;
      mutate(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));true`,
      );
      await delay(200);
      if (
        await read(
          `!!document.querySelector('[data-testid="command-palette"]')`,
        )
      )
        throw Error("Palette did not close");
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
    let contexts = 0;
    for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
      const { result } = await c.send("Runtime.evaluate", {
        expression: name + ".prototype",
      });
      contexts += await count(result.objectId, true);
      await c.send("Runtime.releaseObject", { objectId: result.objectId });
    }
    const liveXterm = terminalPrototype ? await count(terminalPrototype) : null;
    rows.push({
      navigation: i,
      distinctThreads: distinct.size,
      terminalVisits,
      panels,
      palettes,
      scrolls,
      liveXterm,
      liveWebGL: contexts,
      heapMiB: heap.usedSize / 1048576,
      ...dom,
      ...live,
    });
    save("broad-soak.json", rows);
    console.log(rows.at(-1));
    appendFileSync(
      "r5-slices/perf/footprint-requests.txt",
      `broad-${i} 67005\n`,
    );
    await delay(6000);
    if (i === 150 || i === 300) await snapshot(i);
  }
}
if (
  distinct.size < 50 ||
  terminalVisits < 40 ||
  panels !== 12 ||
  palettes !== 12
)
  throw Error("Coverage incomplete");
await c.send("Runtime.releaseObjectGroup", {
  objectGroup: "terminal-prototype",
});
c.close();
