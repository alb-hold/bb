import { execHostFile } from "@bb/process-utils";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectWorkspaceProcesses,
  readInspectWorkspaceProcessFindDiagnostics,
  resolveRelativeUnixBindSuffix,
} from "./workspace-processes.js";

vi.mock("@bb/process-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/process-utils")>();
  return {
    execHostFile: vi.fn(actual.execHostFile),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
  };
});

describe("resolveRelativeUnixBindSuffix", () => {
  it("preserves trailing whitespace in suffix probes", () => {
    expect(resolveRelativeUnixBindSuffix("c.sock ")).toEqual({
      kind: "suffix",
      suffix: "/c.sock ",
    });
    expect(resolveRelativeUnixBindSuffix(" c.sock")).toEqual({
      kind: "suffix",
      suffix: "/ c.sock",
    });
  });

  it("treats embedded newlines in relative names as unreadable", () => {
    expect(resolveRelativeUnixBindSuffix("c\n.sock")).toEqual({
      kind: "unreadable",
    });
  });

  it("treats dot-dot segments as unreadable", () => {
    expect(resolveRelativeUnixBindSuffix("sub/../c.sock")).toEqual({
      kind: "unreadable",
    });
    expect(resolveRelativeUnixBindSuffix("..")).toEqual({ kind: "unreadable" });
  });

  it("drops dot segments and builds a slash suffix", () => {
    expect(resolveRelativeUnixBindSuffix("./a/./c.sock")).toEqual({
      kind: "suffix",
      suffix: "/a/c.sock",
    });
  });
});

describe("relative unix bind suffix search", () => {
  let platform: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(realpath).mockImplementation(async (value) => String(value));
  });

  afterEach(() => {
    platform.mockRestore();
  });

  async function mockLsofPassThroughFind(cwdOut: string, filesOut: string) {
    const actual = await vi.importActual<typeof import("@bb/process-utils")>(
      "@bb/process-utils",
    );
    vi.mocked(execHostFile).mockImplementation((async (
      cmd: string,
      args: readonly string[],
      opts?: { maxBuffer?: number; timeout?: number },
    ) => {
      if (cmd === "find") {
        return actual.execHostFile(cmd, args, {
          maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
          timeout: opts?.timeout ?? workspaceSocketFindTimeoutMs(),
        });
      }
      const stdout = args.includes("cwd") ? cwdOut : filesOut;
      return { stdout, stderr: "" };
    }) as never);
  }

  function workspaceSocketFindTimeoutMs(): number {
    const raw = process.env.BB_WS_SOCKET_FIND_TIMEOUT_MS;
    if (raw != null && raw !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 2000;
  }

  async function listenUnix(path: string): Promise<() => Promise<void>> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  }

  it("runs find at most once per workspace root for multiple relative unix names", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r11b-find-once-"));
    let findCalls = 0;
    vi.mocked(execHostFile).mockImplementation((async (
      cmd: string,
      args: readonly string[],
    ) => {
      if (cmd === "find") {
        findCalls += 1;
        return { stdout: "", stderr: "" };
      }
      const stdout = args.includes("cwd")
        ? "p540\nfcwd\ntDIR\nn/\n\np541\nfcwd\ntDIR\nn/\n"
        : "p540\nf1\ntunix\nnc.sock\n\np541\nf1\ntunix\nndocker-desktop-build.sock\n";
      return { stdout, stderr: "" };
    }) as never);
    try {
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [],
      });
      expect(findCalls).toBe(1);
      expect(readInspectWorkspaceProcessFindDiagnostics().socketFindCalls).toBe(1);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats workspace c.sock with trailing space as unreadable when cwd is outside", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r14-ws-trail-"));
    const sockPath = join(ws, "c.sock ");
    const stop = await listenUnix(sockPath);
    try {
      await mockLsofPassThroughFind(
        "p536\nfcwd\ntDIR\nn/\n",
        ["p536\nf1\ntunix\n", "nc.sock \n"].join(""),
      );
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [536],
      });
    } finally {
      await stop();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("suffix collision marks both binders unreadable when workspace holds matching socket", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r15-collision-"));
    const sockPath = join(ws, "c.sock ");
    const stop = await listenUnix(sockPath);
    try {
      await mockLsofPassThroughFind(
        [
          "p55057\nfcwd\ntDIR\nn/",
          "",
          "p55064\nfcwd\ntDIR\nn/",
          "",
        ].join("\n"),
        [
          "p55057\nf5\ntunix\nnc.sock ",
          "",
          "p55064\nf5\ntunix\nnc.sock ",
          "",
        ].join("\n"),
      );
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [55057, 55064],
      });
    } finally {
      await stop();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats foreign.sock with trailing space as outside when cwd is outside", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r14-foreign-"));
    let findCalls = 0;
    vi.mocked(execHostFile).mockImplementation((async (
      cmd: string,
      args: readonly string[],
    ) => {
      if (cmd === "find") {
        findCalls += 1;
        return { stdout: "", stderr: "" };
      }
      const stdout = args.includes("cwd")
        ? "p537\nfcwd\ntDIR\nn/\n"
        : ["p537\nf1\ntunix\n", "nforeign.sock \n"].join("");
      return { stdout, stderr: "" };
    }) as never);
    try {
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [],
      });
      expect(findCalls).toBe(1);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats sub/../c.sock bind as unreadable when cwd is outside the workspace", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r12-dotdot-"));
    let findCalls = 0;
    vi.mocked(execHostFile).mockImplementation((async (
      cmd: string,
      args: readonly string[],
    ) => {
      if (cmd === "find") {
        findCalls += 1;
        return { stdout: `${join(ws, "c.sock")}\n`, stderr: "" };
      }
      const stdout = args.includes("cwd")
        ? "p533\nfcwd\ntDIR\nn/\n"
        : "p533\nf1\ntunix\nnsub/../c.sock\n";
      return { stdout, stderr: "" };
    }) as never);
    try {
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [533],
      });
      expect(findCalls).toBe(0);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("matches ./a/./c.sock suffix against a normalized workspace socket path", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r12-dots-"));
    await mkdir(join(ws, "a"), { recursive: true });
    const sockPath = join(ws, "a", "c.sock");
    const stop = await listenUnix(sockPath);
    try {
      await mockLsofPassThroughFind(
        "p534\nfcwd\ntDIR\nn/\n",
        "p534\nf1\ntunix\nn./a/./c.sock\n",
      );
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [534],
      });
    } finally {
      await stop();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats docker-style relative unix name as outside when no workspace socket exists", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r10b-out-"));
    try {
      await mockLsofPassThroughFind(
        "p530\nfcwd\ntDIR\nn/\n",
        "p530\nf1\ntunix\nndocker-desktop-build.sock\n",
      );
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [],
      });
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it.each([null, "python3"])("keeps bare c.sock unreadable with command %s", async (command) => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r10b-unr-"));
    const sockPath = join(ws, "c.sock");
    const stop = await listenUnix(sockPath);
    try {
      await mockLsofPassThroughFind(
        "p521\nfcwd\ntDIR\nn/\n",
        `p521\n${command === null ? "" : `c${command}\n`}f1\ntunix\nnc.sock\n`,
      );
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [521],
        ...(command === null ? {} : { processCommands: { "521": command } }),
      });
    } finally {
      await stop();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats sub/c.sock as unreadable when workspace holds that socket suffix", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r10b-unr-sub-"));
    await mkdir(join(ws, "sub"), { recursive: true });
    const sockPath = join(ws, "sub", "c.sock");
    const stop = await listenUnix(sockPath);
    try {
      await mockLsofPassThroughFind(
        "p522\nfcwd\ntDIR\nn/\n",
        "p522\nf1\ntunix\nnsub/c.sock\n",
      );
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [522],
      });
    } finally {
      await stop();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("never treats deep workspace socket suffix as outside when bind cwd is /", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r11-deep-"));
    const segments = Array.from({ length: 13 }, (_, index) => `d${index}`);
    const deepDir = join(ws, ...segments);
    await mkdir(deepDir, { recursive: true });
    const deepSocket = join(deepDir, "c.sock");
    vi.mocked(execHostFile).mockImplementation((async (
      cmd: string,
      args: readonly string[],
    ) => {
      if (cmd === "find") {
        const truncated = args.includes("-maxdepth");
        const stdout = truncated ? "" : `${deepSocket}\n`;
        return { stdout, stderr: "" };
      }
      const stdout = args.includes("cwd")
        ? "p532\nfcwd\ntDIR\nn/\n"
        : "p532\nf1\ntunix\nnc.sock\n";
      return { stdout, stderr: "" };
    }) as never);
    try {
      const result = await inspectWorkspaceProcesses(ws);
      expect(result).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [532],
      });
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("treats relative unix as unreadable when workspace socket search times out", async () => {
    const ws = await mkdtemp(join(tmpdir(), "bb-r10b-timeout-"));
    const prior = process.env.BB_WS_SOCKET_FIND_TIMEOUT_MS;
    process.env.BB_WS_SOCKET_FIND_TIMEOUT_MS = "100";
    try {
      vi.mocked(execHostFile).mockImplementation((async (
        cmd: string,
        args: readonly string[],
      ) => {
        if (cmd === "find") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          throw new Error("Command timed out after 100ms");
        }
        const stdout = args.includes("cwd")
          ? "p531\nfcwd\ntDIR\nn/\n"
          : "p531\nf1\ntunix\nnc.sock\n";
        return { stdout, stderr: "" };
      }) as never);
      expect(await inspectWorkspaceProcesses(ws)).toEqual({
        supported: true,
        pids: [],
        unreadablePids: [531],
      });
    } finally {
      if (prior === undefined) delete process.env.BB_WS_SOCKET_FIND_TIMEOUT_MS;
      else process.env.BB_WS_SOCKET_FIND_TIMEOUT_MS = prior;
      await rm(ws, { recursive: true, force: true });
    }
  });
});
