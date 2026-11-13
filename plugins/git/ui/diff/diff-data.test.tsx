// @vitest-environment jsdom

import { act, cleanup, screen } from "@testing-library/react";
import { useEffect, useSyncExternalStore } from "react";
import { afterEach, expect, it } from "vitest";
import {
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { gitRpcContract } from "../../rpc-contract.js";
import type { GitFilesResult, WorkspaceDiffTarget } from "../../contract.js";
import { useDiffFiles } from "./diff-data.js";
import { makeDiffFileEntry } from "./diff-file-fixtures.js";

afterEach(() => {
  cleanup();
  reportInitialShown = undefined;
  reportAllShown = undefined;
});

let target: WorkspaceDiffTarget = { type: "uncommitted" };
const listeners = new Set<() => void>();
let reportInitialShown: (() => void) | undefined;
let reportAllShown: (() => void) | undefined;

function selectTarget(next: WorkspaceDiffTarget) {
  target = next;
  for (const listener of listeners) listener();
}

function Files() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => target,
  );
  const files = useDiffFiles({
    environmentId: "env_1",
    target: current,
    ignoreWhitespace: false,
    enabled: true,
  });
  useEffect(() => {
    if (files.shown?.target.type === "uncommitted") reportInitialShown?.();
    if (files.shown?.target.type === "all") reportAllShown?.();
  }, [files.shown]);
  const result = files.shown?.result;
  return (
    <output aria-label="files" data-loading={files.isLoading}>
      {files.shown?.target.type}:
      {result?.outcome === "available"
        ? result.files.map((file) => file.path).join(",")
        : ""}
    </output>
  );
}

function filesFor(path: string): GitFilesResult {
  return {
    outcome: "available",
    files: [makeDiffFileEntry({ path, revision: "r1" })],
    truncated: false,
    shortstat: "",
    mergeBaseRef: null,
    initialPatches: [],
  };
}

it("keeps the previous file list and its target while another target loads", async () => {
  const pending: ((value: GitFilesResult) => void)[] = [];
  let resolveInitial!: (value: GitFilesResult) => void;
  let resolveInitialRequested!: () => void;
  let resolveNextRequested!: () => void;
  let resolveInitialShown!: () => void;
  let resolveAllShown!: () => void;
  const initialRequested = new Promise<void>((resolve) => {
    resolveInitialRequested = resolve;
  });
  const nextRequested = new Promise<void>((resolve) => {
    resolveNextRequested = resolve;
  });
  const initialShown = new Promise<void>((resolve) => {
    resolveInitialShown = resolve;
  });
  const allShown = new Promise<void>((resolve) => {
    resolveAllShown = resolve;
  });
  reportInitialShown = resolveInitialShown;
  reportAllShown = resolveAllShown;
  const initialResponse = new Promise<GitFilesResult>((resolve) => {
    resolveInitial = resolve;
  });
  const rpc: Partial<PluginRpcTestHandlers<typeof gitRpcContract>> = {
    files: ({ target: requested }) =>
      requested.type === "uncommitted"
        ? (resolveInitialRequested(), initialResponse)
        : new Promise<GitFilesResult>((resolve) => {
            resolveNextRequested();
            pending.push(resolve);
          }),
  };
  renderSlot(
    { component: Files },
    {},
    {
      rpc: rpc as PluginRpcTestHandlers<typeof gitRpcContract>,
      experimental_rpcContract: gitRpcContract,
      pluginId: "bb--git",
    },
  );
  const output = () => screen.getByRole("status", { name: "files" });
  await initialRequested;
  await act(async () => {
    resolveInitial(await Promise.resolve(filesFor("uncommitted.ts")));
  });
  await initialShown;
  expect(output().textContent).toBe("uncommitted:uncommitted.ts");

  act(() => selectTarget({ type: "all", mergeBaseBranch: "main" }));
  expect(output().textContent).toBe("uncommitted:uncommitted.ts");
  expect(output().getAttribute("data-loading")).toBe("false");

  await nextRequested;
  await act(async () => {
    for (const resolve of pending)
      resolve(await Promise.resolve(filesFor("all.ts")));
  });
  await allShown;
  expect(output().textContent).toBe("all:all.ts");
});
