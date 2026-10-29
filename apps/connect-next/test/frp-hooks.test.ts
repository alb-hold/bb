import { expect, it, onTestFinished, vi } from "vitest";
import type { AccountApi } from "../src/account-api.js";
import { createLocalDirectory } from "../src/directory.js";
import { createFrpHooks, REMOVAL_SETTLE_MS } from "../src/frp-hooks.js";
import type { FrpState } from "../src/frp-state.js";
import { silentLog } from "../src/log.js";
import { closeServer, listen, visit } from "./harness.js";

it.each(["bee", "bee--3000"])(
  "preserves the return grace for %s while a replacement client connects",
  async (subdomain) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const directory = createLocalDirectory({ graceMs: 2_000 });
    const accounts: AccountApi = {
      async resolve() {
        return {
          label: {
            kind: "server",
            serverId: "srv",
            userId: "owner",
            revoked: false,
            lastSeenAt: null,
          },
          credential: true,
          session: null,
          desktopSession: null,
          machine: null,
          oauth: null,
        };
      },
      forget() {},
      async presence() {
        return [];
      },
    };
    const registered = new Map<string, string>();
    const frpState: FrpState = {
      async proxy(name) {
        const clientId = registered.get(name);
        return clientId === undefined
          ? { kind: "offline" }
          : { kind: "online", clientId };
      },
      async online() {
        return new Map(registered);
      },
    };
    const hooks = createFrpHooks({
      accounts,
      directory,
      log: silentLog,
      frpState,
      claimConnection: () => 1,
      connectionOpen: () => true,
    });
    const port = await listen(hooks.server);
    onTestFinished(() => closeServer(hooks.server));
    async function hook(op: string, runId: string) {
      const response = await visit(port, "localhost", "/frp", {
        method: "POST",
        body: JSON.stringify({
          op,
          content: {
            user: { user: "bee", run_id: runId, metas: { credential: "cred" } },
            proxy_name: subdomain,
            proxy_type: "http",
            subdomain,
          },
        }),
      });
      expect(JSON.parse(response.text)).toEqual({
        reject: false,
        unchange: true,
      });
    }
    registered.set(subdomain, "original");
    await hook("NewProxy", "original");
    await vi.advanceTimersByTimeAsync(150);
    expect(directory.locate(subdomain)).toEqual({ kind: "here" });

    registered.delete(subdomain);
    await hook("CloseProxy", "original");
    await vi.advanceTimersByTimeAsync(REMOVAL_SETTLE_MS - 1);
    registered.set(subdomain, "replacement");
    await hook("NewProxy", "replacement");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(
      await directory.awaitReturn(subdomain, new AbortController().signal),
    ).toEqual({ kind: "here" });

    if (subdomain !== "bee") {
      registered.delete(subdomain);
      await hook("CloseProxy", "replacement");
      const removed = directory.awaitReturn(
        subdomain,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1_000 + REMOVAL_SETTLE_MS);
      expect(await removed).toEqual({ kind: "offline" });
    }
  },
);
