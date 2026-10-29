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
        return `State:\tS (sleeping)\nUid:\t${name.includes("/106/") ? uid + 1 : uid}\t${uid + 1}\t${uid + 1}\t${uid + 1}\n`;
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
      lsof: "p501\nn/ws/project\n",
      workspace: "/ws/project",
      paths: { "/ws/project": "/ws/project" },
      expected: { supported: true, pids: [501], unreadablePids: [] },
    },
    {
      name: "open file inside workspace",
      lsof: "p502\nn/ws/project/data.txt\n",
      workspace: "/ws/project",
      paths: { "/ws/project/data.txt": "/ws/project/data.txt" },
      expected: { supported: true, pids: [502], unreadablePids: [] },
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
