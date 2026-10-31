import { z } from "zod";

export interface QuitActivity {
  activeThreads: number;
  nativeTerminals: number;
}

export function decideQuit(args: {
  userInitiated: boolean;
  confirmed: boolean;
  activity: QuitActivity | null;
}): "quit" | "prompt" {
  if (!args.userInitiated || args.confirmed) return "quit";
  return args.activity !== null &&
    args.activity.activeThreads === 0 &&
    args.activity.nativeTerminals === 0
    ? "quit"
    : "prompt";
}

export function createQuitGuard(args: {
  queryActivity(signal: AbortSignal): Promise<QuitActivity>;
  confirm(activity: QuitActivity | null, signal: AbortSignal): Promise<boolean>;
  finishQuit(): Promise<void>;
  quitApplication(): void;
  now?: () => number;
}) {
  let userInitiated = false;
  let firstRequestAt: number | null = null;
  let pending: AbortController | null = null;
  let stopping = false;
  let finished = false;

  function stop(): void {
    if (stopping) return;
    stopping = true;
    pending?.abort();
    pending = null;
    void args.finishQuit().finally(() => {
      finished = true;
      args.quitApplication();
    });
  }

  async function check(controller: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const activity = await Promise.race([
      Promise.resolve()
        .then(() => args.queryActivity(controller.signal))
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
          controller.abort();
        }, 1000);
      }),
    ]);
    clearTimeout(timer);
    if (pending !== controller) return;
    const dialogController = new AbortController();
    pending = dialogController;
    const decision = decideQuit({
      userInitiated: true,
      confirmed: false,
      activity,
    });
    if (decision === "quit") {
      stop();
      return;
    }
    const confirmed = await args
      .confirm(activity, dialogController.signal)
      .catch(() => false);
    if (pending !== dialogController) return;
    pending = null;
    firstRequestAt = null;
    if (decideQuit({ userInitiated: true, confirmed, activity }) === "quit")
      stop();
  }

  return {
    requestUserQuit() {
      userInitiated = true;
      args.quitApplication();
    },
    handleBeforeQuit(event: { preventDefault(): void }) {
      if (finished) return;
      event.preventDefault();
      const isUser = userInitiated;
      userInitiated = false;
      if (stopping) return;
      const now = (args.now ?? Date.now)();
      if (
        decideQuit({
          userInitiated: isUser,
          confirmed: firstRequestAt !== null && now - firstRequestAt <= 2000,
          activity: null,
        }) === "quit"
      ) {
        stop();
        return;
      }
      if (pending !== null) return;
      firstRequestAt = now;
      pending = new AbortController();
      void check(pending);
    },
  };
}

const threadSchema = z.object({
  id: z.string(),
  status: z.enum([
    "pending",
    "idle",
    "starting",
    "active",
    "stopping",
    "error",
  ]),
  nativeTerminal: z.boolean().optional(),
});
const nativeSchema = z.object({
  terminal: z
    .object({
      status: z.enum(["starting", "running", "disconnected", "exited"]),
    })
    .nullable(),
});

export async function queryQuitActivity(args: {
  serverUrl: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<QuitActivity> {
  async function read(path: string): Promise<unknown> {
    const url = new URL(args.serverUrl);
    url.pathname = `/api/v1/${path.split("?")[0]}`;
    url.search = path.split("?")[1] ?? "";
    url.hash = "";
    const response = await args.fetchImpl(url.toString(), {
      signal: args.signal,
      credentials: "include",
    });
    if (!response.ok)
      throw new Error(`Quit activity query failed: ${response.status}`);
    return response.json();
  }
  const groups = await Promise.all(
    [false, true].map(async (archived) =>
      z
        .array(threadSchema)
        .parse(await read(`threads?includeHidden=true&archived=${archived}`)),
    ),
  );
  const threads = groups.flat();
  const terminals = await Promise.all(
    threads
      .filter((thread) => thread.nativeTerminal)
      .map(
        async (thread) =>
          nativeSchema.parse(
            await read(
              `threads/${encodeURIComponent(thread.id)}/native-terminal`,
            ),
          ).terminal,
      ),
  );
  return {
    activeThreads: threads.filter((thread) =>
      ["starting", "active", "stopping"].includes(thread.status),
    ).length,
    nativeTerminals: terminals.filter(
      (terminal) =>
        terminal !== null && ["starting", "running"].includes(terminal.status),
    ).length,
  };
}
