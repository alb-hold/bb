export const terminalScreenMirrorWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { Terminal } = require(workerData.headlessPath);
const { Unicode11Addon } = require(workerData.unicodeAddonPath);
const sessions = new Map();
let queue = [];
let running = false;
const createTerminal = (cols, rows) => {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: workerData.scrollback });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
};
const respond = (message) => parentPort.postMessage(message);
const enqueue = (message) => { queue.push(message); void pump(); };
const pump = async () => {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const message = queue.shift();
      if (!message) continue;
      const key = message.sessionId;
      let session = sessions.get(key);
      if (message.type === "start" || message.type === "reset") {
        session?.terminal.dispose();
        session = {
          cols: message.cols,
          rows: message.rows,
          terminal: createTerminal(message.cols, message.rows),
          generation: message.generation,
          lastSeq: message.seq ?? null,
        };
        sessions.set(key, session);
        if (message.type === "reset" && message.data) {
          await new Promise((resolve) => session.terminal.write(new Uint8Array(message.data), resolve));
          session.lastSeq = message.seq;
          respond({ type: "written", sessionId: key, generation: session.generation, seq: message.seq, bytes: message.data.byteLength });
        }
      } else if (message.type === "write") {
        if (session && session.generation === message.generation) {
          await new Promise((resolve) => session.terminal.write(new Uint8Array(message.data), resolve));
          session.lastSeq = message.seq;
        }
        respond({ type: "written", sessionId: key, generation: message.generation, seq: message.seq, bytes: message.data.byteLength });
      } else if (message.type === "resize") {
        if (session && session.generation === message.generation) {
          session.cols = message.cols;
          session.rows = message.rows;
          session.terminal.resize(message.cols, message.rows);
        }
      } else if (message.type === "dispose") {
        if (session && session.generation === message.generation) {
          session.terminal.dispose();
          sessions.delete(key);
        }
      } else if (message.type === "snapshot") {
        if (!session || session.generation !== message.generation) {
          respond({ type: "snapshot", requestId: message.requestId, sessionId: key, generation: message.generation, screen: null });
        } else {
          const buffer = session.terminal.buffer.active;
          const bufferRows = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "");
          respond({ type: "snapshot", requestId: message.requestId, sessionId: key, generation: message.generation, screen: { bufferRows, baseY: buffer.baseY, cursor: { col: buffer.cursorX, row: buffer.cursorY }, cols: session.cols, gridRows: session.rows } });
        }
      }
      if (message.type === "write" || message.type === "reset") {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    running = false;
    if (queue.length > 0) void pump();
  }
};
parentPort.on("message", enqueue);
`;
