import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
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
  console.warn(
    `skipping connect-next frp reconnect e2e: ${availability.reason}`,
  );
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

interface HookCallRecord {
  op: string;
  runId: string;
}

function parseCall(body: string): HookCallRecord {
  const parsed: unknown = JSON.parse(body);
  const record = typeof parsed === "object" && parsed !== null ? parsed : {};
  const op = "op" in record && typeof record.op === "string" ? record.op : "";
  const content =
    "content" in record && typeof record.content === "object"
      ? record.content
      : null;
  const user =
    content !== null && "user" in content && typeof content.user === "object"
      ? content.user
      : content;
  const runId =
    user !== null &&
    typeof user === "object" &&
    "run_id" in user &&
    typeof user.run_id === "string"
      ? user.run_id
      : "";
  return { op, runId };
}

describe.skipIf(!availability.ok)(
  "a real frpc reconnecting under the same run id",
  () => {
    const directory = createLocalDirectory({ graceMs: 60_000 });
    const calls: HookCallRecord[] = [];
    const heldCloses: Array<() => void> = [];
    let holdCloses = false;
    let hooksServer: ReturnType<typeof createFrpHooks>["server"];
    let forwarder: http.Server;
    let relay: net.Server;
    const relayed = new Set<net.Socket>();
    let frps: Frps;
    let frpc: ChildProcess | null = null;
    let configDir = "";
    let adminPort = 0;

    beforeAll(async () => {
      if (!availability.ok) return;
      configDir = await mkdtemp(join(tmpdir(), "bb-frp-reconnect-"));
      adminPort = await freePort();
      const state = createFrpState({
        port: adminPort,
        user: "gate",
        password: "admin-password-for-tests",
      });
      hooksServer = createFrpHooks({
        accounts: OWNED_ACCOUNTS,
        directory,
        log: silentLog,
        frpState: state,
        timings: { registerGraceMs: 200, stateRetryMs: 100, reconcileMs: 300 },
      }).server;
      hooksServer.listen(0, "127.0.0.1");
      await once(hooksServer, "listening");
      const hooksPort = (hooksServer.address() as AddressInfo).port;
      forwarder = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          const call = parseCall(body);
          const forward = async () => {
            const answer = await fetch(
              `http://127.0.0.1:${hooksPort}${request.url ?? "/frp"}`,
              { method: "POST", body },
            );
            calls.push(call);
            response.writeHead(answer.status, {
              "content-type": "application/json",
            });
            response.end(await answer.text());
          };
          if (call.op === "CloseProxy" && holdCloses) {
            heldCloses.push(() => void forward());
            return;
          }
          void forward();
        });
      });
      forwarder.listen(0, "127.0.0.1");
      await once(forwarder, "listening");
      const bindPort = await freePort();
      frps = await startFrps({
        binary: availability.binaries.frps,
        bindPort,
        vhostPort: await freePort(),
        hooksPort: (forwarder.address() as AddressInfo).port,
        adminPort,
        adminUser: "gate",
        adminPassword: "admin-password-for-tests",
        subdomainHost: "next.test",
        logLevel: "info",
        log: silentLog,
      });
      relay = net.createServer((client) => {
        const upstream = net.connect(bindPort, "127.0.0.1");
        relayed.add(client);
        relayed.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          relayed.delete(client);
          relayed.delete(upstream);
        };
        client.on("error", drop);
        upstream.on("error", drop);
        client.on("close", drop);
        upstream.on("close", drop);
      });
      relay.listen(0, "127.0.0.1");
      await once(relay, "listening");
    });

    afterAll(async () => {
      frpc?.kill("SIGKILL");
      for (const socket of relayed) socket.destroy();
      relay?.close();
      await frps?.stop();
      forwarder?.close();
      hooksServer?.close();
      await rm(configDir, { recursive: true, force: true });
    });

    it("keeps the replacement routed while the replaced control's close hook is still held back", async () => {
      if (!availability.ok) return;
      const state = createFrpState({
        port: adminPort,
        user: "gate",
        password: "admin-password-for-tests",
      });
      const file = join(configDir, "frpc.json");
      await writeFile(
        file,
        JSON.stringify({
          serverAddr: "127.0.0.1",
          serverPort: (relay.address() as AddressInfo).port,
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
        }),
      );
      frpc = spawn(availability.binaries.frpc, ["-c", file], {
        stdio: "ignore",
      });
      await waitFor(
        () => directory.locate("bee").kind === "here",
        15_000,
        "bee",
      );
      const firstRunId = calls.find((call) => call.op === "NewProxy")?.runId;
      expect(firstRunId).toBeTruthy();

      holdCloses = true;
      for (const socket of relayed) socket.destroy();
      await waitFor(() => heldCloses.length > 0, 15_000, "held close");

      await waitFor(
        () => calls.filter((call) => call.op === "NewProxy").length === 2,
        30_000,
        "replacement NewProxy",
      );
      const proxies = calls.filter((call) => call.op === "NewProxy");
      expect(proxies[1]?.runId).toBe(firstRunId);
      expect(heldCloses.length).toBeGreaterThan(0);
      await waitFor(
        () => directory.locate("bee").kind === "here",
        15_000,
        "replacement routed",
      );

      holdCloses = false;
      for (const release of heldCloses.splice(0)) release();
      await waitFor(
        () => calls.some((call) => call.op === "CloseProxy"),
        15_000,
        "late close delivered",
      );
      const order = calls.map((call) => call.op);
      expect(order.lastIndexOf("CloseProxy")).toBeGreaterThan(
        order.lastIndexOf("NewProxy"),
      );

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(directory.locate("bee").kind).toBe("here");
      const online = await state.online();
      expect(online?.size).toBe(1);
      expect([...(online?.values() ?? [])]).toEqual([firstRunId]);

      frpc.kill("SIGKILL");
      await waitFor(
        () => directory.locate("bee").kind !== "here",
        15_000,
        "bee to drop",
      );
    });
  },
);
