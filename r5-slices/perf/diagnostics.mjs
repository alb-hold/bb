import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
export const out = "r5-slices/perf";
export function bb(...args) {
  return execFileSync("bb", ["isolated-browser", ...args], {
    encoding: "utf8",
    maxBuffer: 20e6,
  });
}
export function evaluate(expression) {
  const v = bb("eval", expression);
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
export async function connect() {
  const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const target = targets.find(
    (t) => t.id === "269F876CEB09E6AEFD0AAAA289FD157B",
  );
  if (!target) throw Error("Owned target absent");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else listeners.get(m.method)?.(m.params);
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, fn) => listeners.set(method, fn),
    close: () => ws.close(),
  };
}
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export function save(name, value) {
  writeFileSync(`${out}/${name}`, JSON.stringify(value, null, 2));
}
