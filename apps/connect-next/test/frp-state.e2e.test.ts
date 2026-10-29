import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRP_CREDENTIAL_META,
  FRP_LOGIN_REFUSED_REASON,
} from "@bb/tunnel-contract/next";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountApi } from "../src/account-api.js";
import { createLocalDirectory } from "../src/directory.js";
import { createFrpHooks } from "../src/frp-hooks.js";
import { createFrpState } from "../src/frp-state.js";
import { startFrps, type Frps } from "../src/frps.js";
import { silentLog } from "../src/log.js";
import { frpBinaries } from "./frp-binaries.js";
import { freePort, waitFor } from "./harness.js";

const availability = await frpBinaries();
if (!availability.ok) {
  console.warn(`skipping connect-next frp state e2e: ${availability.reason}`);
}

const OWNED_ACCOUNTS: AccountApi = {
  resolve: async () => ({
    label: {
      kind: "server",
      serverId: "srv-bee",
      userId: "user-owner",
      revoked: false,
      lastSeenAt: null,
    },
    session: null,
    desktopSession: null,
    credential: true,
    machine: null,
    oauth: null,
  }),
  forget: () => {},
  presence: async () => [],
};

describe.skipIf(!availability.ok)("frps proxy state end to end", () => {
  const directory = createLocalDirectory({ graceMs: 60_000 });
  const adminUser = "gate";
  const adminPassword = "admin-password-for-tests";
  let frps: Frps;
  let hooksServer: ReturnType<typeof createFrpHooks>["server"];
  let relay: Server;
  const logins: Record<string, unknown>[] = [];
  let adminPort: number;
  let bindPort: number;
  let frpc: ChildProcess | null = null;
  let configDir = "";
  const outputs = new Map<ChildProcess, string>();

  async function startClient(
    who: { label: string; clientId?: string } = { label: "bee" },
  ): Promise<ChildProcess> {
    if (!availability.ok) throw new Error("frp is not available");
    const config = {
      serverAddr: "127.0.0.1",
      serverPort: bindPort,
      user: who.label,
      ...(who.clientId === undefined ? {} : { clientID: who.clientId }),
      loginFailExit: true,
      metadatas: { [FRP_CREDENTIAL_META]: "cred-bee" },
      log: { level: "info", disablePrintColor: true },
      proxies: [
        {
          name: who.label,
          type: "http",
          localIP: "127.0.0.1",
          localPort: 9,
          subdomain: who.label,
        },
      ],
    };
    const file = join(configDir, `${who.label}.json`);
    await writeFile(file, JSON.stringify(config));
    const child = spawn(availability.binaries.frpc, ["-c", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    outputs.set(child, "");
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) =>
        outputs.set(child, `${outputs.get(child) ?? ""}${chunk.toString()}`),
      );
    }
    return child;
  }

  beforeAll(async () => {
    if (!availability.ok) return;
    configDir = await mkdtemp(join(tmpdir(), "bb-frp-state-"));
    const state = createFrpState({
      port: (adminPort = await freePort()),
      user: adminUser,
      password: adminPassword,
    });
    hooksServer = createFrpHooks({
      accounts: OWNED_ACCOUNTS,
      directory,
      log: silentLog,
      frpState: state,
      timings: { registerGraceMs: 200, stateRetryMs: 100, reconcileMs: 200 },
    }).server;
    hooksServer.listen(0, "127.0.0.1");
    await once(hooksServer, "listening");
    const hooksPort = (hooksServer.address() as AddressInfo).port;
    relay = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try {
          const call = JSON.parse(body) as {
            op?: string;
            content?: Record<string, unknown>;
          };
          if (call.op === "Login" && call.content !== undefined) {
            logins.push(call.content);
          }
        } catch {}
        void fetch(`http://127.0.0.1:${hooksPort}${request.url ?? "/"}`, {
          method: "POST",
          body,
        }).then(async (answer) => {
          response.writeHead(answer.status, {
            "content-type": "application/json",
          });
          response.end(await answer.text());
        });
      });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    frps = await startFrps({
      binary: availability.binaries.frps,
      bindPort: (bindPort = await freePort()),
      vhostPort: await freePort(),
      hooksPort: (relay.address() as AddressInfo).port,
      adminPort,
      adminUser,
      adminPassword,
      subdomainHost: "next.test",
      logLevel: "info",
      log: silentLog,
    });
  });

  afterAll(async () => {
    frpc?.kill("SIGKILL");
    await frps?.stop();
    relay?.close();
    hooksServer?.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it("lists the connected client's proxy under the name and run id the hooks see, and drops it when the client dies", async () => {
    const state = createFrpState({
      port: adminPort,
      user: adminUser,
      password: adminPassword,
    });
    expect(await state.proxy("bee.bee")).toEqual({ kind: "offline" });
    expect(await state.online()).toEqual(new Map());

    frpc = await startClient();
    await waitFor(() => directory.locate("bee").kind === "here", 15_000, "bee");

    const online = await state.online();
    expect(online?.size).toBe(1);
    const [[name, clientId]] = [...(online ?? new Map<string, string>())];
    expect(name).toMatch(/bee$/u);
    expect(clientId).not.toBe("");
    expect(await state.proxy(name ?? "")).toEqual({ kind: "online", clientId });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(directory.locate("bee").kind).toBe("here");

    frpc.kill("SIGKILL");
    await waitFor(
      () => directory.locate("bee").kind !== "here",
      15_000,
      "bee to drop",
    );
    expect(await state.proxy(name ?? "")).toEqual({ kind: "offline" });
  });

  it("accepts the Login a stock frpc sends, which carries neither a client id nor a run id", async () => {
    logins.length = 0;
    frpc = await startClient();
    await waitFor(() => directory.locate("bee").kind === "here", 15_000, "bee");
    expect(logins).toHaveLength(1);
    const [login] = logins;
    expect(login).toMatchObject({ user: "bee" });
    expect(login).not.toHaveProperty("client_id");
    expect(login).not.toHaveProperty("run_id");
    console.info(
      `frpc first Login payload keys: ${Object.keys(login ?? {}).sort().join(",")}`,
    );
    frpc.kill("SIGKILL");
    await waitFor(
      () => directory.locate("bee").kind !== "here",
      15_000,
      "bee to drop",
    );
  });

  it("refuses a second client that names the first client's run id as its client id", async () => {
    const state = createFrpState({
      port: adminPort,
      user: adminUser,
      password: adminPassword,
    });
    frpc = await startClient();
    await waitFor(() => directory.locate("bee").kind === "here", 15_000, "bee");
    const online = await state.online();
    const [runId] = [...(online?.values() ?? [])];
    expect(runId).toBeTruthy();

    const intruder = await startClient({ label: "wasp", clientId: runId });
    const exited = await Promise.race([
      once(intruder, "exit").then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 10_000),
      ),
    ]);
    intruder.kill("SIGKILL");
    expect(exited).toBe(true);
    expect(outputs.get(intruder)).toContain(FRP_LOGIN_REFUSED_REASON);
    expect(directory.locate("wasp").kind).not.toBe("here");

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(directory.locate("bee").kind).toBe("here");
    expect([...((await state.online())?.values() ?? [])]).toEqual([runId]);

    frpc.kill("SIGKILL");
    await waitFor(
      () => directory.locate("bee").kind !== "here",
      15_000,
      "bee to drop",
    );
  });

  it("answers unknown, not offline, when the admin API is unreachable", async () => {
    const state = createFrpState({
      port: await freePort(),
      user: adminUser,
      password: adminPassword,
      timeoutMs: 500,
    });
    expect(await state.proxy("bee.bee")).toEqual({ kind: "unknown" });
    expect(await state.online()).toBeNull();
  });
});
