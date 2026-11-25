import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureUnitOomPolicy,
  OOM_POLICY_DROP_IN_CONTENT,
  OOM_POLICY_DROP_IN_NAME,
} from "./unit-oom-policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function unitText(args: { dataDir: string; extra: string }): string {
  return `[Unit]
Description=bb host daemon for old-server.local

[Service]
ExecStart="/usr/bin/node" "/home/me/bb-app" host-daemon --auto-update --host-daemon-port "38887" --server-url "http://old-server.local:3000"
Environment="BB_DATA_DIR=${args.dataDir}"
Restart=always
RestartSec=2
${args.extra}KillMode=process

[Install]
WantedBy=default.target
`;
}

interface Fixture {
  dataDir: string;
  unitPath: string;
  dropInDir: string;
  ownDropInPath: string;
  commands: string[][];
  shown: { value: string };
  args: Parameters<typeof ensureUnitOomPolicy>[0];
}

async function createFixture(extra = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "bb-unit-oom-policy-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  const unitDir = join(homeDir, ".config", "systemd", "user");
  await mkdir(dataDir, { recursive: true });
  await mkdir(unitDir, { recursive: true });
  const unitPath = join(unitDir, "bb-host-daemon-test.service");
  await writeFile(unitPath, unitText({ dataDir, extra }), "utf8");
  const commands: string[][] = [];
  const shown = { value: "OOMPolicy=stop\n" };
  const dropInDir = `${unitPath}.d`;
  return {
    dataDir,
    unitPath,
    dropInDir,
    ownDropInPath: join(dropInDir, OOM_POLICY_DROP_IN_NAME),
    commands,
    shown,
    args: {
      dataDir,
      homeDir,
      platform: "linux",
      env: {},
      runCommand: async (command, commandArgs) => {
        commands.push([command, ...commandArgs]);
      },
      readCommandOutput: async (command, commandArgs) => {
        commands.push([command, ...commandArgs]);
        return shown.value;
      },
    },
  };
}

const SHOW = [
  "systemctl",
  "--user",
  "show",
  "-p",
  "OOMPolicy",
  "bb-host-daemon-test.service",
];
const RELOAD = ["systemctl", "--user", "daemon-reload"];

describe("ensureUnitOomPolicy", () => {
  it("adds bb's drop-in to a unit installed before OOMPolicy=continue and reloads without restarting", async () => {
    const fixture = await createFixture();

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    await expect(readFile(fixture.ownDropInPath, "utf8")).resolves.toBe(
      OOM_POLICY_DROP_IN_CONTENT,
    );
    expect(fixture.commands).toEqual([SHOW, RELOAD]);
  });

  it("is idempotent once systemd reports continue, leaving other drop-ins and the unit untouched", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    await writeFile(
      join(fixture.dropInDir, "10-bb-killmode.conf"),
      "[Service]\nKillMode=mixed\n",
      "utf8",
    );
    const unitBefore = await readFile(fixture.unitPath, "utf8");

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");
    fixture.commands.length = 0;
    fixture.shown.value = "OOMPolicy=continue\n";
    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe(
      "already-current",
    );

    expect(fixture.commands).toEqual([SHOW]);
    expect((await readdir(fixture.dropInDir)).sort()).toEqual([
      "10-bb-killmode.conf",
      OOM_POLICY_DROP_IN_NAME,
    ]);
    await expect(
      readFile(join(fixture.dropInDir, "10-bb-killmode.conf"), "utf8"),
    ).resolves.toBe("[Service]\nKillMode=mixed\n");
    await expect(readFile(fixture.unitPath, "utf8")).resolves.toBe(unitBefore);
  });

  it("replaces its own drop-in when the content differs", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    await writeFile(
      fixture.ownDropInPath,
      "[Service]\nOOMPolicy=kill\n",
      "utf8",
    );

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    await expect(readFile(fixture.ownDropInPath, "utf8")).resolves.toBe(
      OOM_POLICY_DROP_IN_CONTENT,
    );
    expect(fixture.commands).toEqual([SHOW, RELOAD]);
  });

  it("reloads when its drop-in is already present but systemd has not loaded it", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    await writeFile(fixture.ownDropInPath, OOM_POLICY_DROP_IN_CONTENT, "utf8");

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    expect(fixture.commands).toEqual([SHOW, RELOAD]);
  });

  it("keeps the drop-in when the reload fails and retries on the next start", async () => {
    const fixture = await createFixture();
    const failing: typeof fixture.args = {
      ...fixture.args,
      runCommand: async (command, commandArgs) => {
        fixture.commands.push([command, ...commandArgs]);
        throw new Error("reload failed");
      },
    };

    await expect(ensureUnitOomPolicy(failing)).rejects.toThrow("reload failed");
    await expect(readFile(fixture.ownDropInPath, "utf8")).resolves.toBe(
      OOM_POLICY_DROP_IN_CONTENT,
    );

    fixture.commands.length = 0;
    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");
    expect(fixture.commands).toEqual([SHOW, RELOAD]);
  });

  it("skips when another drop-in sets OOMPolicy under [Service]", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    await writeFile(
      join(fixture.dropInDir, "10-custom.conf"),
      "[Service]\nOOMPolicy=kill\n",
      "utf8",
    );

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe(
      "already-current",
    );

    await expect(readdir(fixture.dropInDir)).resolves.toEqual([
      "10-custom.conf",
    ]);
    expect(fixture.commands).toEqual([]);
  });

  it("skips when the unit itself sets OOMPolicy under [Service]", async () => {
    const fixture = await createFixture("OOMPolicy=continue\n");

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe(
      "already-current",
    );

    await expect(readdir(fixture.dropInDir)).rejects.toThrow();
    expect(fixture.commands).toEqual([]);
  });

  it("still migrates when OOMPolicy appears only outside [Service] or in a comment", async () => {
    const fixture = await createFixture();
    const unit = await readFile(fixture.unitPath, "utf8");
    await writeFile(
      fixture.unitPath,
      unit.replace("[Unit]\n", "[Unit]\nOOMPolicy=kill\n") +
        "# OOMPolicy=kill\n[Install]\nOOMPolicy=kill\n",
      "utf8",
    );
    await mkdir(fixture.dropInDir, { recursive: true });
    await writeFile(
      join(fixture.dropInDir, "10-misplaced.conf"),
      "[Unit]\nOOMPolicy=kill\n",
      "utf8",
    );

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    await expect(readFile(fixture.ownDropInPath, "utf8")).resolves.toBe(
      OOM_POLICY_DROP_IN_CONTENT,
    );
  });

  it("does nothing when no unit matches this data dir or the platform has no systemd user unit", async () => {
    const fixture = await createFixture();

    await expect(
      ensureUnitOomPolicy({
        ...fixture.args,
        dataDir: join(fixture.dataDir, "other"),
      }),
    ).resolves.toBe("not-applicable");
    await expect(
      ensureUnitOomPolicy({ ...fixture.args, platform: "darwin" }),
    ).resolves.toBe("not-applicable");
    expect(fixture.commands).toEqual([]);
  });
});
