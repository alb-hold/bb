import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const OPENED_POLL_MS = 50;

export interface BrowserSentinel {
  readonly command: string;
  readonly opened: Promise<void>;
  dispose(): Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function createBrowserSentinel(): Promise<BrowserSentinel | null> {
  if (process.platform === "win32") {
    return null;
  }
  const dir = await fs.mkdtemp(join(tmpdir(), "bb-acp-browser-"));
  const command = join(dir, "browser");
  if (command.includes(delimiter)) {
    await fs.rm(dir, { recursive: true, force: true });
    return null;
  }
  const marker = join(dir, "opened");
  await fs.writeFile(
    command,
    `#!/bin/sh\n: > ${shellQuote(marker)}\nexit 0\n`,
    { mode: 0o700 },
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opened = new Promise<void>((resolve) => {
    const check = () => {
      fs.access(marker).then(resolve, () => {
        if (stopped) return;
        timer = setTimeout(check, OPENED_POLL_MS);
        timer.unref();
      });
    };
    check();
  });
  return {
    command,
    opened,
    dispose: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
