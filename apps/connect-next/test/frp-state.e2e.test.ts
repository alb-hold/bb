import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRP_CREDENTIAL_META } from "@bb/tunnel-contract/next";
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
  let adminPort: number;
  let bindPort: number;
  let frpc: ChildProcess | null = null;
  let configDir = "";

  async function startClient(): Promise<ChildProcess> {
    if (!availability.ok) throw new Error("frp is not available");
    const config = {
      serverAddr: "127.0.0.1",
      serverPort: bindPort,
      user: "bee",
      loginFailExit: true,
      metadatas: { [FRP_CREDENTIAL_META]: "cred-bee" },
      log: { level: "info", disablePrintColor: true },
      proxies: [
        {
          name: "bee",
          type: "http",
          localIP: "127.0.0.1",
          localPort: 9,
          subdomain: "bee",
        },
      ],
    };
    const file = join(configDir, "frpc.json");
    await writeFile(file, JSON.stringify(config));
    return spawn(availability.binaries.frpc, ["-c", file], {
      stdio: "ignore",
    });
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
    frps = await startFrps({
      binary: availability.binaries.frps,
      bindPort: (bindPort = await freePort()),
      vhostPort: await freePort(),
      hooksPort: (hooksServer.address() as AddressInfo).port,
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
