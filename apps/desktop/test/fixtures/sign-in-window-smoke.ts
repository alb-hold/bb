import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { app, session } from "electron";
import { createElectronSignInWindow } from "../../src/desktop-sign-in-electron.js";
import { DesktopSignInWindowController } from "../../src/desktop-sign-in-window.js";

const resultPath = process.argv.at(-1);
if (resultPath === undefined) throw new Error("result path argument required");
const keepAlive = setInterval(() => {}, 1000);
app.on("window-all-closed", () => {});

async function main(): Promise<Record<string, unknown>> {
  const cookiesSeen: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/authorize") {
      cookiesSeen.push(request.headers.cookie ?? "");
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "bb_probe=signed-in; Path=/",
      });
      response.end(
        '<html><body><a id="go" href="/continue">go</a><script>setTimeout(() => { location.href = "/callback?code=fake-code&state=fake-state"; }, 150);</script></body></html>',
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("callback page");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const partitions: string[] = [];
  const controller = new DesktopSignInWindowController<null>({
    createWindow: (partition) => {
      partitions.push(partition);
      return createElectronSignInWindow(partition, null, { show: false });
    },
  });
  await app.whenReady();

  const first = await controller.open({
    owner: 1,
    parent: null,
    request: {
      id: "first",
      url: `${origin}/authorize`,
      redirectUrlPrefix: `${origin}/callback`,
    },
  });
  const firstCookies = await session
    .fromPartition(partitions[0] ?? "")
    .cookies.get({});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const firstCookiesAfterClose = await session
    .fromPartition(partitions[0] ?? "")
    .cookies.get({});
  const second = await controller.open({
    owner: 1,
    parent: null,
    request: {
      id: "second",
      url: `${origin}/authorize`,
      redirectUrlPrefix: `${origin}/callback`,
    },
  });
  const defaultCookies = await session.defaultSession.cookies.get({});

  assert.deepEqual(first, {
    reason: "redirect",
    redirectUrl: `${origin}/callback?code=fake-code&state=fake-state`,
  });
  assert.deepEqual(second, first);
  assert.notEqual(partitions[0], partitions[1]);
  assert.equal(partitions[0]?.startsWith("persist:"), false);
  assert.deepEqual(cookiesSeen, ["", ""]);
  assert.equal(firstCookiesAfterClose.length, 0);
  assert.equal(
    defaultCookies.some((cookie) => cookie.name === "bb_probe"),
    false,
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    firstResultReason: first.reason,
    secondResultReason: second.reason,
    cookiesSentToAuthorizeOnEachWindow: cookiesSeen,
    firstWindowCookieNamesWhileOpen: firstCookies.map(({ name }) => name),
    firstWindowCookieCountAfterClose: firstCookiesAfterClose.length,
    defaultSessionHasProbeCookie: defaultCookies.some(
      (cookie) => cookie.name === "bb_probe",
    ),
    partitions,
  };
}

main().then(
  (summary) => {
    writeFileSync(resultPath, JSON.stringify(summary, null, 2));
    console.log("BB_SIGN_IN_SMOKE_COMPLETE");
    clearInterval(keepAlive);
    app.quit();
  },
  (error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    console.log("BB_SIGN_IN_SMOKE_FAILED");
    clearInterval(keepAlive);
    app.exit(1);
  },
);
