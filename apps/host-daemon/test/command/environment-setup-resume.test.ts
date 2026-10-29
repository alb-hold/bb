import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { expect, it } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "../../src/command-dispatch.js";
import { createHarness } from "./dispatch-helpers.js";

const SETUP_OPERATION = "environment:env-resume:key:setup";

async function setupFixture(script: string) {
  const path = await makeTempDir("bb-setup-resume-");
  await writeFile(join(path, ".bb-env-setup.sh"), script);
  return path;
}

function attach(
  path: string,
  resumeOnly: boolean,
  operationId = SETUP_OPERATION,
) {
  return {
    type: "environment.attach" as const,
    contributedEnv: [],
    environmentId: "env-resume",
    initiator: null,
    path,
    setupScriptTimeoutMs: 20_000,
    setupOperation: { id: operationId, resumeOnly },
  };
}

async function runCount(path: string): Promise<number> {
  const runs = await readFile(join(path, "runs"), "utf8").catch(() => "");
  return runs.split("\n").filter((line) => line === "run").length;
}

async function waitForFile(path: string, name: string) {
  await expect
    .poll(() =>
      readFile(join(path, name), "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
}

const slowSetup =
  "echo run >> runs\ntouch started\nwhile [ ! -f proceed ]; do sleep 0.05; done\n";

it("joins the in-flight setup of the same operation and runs the script once", async () => {
  const harness = createHarness({ workspacePath: "/tmp/setup-resume-join" });
  const path = await setupFixture(slowSetup);
  const options = harness.dispatchOptions({ dataDir: path });
  const first = dispatchCommand(attach(path, false), options);
  await waitForFile(path, "started");
  const resumed = dispatchCommand(attach(path, true), options);
  await writeFile(join(path, "proceed"), "");
  const [a, b] = await Promise.all([first, resumed]);
  expect(b.path).toBe(a.path);
  expect(await runCount(path)).toBe(1);
});

it("does not join a setup that belongs to another operation", async () => {
  const harness = createHarness({ workspacePath: "/tmp/setup-resume-other" });
  const path = await setupFixture(slowSetup);
  const options = harness.dispatchOptions({ dataDir: path });
  const first = dispatchCommand(attach(path, false), options);
  await waitForFile(path, "started");
  await expect(
    dispatchCommand(
      attach(path, true, "environment:env-resume:other:setup"),
      options,
    ),
  ).rejects.toThrow("unknown after interruption");
  await writeFile(join(path, "proceed"), "");
  await first;
  expect(await runCount(path)).toBe(1);
});

it("does not treat an unrelated hook in the same workspace as a running setup", async () => {
  const harness = createHarness({ workspacePath: "/tmp/setup-resume-hook" });
  const path = await setupFixture("echo run >> runs\n");
  await writeFile(
    join(path, ".bb-env-teardown.sh"),
    "touch teardown-started\nwhile [ ! -f proceed ]; do sleep 0.05; done\n",
  );
  const options = harness.dispatchOptions({ dataDir: path });
  const hook = dispatchOnlineRpcCommand(
    {
      type: "environment.hook.run",
      contributedEnv: [],
      resumeOnly: false,
      operationId: "unrelated-teardown",
      path,
      kind: "teardown",
      timeoutMs: 20_000,
    },
    options,
    new AbortController().signal,
  );
  await waitForFile(path, "teardown-started");
  await expect(dispatchCommand(attach(path, true), options)).rejects.toThrow(
    "unknown after interruption",
  );
  expect(await runCount(path)).toBe(0);
  await writeFile(join(path, "proceed"), "");
  await hook;
});

it("returns the finished environment when the setup completed before the resume arrived", async () => {
  const harness = createHarness({ workspacePath: "/tmp/setup-resume-done" });
  const path = await setupFixture("echo run >> runs\n");
  const options = harness.dispatchOptions({ dataDir: path });
  const first = await dispatchCommand(attach(path, false), options);
  const resumed = await dispatchCommand(attach(path, true), options);
  expect(resumed.path).toBe(first.path);
  expect(await runCount(path)).toBe(1);
});

it("reports an unknown outcome instead of rerunning a setup that failed before the resume arrived", async () => {
  const harness = createHarness({ workspacePath: "/tmp/setup-resume-failed" });
  const path = await setupFixture("echo run >> runs\nexit 7\n");
  const options = harness.dispatchOptions({ dataDir: path });
  await expect(dispatchCommand(attach(path, false), options)).rejects.toThrow(
    "failed with exit code 7",
  );
  await expect(dispatchCommand(attach(path, true), options)).rejects.toThrow(
    "unknown after interruption",
  );
  expect(await runCount(path)).toBe(1);
});

it("reports an unknown outcome for a resume sent to a daemon that never ran the setup", async () => {
  const harness = createHarness({ workspacePath: "/tmp/setup-resume-restart" });
  const path = await setupFixture("echo run >> runs\n");
  await expect(
    dispatchCommand(
      attach(path, true),
      harness.dispatchOptions({ dataDir: path }),
    ),
  ).rejects.toThrow("unknown after interruption");
  expect(await runCount(path)).toBe(0);
});
