import { execHostFile } from "@bb/process-utils";
import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectWorkspaceProcesses } from "./workspace-processes.js";

vi.mock("@bb/process-utils", () => ({
  execHostFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

it.skipIf(process.platform !== "linux")(
  "finds same-user cwd and mapped paths without treating sibling paths or shared inodes as workspace use",
  async () => {
    const uid = process.getuid!();
    vi.mocked(realpath).mockResolvedValue("/workspace");
    vi.mocked(readdir).mockResolvedValue([
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
      "107",
      "self",
    ] as never);
    vi.mocked(readFile).mockImplementation(async (file) => {
      const name = String(file);
      if (name.endsWith("/status"))
        return `Name:\tworker\nState:\tS (sleeping)\nUid:\t${name.includes("/106/") ? uid + 1 : uid}\t${uid + 1}\t${uid + 1}\t${uid + 1}\n`;
      const mapped = name.includes("/102/")
        ? "/workspace/lib.so (deleted)"
        : name.includes("/107/")
          ? "/workspace/a\\040b.so"
          : "/production/lib.so";
      return `1000-2000 r-xp 00000000 08:01 123 ${mapped}\n`;
    });
    vi.mocked(readlink).mockImplementation(async (file) =>
      String(file).includes("/101/")
        ? "/workspace (deleted)"
        : String(file).includes("/103/")
          ? "/workspace-other"
          : String(file).includes("/105/") || String(file).includes("/106/")
            ? "/workspace/subdir"
            : "/elsewhere",
    );
    expect(await inspectWorkspaceProcesses("/workspace-alias")).toEqual({
      supported: true,
      pids: [101, 102, 105, 107],
      unreadablePids: [],
      processCommands: {
        "101": "worker",
        "102": "worker",
        "105": "worker",
        "107": "worker",
      },
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses unreadable same-user processes but tolerates an exited process",
  async () => {
    const uid = process.getuid!();
    vi.mocked(realpath).mockResolvedValue("/workspace");
    vi.mocked(readdir).mockResolvedValue(["201", "202", "203"] as never);
    vi.mocked(readFile).mockImplementation(async (file) => {
      if (String(file).includes("/203/"))
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (String(file).endsWith("/status"))
        return `State:\tS\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    vi.mocked(readlink).mockImplementation(async (file) => {
      if (String(file).includes("/201/"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return "/elsewhere";
    });
    vi.mocked(stat).mockRejectedValue(
      Object.assign(new Error("gone"), { code: "ENOENT" }),
    );
    expect(await inspectWorkspaceProcesses("/workspace")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [201, 202],
    });
  },
);

it.skipIf(process.platform === "linux" || process.platform === "darwin")(
  "refuses recovery where process inspection is unsupported",
  async () => {
    expect(await inspectWorkspaceProcesses("/workspace")).toEqual({
      supported: false,
      pids: [],
      unreadablePids: [],
    });
  },
);

it.skipIf(process.platform !== "linux").each([
  ["/literal\\040name", "/literal\\040name/lib.so", "/elsewhere"],
  ["/literal\\012name", "/literal\\012name/lib.so", "/elsewhere"],
  ["/newline\nname", "/newline\\012name/lib.so", "/elsewhere"],
  ["/workspace (deleted)", "/elsewhere/lib.so", "/workspace (deleted)"],
])(
  "preserves ambiguous proc pathnames for %s",
  async (workspace, mapped, cwd) => {
    const uid = process.getuid!();
    vi.mocked(realpath).mockResolvedValue(workspace);
    vi.mocked(readdir).mockResolvedValue(["301"] as never);
    vi.mocked(readFile).mockImplementation(async (file) =>
      String(file).endsWith("/status")
        ? `State:\tS\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`
        : `1000-2000 r-xp 00000000 08:01 123 ${mapped}\n`,
    );
    vi.mocked(readlink).mockResolvedValue(cwd);
    expect(await inspectWorkspaceProcesses(workspace)).toEqual({
      supported: true,
      pids: [301],
      unreadablePids: [],
    });
  },
);

describe("darwin workspace process inspection", () => {
  let platform: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(() => {
    platform.mockRestore();
  });

  it.each([
    {
      name: "cwd inside workspace",
      lsof: "p501\nccwd-holder\nfcwd\ntDIR\nn/ws/project\n",
      workspace: "/ws/project",
      paths: { "/ws/project": "/ws/project" },
      expected: {
        supported: true,
        pids: [501],
        unreadablePids: [],
        processCommands: { "501": "cwd-holder" },
      },
    },
    {
      name: "open file inside workspace",
      lsof: "p502\ncfile-holder\nf3\ntREG\nn/ws/project/data.txt\n",
      workspace: "/ws/project",
      paths: { "/ws/project/data.txt": "/ws/project/data.txt" },
      expected: {
        supported: true,
        pids: [502],
        unreadablePids: [],
        processCommands: { "502": "file-holder" },
      },
    },
    {
      name: "outside workspace",
      lsof: "p503\nn/tmp/other\n",
      workspace: "/ws/project",
      paths: { "/tmp/other": "/tmp/other" },
      expected: { supported: true, pids: [], unreadablePids: [] },
    },
    {
      name: "prefix collision",
      lsof: "p504\nn/a/bc/file\n",
      workspace: "/a/b",
      paths: { "/a/bc/file": "/a/bc/file", "/a/b": "/a/b" },
      expected: { supported: true, pids: [], unreadablePids: [] },
    },
    {
      name: "tmp symlink alias",
      lsof: "p505\nn/tmp/ws\n",
      workspace: "/private/tmp/ws",
      paths: { "/tmp/ws": "/private/tmp/ws", "/private/tmp/ws": "/private/tmp/ws" },
      expected: { supported: true, pids: [505], unreadablePids: [] },
    },
    {
      name: "daemon pid excluded",
      lsof: `p${process.pid}\nn/ws/project\np506\nn/ws/project\n`,
      workspace: "/ws/project",
      paths: { "/ws/project": "/ws/project" },
      expected: { supported: true, pids: [506], unreadablePids: [] },
    },
    {
      name: "unreadable path",
      lsof: "p507\nn/ws/project/secret\n",
      workspace: "/ws/project",
      paths: { "/ws/project": "/ws/project" },
      realpathError: Object.assign(new Error("denied"), { code: "EACCES" }),
      realpathErrorPath: "/ws/project/secret",
      expected: { supported: true, pids: [], unreadablePids: [507] },
    },
  ])("$name", async ({ lsof, workspace, paths, realpathError, realpathErrorPath, expected }) => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: lsof,
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      const mapped = (paths as Record<string, string | undefined>)[key];
      if (mapped !== undefined) return mapped;
      if (
        realpathError !== undefined &&
        realpathErrorPath !== undefined &&
        key === realpathErrorPath
      )
        throw realpathError;
      return key;
    });
    expect(await inspectWorkspaceProcesses(workspace)).toEqual(expected);
  });

  it("treats data volume lsof path as unreadable when ancestor realpath hits EACCES", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p509\nn/System/Volumes/Data/Users/x/ws/f\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/Users/x/ws") return "/Users/x/ws";
      if (key.startsWith("/System/Volumes/Data/Users/x/ws")) throw denied;
      return key;
    });
    expect(await inspectWorkspaceProcesses("/Users/x/ws")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [509],
    });
  });

  it("treats APFS filename with arrow as a workspace holder", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p511\nf1\ntREG\nn/Users/x/ws/cache->source\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/Users/x/ws") return "/Users/x/ws";
      if (key === "/Users/x/ws/cache->source") return "/Users/x/ws/cache->source";
      return key;
    });
    expect(await inspectWorkspaceProcesses("/Users/x/ws")).toEqual({
      supported: true,
      pids: [511],
      unreadablePids: [],
    });
  });

  it("treats APFS filename with arrow as unreadable when resolution fails", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p512\nf1\ntREG\nn/Users/x/ws/cache->source\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/Users/x/ws") return "/Users/x/ws";
      if (key === "/Users/x/ws/cache->source") throw denied;
      return key;
    });
    expect(await inspectWorkspaceProcesses("/Users/x/ws")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [512],
    });
  });

  it("ignores unix socket descriptor names without a path", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p513\nf1\ntunix\nn->0xdeadbeef\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockResolvedValue("/Users/x/ws");
    expect(await inspectWorkspaceProcesses("/Users/x/ws")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [],
    });
  });

  it("treats a workspace unix socket path as a holder", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p514\nf1\ntunix\nn/ws/project/.devserver.sock\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/ws/project") return "/ws/project";
      if (key === "/ws/project/.devserver.sock")
        return "/ws/project/.devserver.sock";
      return key;
    });
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: true,
      pids: [514],
      unreadablePids: [],
    });
  });

  it("treats a workspace unix socket path as unreadable when resolution fails", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p515\nf1\ntunix\nn/ws/project/.devserver.sock\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/ws/project") return "/ws/project";
      if (key === "/ws/project/.devserver.sock") throw denied;
      return key;
    });
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [515],
    });
  });

  it.each([
    {
      pid: 516,
      lsof: "p516\nf1\ntunix\nn/tmp//ws/a.sock\n",
      lsofPath: "/tmp/ws/a.sock",
    },
    {
      pid: 517,
      lsof: "p517\nf1\ntunix\nn/tmp/ws/./a.sock\n",
      lsofPath: "/tmp/ws/a.sock",
    },
    {
      pid: 518,
      lsof: "p518\nf1\ntunix\nn/tmp/ws/sub/../b.sock\n",
      lsofPath: "/tmp/ws/b.sock",
    },
  ])(
    "matches workspace unix socket when lsof path normalizes ($pid)",
    async ({ pid, lsof, lsofPath }) => {
      vi.mocked(execHostFile).mockImplementation((async () => ({
        stdout: lsof,
        stderr: "",
      })) as never);
      vi.mocked(realpath).mockImplementation(async (value) => {
        const key = String(value);
        if (key === "/tmp/ws") return "/tmp/ws";
        if (key === lsofPath) return lsofPath;
        return key;
      });
      expect(await inspectWorkspaceProcesses("/tmp/ws")).toEqual({
        supported: true,
        pids: [pid],
        unreadablePids: [],
      });
    },
  );

  it("treats normalized unix socket path as unreadable when resolution fails", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p519\nf1\ntunix\nn/tmp//ws/a.sock\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/tmp/ws") return "/tmp/ws";
      if (key === "/tmp/ws/a.sock") throw denied;
      return key;
    });
    expect(await inspectWorkspaceProcesses("/tmp/ws")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [519],
    });
  });

  it.each([
    {
      pid: 523,
      sock: "c.sock",
      cwdOut: "p523\nfcwd\ntDIR\nn/tmp/ws\n",
      filesOut: "p523\nf1\ntunix\nnc.sock\n",
      sockPath: "/tmp/ws/c.sock",
    },
    {
      pid: 524,
      sock: "sub/c.sock",
      cwdOut: "p524\nfcwd\ntDIR\nn/tmp/ws\n",
      filesOut: "p524\nf1\ntunix\nnsub/c.sock\n",
      sockPath: "/tmp/ws/sub/c.sock",
    },
  ])(
    "matches relative unix bind when cwd is the workspace ($sock)",
    async ({ pid, cwdOut, filesOut, sockPath }) => {
      vi.mocked(execHostFile).mockImplementation((async (_cmd: string, args: readonly string[]) => {
        const flags = (args as string[] | undefined) ?? [];
        const stdout = flags.includes("cwd") ? cwdOut : filesOut;
        return { stdout, stderr: "" };
      }) as never);
      vi.mocked(realpath).mockImplementation(async (value) => {
        const key = String(value);
        if (key === "/tmp/ws") return "/tmp/ws";
        if (key === sockPath) return sockPath;
        return key;
      });
      expect(await inspectWorkspaceProcesses("/tmp/ws")).toEqual({
        supported: true,
        pids: [pid],
        unreadablePids: [],
      });
    },
  );

  it("treats relative unix bind paths as unreadable", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p520\nf1\ntunix\nn./c.sock\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockResolvedValue("/tmp/ws");
    expect(await inspectWorkspaceProcesses("/tmp/ws")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [520],
    });
  });

  it("treats data volume lsof path as unreadable when ancestor realpath hits ELOOP", async () => {
    const loop = Object.assign(new Error("loop"), { code: "ELOOP" });
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p510\nn/System/Volumes/Data/Users/x/ws/f\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/Users/x/ws") return "/Users/x/ws";
      if (key.startsWith("/System/Volumes/Data/Users/x/ws")) throw loop;
      return key;
    });
    expect(await inspectWorkspaceProcesses("/Users/x/ws")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [510],
    });
  });

  it("reports a holder when lsof uses a tmp alias for a deleted workspace file", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p508\nn/tmp/ws/file (deleted)\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/tmp/ws/file (deleted)" || key === "/tmp/ws/file" || key === "/tmp/ws") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (key === "/tmp") return "/private/tmp";
      if (key === "/private/tmp/ws") return "/private/tmp/ws";
      return key;
    });
    expect(await inspectWorkspaceProcesses("/private/tmp/ws")).toEqual({
      supported: true,
      pids: [508],
      unreadablePids: [],
    });
  });

  it("returns unsupported when lsof fails", async () => {
    vi.mocked(execHostFile).mockRejectedValue(new Error("lsof failed"));
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: false,
      pids: [],
      unreadablePids: [],
    });
  });

  it("returns unsupported when lsof prints permission warnings on stderr", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => {
      throw Object.assign(new Error("lsof exit 1"), {
        code: 1,
        stdout: "p501\nfcwd\nn/ws/project\n",
        stderr: "lsof: can't access /proc/123/cwd: Permission denied\n",
      });
    }) as never);
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: false,
      pids: [],
      unreadablePids: [],
    });
  });

  it("returns unsupported when lsof field output is garbled", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p501\nzgarbled\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockResolvedValue("/ws/project");
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: false,
      pids: [],
      unreadablePids: [],
    });
  });

  it("treats a pid-only lsof record as unreadable for recovery refusal", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p501\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockResolvedValue("/ws/project");
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [501],
    });
  });

  it("treats an earlier pid without path lines as unreadable", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => ({
      stdout: "p501\np502\nn/ws/project\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockImplementation(async (value) => {
      const key = String(value);
      if (key === "/ws/project") return "/ws/project";
      return key;
    });
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: true,
      pids: [502],
      unreadablePids: [501],
    });
  });

  it("returns unsupported when lsof warns on stderr with no stdout", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => {
      throw Object.assign(new Error("lsof exit 1"), {
        code: 1,
        stdout: "",
        stderr: "lsof: can't access task for pid 123: Operation not permitted\n",
      });
    }) as never);
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: false,
      pids: [],
      unreadablePids: [],
    });
  });

  it("does not pass -w so lsof warnings fail inspection", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => {
      throw Object.assign(new Error("lsof exit 1"), {
        code: 1,
        stdout: "",
        stderr: "",
      });
    }) as never);
    vi.mocked(realpath).mockResolvedValue("/ws/project");
    await inspectWorkspaceProcesses("/ws/project");
    for (const call of vi.mocked(execHostFile).mock.calls) {
      expect(call[0]).toBe("lsof");
      expect(call[1]).not.toContain("-w");
    }
  });

  it("treats exit 1 with empty stdout and stderr as no matching processes", async () => {
    vi.mocked(execHostFile).mockImplementation((async () => {
      throw Object.assign(new Error("lsof exit 1"), {
        code: 1,
        stdout: "",
        stderr: "",
      });
    }) as never);
    vi.mocked(realpath).mockResolvedValue("/ws/project");
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: true,
      pids: [],
      unreadablePids: [],
    });
  });
});
