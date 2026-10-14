export interface LauncherDisconnectPort {
  channel?: { unref(): void } | undefined;
  once(event: "disconnect", listener: () => void): unknown;
}

export interface LauncherDisconnectWatch {
  setShutdown(args: {
    shutdown: () => Promise<void>;
    exit: (code: number) => never;
  }): void;
}

export function watchLauncherDisconnect(
  port: LauncherDisconnectPort,
): LauncherDisconnectWatch {
  let disconnected = false;
  let shutdown: (() => Promise<void>) | null = null;
  let exit: ((code: number) => never) | null = null;

  const stop = (): void => {
    if (!disconnected || shutdown === null || exit === null) return;
    const runShutdown = shutdown;
    const exitProcess = exit;
    shutdown = null;
    exit = null;
    void runShutdown().finally(() => exitProcess(0));
  };

  port.channel?.unref();
  port.once("disconnect", () => {
    disconnected = true;
    stop();
  });

  return {
    setShutdown(args) {
      shutdown = args.shutdown;
      exit = args.exit;
      stop();
    },
  };
}
