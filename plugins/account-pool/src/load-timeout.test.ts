import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountPoolConfigSchema } from "./contracts";
import { createAccountPoolPlugin } from "./server";
import { createAccountPoolTestHost } from "./test-host";

const LOAD_BOUND_MS = 2_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(hosts: () => Promise<Array<{ id: string }>>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-load-"));
  const host = createAccountPoolTestHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: hosts },
      plugins: { list: async () => ({ plugins: [] }) },
    } as never,
  });
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  return host;
}

describe("Account Pool load", () => {
  it("finishes loading and serves RPCs while the host list never resolves", async () => {
    const host = await fixture(() => new Promise(() => undefined));
    const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
    const outcome = await Promise.race([
      createAccountPoolPlugin()(host.bb).then(() => "loaded" as const),
      new Promise<"timed out">((resolve) => {
        timer.id = setTimeout(() => resolve("timed out"), LOAD_BOUND_MS);
      }),
    ]);
    clearTimeout(timer.id);

    expect(outcome).toBe("loaded");
    expect(
      await host.harness.behavior.callRpc("config.get", null),
    ).toEqual(accountPoolConfigSchema.parse({}));
  });

  it("holds thread credential calls until the host list arrives", async () => {
    const hosts = deferred<Array<{ id: string }>>();
    const host = await fixture(() => hosts.promise);
    await createAccountPoolPlugin()(host.bb);

    const service = host.harness.behavior.runService("hub");
    const settled = { value: false };
    void service.done.then(
      () => {
        settled.value = true;
      },
      () => {
        settled.value = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled.value).toBe(false);

    hosts.resolve([{ id: "host-one" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.controller.abort();
    await service.done;
  });
});
