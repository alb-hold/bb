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
      lsof: "p501\nfcwd\nn/ws/project\n",
      workspace: "/ws/project",
      paths: { "/ws/project": "/ws/project" },
      expected: { supported: true, pids: [501], unreadablePids: [] },
    },
    {
      name: "open file inside workspace",
      lsof: "p502\nf1\nn/ws/project/data.txt\n",
      workspace: "/ws/project",
      paths: { "/ws/project/data.txt": "/ws/project/data.txt" },
      expected: { supported: true, pids: [502], unreadablePids: [] },
    },
    {
      name: "outside workspace",
      lsof: "p503\nfcwd\nn/tmp/other\n",
      workspace: "/ws/project",
      paths: { "/tmp/other": "/tmp/other" },
      expected: { supported: true, pids: [], unreadablePids: [] },
    },
    {
      name: "prefix collision",
      lsof: "p504\nfcwd\nn/a/bc/file\n",
      workspace: "/a/b",
      paths: { "/a/bc/file": "/a/bc/file", "/a/b": "/a/b" },
      expected: { supported: true, pids: [], unreadablePids: [] },
    },
    {
      name: "tmp symlink alias",
      lsof: "p505\nfcwd\nn/tmp/ws\n",
      workspace: "/private/tmp/ws",
      paths: { "/tmp/ws": "/private/tmp/ws", "/private/tmp/ws": "/private/tmp/ws" },
      expected: { supported: true, pids: [505], unreadablePids: [] },
    },
    {
      name: "daemon pid excluded",
      lsof: `p${process.pid}\nfcwd\nn/ws/project\np506\nfcwd\nn/ws/project\n`,
      workspace: "/ws/project",
      paths: { "/ws/project": "/ws/project" },
      expected: { supported: true, pids: [506], unreadablePids: [] },
    },
    {
      name: "unreadable path",
      lsof: "p507\nf1\nn/ws/project/secret\n",
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
      stdout: "p501\nfcwd\n",
      stderr: "",
    })) as never);
    vi.mocked(realpath).mockResolvedValue("/ws/project");
    expect(await inspectWorkspaceProcesses("/ws/project")).toEqual({
      supported: false,
      pids: [],
      unreadablePids: [],
    });
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
