import { chromium, webkit } from "playwright";
import { writeFile } from "node:fs/promises";

const [engine = "webkit", target, output = "p38-timing.json"] =
  process.argv.slice(2);
if (!target || !["chromium", "webkit"].includes(engine)) {
  throw new Error(
    "Usage: node scripts/p38-terminal-timing.mjs chromium|webkit SEEDED_THREAD_URL output.json",
  );
}
const browser = await { chromium, webkit }[engine].launch({ headless: true });
const records = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  for (let run = 0; run < 6; run++) {
    const page = await context.newPage();
    const sockets = [];
    const started = Date.now();
    const at = () => Date.now() - started;
    page.on("websocket", (socket) => {
      if (!new URL(socket.url()).pathname.startsWith("/ws/terminals/")) return;
      const record = {
        request: at(),
        attached: null,
        firstByte: null,
        lastByte: null,
        nextSeq: null,
        replayStartSeq: null,
        frames: [],
        sent: [],
      };
      sockets.push(record);
      socket.on("framereceived", ({ payload }) => {
        const time = at();
        try {
          const message = JSON.parse(payload.toString());
          record.frames.push({
            at: time,
            type: message.type,
            seq: message.chunk?.seq,
            bytes: payload.length,
          });
          if (message.type === "attached") {
            record.attached = time;
            record.nextSeq = message.nextSeq;
            record.replayStartSeq = message.replayStartSeq;
          }
          if (message.type === "output") {
            if (record.firstByte === null) record.firstByte = time;
            if (
              record.nextSeq !== null &&
              message.chunk.seq === record.nextSeq - 1
            )
              record.lastByte = time;
          }
        } catch {}
      });
      socket.on("framesent", ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          record.sent.push({
            at: at(),
            type: message.type,
            nextSeq: message.nextSeq,
            cols: message.cols,
            rows: message.rows,
          });
        } catch {}
      });
    });
    await page.goto(target, { waitUntil: "domcontentloaded" });
    let verdict = "PASS";
    try {
      await page.waitForFunction(
        () =>
          performance.getEntriesByName("terminal-replay-parsed").length > 0 ||
          (document.querySelector(
            '[data-app-terminal] [data-replay-held="false"]',
          ) &&
            !document.querySelector("[data-terminal-restoring]")),
        undefined,
        { timeout: 30_000 },
      );
    } catch {
      verdict = "FAIL";
    }
    const state = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      parsed:
        performance.getEntriesByName("terminal-replay-parsed").at(-1)
          ?.startTime ?? null,
      navigation: performance
        .getEntriesByType("navigation")
        .map((entry) => entry.toJSON()),
      resources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.toJSON()),
      previewPresent: !!document.querySelector(
        "[data-terminal-screen-loading-preview]",
      ),
      restoring: !!document.querySelector("[data-terminal-restoring]"),
      terminal: Array.from(
        document.querySelectorAll("[data-render-grid-cols]"),
      ).map((element) => ({ ...element.dataset })),
    }));
    for (const socket of sockets) {
      const shift = started - state.timeOrigin;
      for (const key of ["request", "attached", "firstByte", "lastByte"]) {
        if (socket[key] !== null) socket[key] += shift;
      }
      for (const frame of [...socket.frames, ...socket.sent]) frame.at += shift;
    }
    const socket = sockets[0];
    const ack = socket?.sent.find(
      (frame) => frame.type === "ack" && frame.nextSeq >= socket.nextSeq,
    );
    const parsed = state.parsed === null ? (ack?.at ?? null) : state.parsed;
    records.push({
      run,
      cache: run === 0 ? "cold-context" : "warm-context-new-page",
      verdict,
      sockets,
      state,
      intervals: socket
        ? {
            navigationToRequest: socket.request,
            requestToAttached:
              socket.attached === null
                ? null
                : socket.attached - socket.request,
            attachedToFirstByte:
              socket.firstByte === null
                ? null
                : socket.firstByte - socket.attached,
            firstToLastByte:
              socket.lastByte === null
                ? null
                : socket.lastByte - socket.firstByte,
            lastByteToParsed:
              parsed === null || socket.lastByte === null
                ? null
                : parsed - socket.lastByte,
            parsed,
          }
        : null,
    });
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
  await writeFile(output, JSON.stringify({ engine, target, records }, null, 2));
}
