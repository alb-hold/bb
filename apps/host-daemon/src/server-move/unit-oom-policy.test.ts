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
  commands: string[][];
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
  return {
    dataDir,
    unitPath,
    dropInDir: `${unitPath}.d`,
    commands,
    args: {
      dataDir,
      homeDir,
      platform: "linux",
      env: {},
      runCommand: async (command, commandArgs) => {
        commands.push([command, ...commandArgs]);
      },
    },
  };
}

describe("ensureUnitOomPolicy", () => {
  it("adds the drop-in to a unit installed before OOMPolicy=continue and reloads without restarting", async () => {
    const fixture = await createFixture();

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    await expect(
      readFile(join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME), "utf8"),
    ).resolves.toBe(OOM_POLICY_DROP_IN_CONTENT);
    expect(fixture.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("is idempotent and leaves other drop-ins and the unit file untouched", async () => {
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
    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe(
      "already-current",
    );

    expect(fixture.commands).toEqual([]);
    expect((await readdir(fixture.dropInDir)).sort()).toEqual([
      "10-bb-killmode.conf",
      OOM_POLICY_DROP_IN_NAME,
    ]);
    await expect(
      readFile(join(fixture.dropInDir, "10-bb-killmode.conf"), "utf8"),
    ).resolves.toBe("[Service]\nKillMode=mixed\n");
    await expect(readFile(fixture.unitPath, "utf8")).resolves.toBe(unitBefore);
  });

  it("keeps an existing 50-oom-policy.conf the owner has already set", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    const custom = "[Service]\nOOMPolicy=kill\n";
    await writeFile(
      join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME),
      custom,
      "utf8",
    );

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe(
      "already-current",
    );

    await expect(
      readFile(join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME), "utf8"),
    ).resolves.toBe(custom);
    expect(fixture.commands).toEqual([]);
  });

  it("keeps a sibling drop-in's OOMPolicy effective and creates no overriding drop-in", async () => {
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

  it("never overwrites a pre-existing 50-oom-policy.conf that sets other directives", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    const unrelated = "[Service]\nNice=5\n";
    await writeFile(
      join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME),
      unrelated,
      "utf8",
    );

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    await expect(
      readFile(join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME), "utf8"),
    ).resolves.toBe(unrelated);
    await expect(
      readFile(join(fixture.dropInDir, "50-oom-policy-2.conf"), "utf8"),
    ).resolves.toBe(OOM_POLICY_DROP_IN_CONTENT);
    expect(fixture.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("removes its drop-in when the reload fails so the next start retries without a restart", async () => {
    const fixture = await createFixture();
    let failReload = true;
    const args: typeof fixture.args = {
      ...fixture.args,
      runCommand: async (command, commandArgs) => {
        fixture.commands.push([command, ...commandArgs]);
        if (failReload) {
          throw new Error("reload failed");
        }
      },
    };

    await expect(ensureUnitOomPolicy(args)).rejects.toThrow("reload failed");
    await expect(readdir(fixture.dropInDir)).resolves.toEqual([]);

    failReload = false;
    await expect(ensureUnitOomPolicy(args)).resolves.toBe("migrated");

    await expect(
      readFile(join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME), "utf8"),
    ).resolves.toBe(OOM_POLICY_DROP_IN_CONTENT);
    expect(fixture.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
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

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");

    await expect(
      readFile(join(fixture.dropInDir, OOM_POLICY_DROP_IN_NAME), "utf8"),
    ).resolves.toBe(OOM_POLICY_DROP_IN_CONTENT);
  });

  it("still migrates when a sibling drop-in sets OOMPolicy under a section other than [Service]", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.dropInDir, { recursive: true });
    await writeFile(
      join(fixture.dropInDir, "10-misplaced.conf"),
      "[Unit]\nOOMPolicy=kill\n",
      "utf8",
    );

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe("migrated");
  });

  it("does nothing for a unit that already declares OOMPolicy", async () => {
    const fixture = await createFixture("OOMPolicy=continue\n");

    await expect(ensureUnitOomPolicy(fixture.args)).resolves.toBe(
      "already-current",
    );

    await expect(readdir(fixture.dropInDir)).rejects.toThrow();
    expect(fixture.commands).toEqual([]);
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
