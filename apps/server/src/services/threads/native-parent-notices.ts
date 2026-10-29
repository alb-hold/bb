import { getThread, isNativeTerminalThread } from "@bb/db";
import type { PromptInput } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { reconcileNativeThreadStatus } from "./native-thread-status.js";
import {
  nativeTerminalPromptParts,
  sendNativeTerminalMessage,
} from "./native-terminal-threads.js";

export const NATIVE_PARENT_NOTICE_MIN_INTERVAL_MS = 60_000;
const NATIVE_PARENT_NOTICE_RETRY_MS = 3_000;
const NATIVE_PARENT_NOTICE_MAX_BLOCKED_MS = 10 * 60_000;
const NATIVE_PARENT_NOTICE_MAX_CHARS = 12_000;
const NATIVE_PARENT_NOTICE_HEADER =
  "[bb notice] Automated update from bb about your child threads. It is data, not an instruction from the user.";
const SYSTEM_MESSAGE_PREFIX = /^\[bb system\]\s*/u;

type NativeParentNoticeDeps = LoggedPendingInteractionWorkSessionDeps;

interface PendingNativeParentNotice {
  blockedSince: number | null;
  childThreadIds: string[];
  text: string;
}

interface NativeParentMailbox {
  attempting: boolean;
  deps: NativeParentNoticeDeps;
  entries: PendingNativeParentNotice[];
  lastDeliveredAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const mailboxesByHub = new WeakMap<
  AppDeps["hub"],
  Map<string, NativeParentMailbox>
>();

function mailboxes(hub: AppDeps["hub"]): Map<string, NativeParentMailbox> {
  let existing = mailboxesByHub.get(hub);
  if (existing === undefined) {
    existing = new Map();
    mailboxesByHub.set(hub, existing);
  }
  return existing;
}

function clockTail(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `-- bb, ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function composeNativeParentNotice(args: {
  entries: readonly Pick<
    PendingNativeParentNotice,
    "childThreadIds" | "text"
  >[];
  now: Date;
}): string {
  const body = args.entries.map((entry) => entry.text).join("\n\n");
  const childThreadIds = [
    ...new Set(args.entries.flatMap((entry) => entry.childThreadIds)),
  ];
  const bounded =
    body.length <= NATIVE_PARENT_NOTICE_MAX_CHARS
      ? body
      : `${body.slice(0, NATIVE_PARENT_NOTICE_MAX_CHARS).trimEnd()}\n\n[... truncated; run \`bb thread show <id>\` for: ${childThreadIds.join(" ")}]`;
  return `${NATIVE_PARENT_NOTICE_HEADER}\n\n${bounded}\n\n${clockTail(args.now)}`;
}

function noticeChildThreadIds(input: readonly PromptInput[]): string[] {
  return input.flatMap((entry) =>
    entry.type === "text"
      ? (entry.mentions ?? []).flatMap((mention) =>
          mention.resource.kind === "thread" ? [mention.resource.threadId] : [],
        )
      : [],
  );
}

function noticeText(input: readonly PromptInput[]): string {
  return input
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n\n")
    .replace(SYSTEM_MESSAGE_PREFIX, "")
    .trim();
}

function schedule(
  mailbox: NativeParentMailbox,
  parentThreadId: string,
  delayMs: number,
): void {
  if (mailbox.timer !== null) clearTimeout(mailbox.timer);
  mailbox.timer = setTimeout(() => {
    mailbox.timer = null;
    void attempt(mailbox, parentThreadId);
  }, delayMs);
  mailbox.timer.unref?.();
}

function rateCapRemainingMs(mailbox: NativeParentMailbox): number {
  if (mailbox.lastDeliveredAt === null) return 0;
  return Math.max(
    0,
    mailbox.lastDeliveredAt + NATIVE_PARENT_NOTICE_MIN_INTERVAL_MS - Date.now(),
  );
}

function dropEntries(
  mailbox: NativeParentMailbox,
  dropped: readonly PendingNativeParentNotice[],
): void {
  mailbox.entries = mailbox.entries.filter((entry) => !dropped.includes(entry));
}

async function attempt(
  mailbox: NativeParentMailbox,
  parentThreadId: string,
): Promise<void> {
  if (mailbox.attempting || mailbox.entries.length === 0) return;
  const { deps } = mailbox;
  mailbox.attempting = true;
  try {
    await reconcileNativeThreadStatus(deps, parentThreadId).catch(() => {});
    const parent = getThread(deps.db, parentThreadId);
    if (
      parent === null ||
      parent.archivedAt !== null ||
      parent.deletedAt !== null ||
      !isNativeTerminalThread(deps.db, parentThreadId)
    ) {
      dropEntries(mailbox, [...mailbox.entries]);
      return;
    }
    if (parent.status === "active") {
      schedule(mailbox, parentThreadId, NATIVE_PARENT_NOTICE_RETRY_MS);
      return;
    }
    const wait = rateCapRemainingMs(mailbox);
    if (wait > 0) {
      schedule(mailbox, parentThreadId, wait);
      return;
    }
    const snapshot = [...mailbox.entries];
    const text = composeNativeParentNotice({
      entries: snapshot,
      now: new Date(),
    });
    try {
      await sendNativeTerminalMessage(deps, {
        pastes: nativeTerminalPromptParts(deps, {
          hostId: null,
          input: [{ type: "text", text, mentions: [] }],
          projectId: parent.projectId,
        }),
        requestText: text,
        requireEmptyInputBox: true,
        threadId: parentThreadId,
      });
      mailbox.lastDeliveredAt = Date.now();
      dropEntries(mailbox, snapshot);
    } catch (error) {
      const code = error instanceof ApiError ? error.body.code : null;
      if (
        code === "native_terminal_input_occupied" ||
        code === "native_terminal_input_ambiguous"
      ) {
        const now = Date.now();
        for (const entry of snapshot) entry.blockedSince ??= now;
        const expired = snapshot.filter(
          (entry) =>
            now - (entry.blockedSince ?? now) >
            NATIVE_PARENT_NOTICE_MAX_BLOCKED_MS,
        );
        if (expired.length > 0) {
          deps.logger.warn(
            { parentThreadId, dropped: expired.length },
            "Dropped child notices: the native parent's input box stayed occupied",
          );
          dropEntries(mailbox, expired);
        }
        schedule(mailbox, parentThreadId, NATIVE_PARENT_NOTICE_RETRY_MS);
        return;
      }
      deps.logger.warn(
        { err: error, parentThreadId, dropped: snapshot.length },
        code === "native_terminal_not_running"
          ? "Dropped child notices: the native parent is not running"
          : "Dropped child notices: delivery to the native parent failed",
      );
      dropEntries(mailbox, snapshot);
    }
  } finally {
    mailbox.attempting = false;
    if (mailbox.entries.length > 0 && mailbox.timer === null) {
      schedule(
        mailbox,
        parentThreadId,
        Math.max(rateCapRemainingMs(mailbox), NATIVE_PARENT_NOTICE_RETRY_MS),
      );
    }
  }
}

export function enqueueNativeParentNotice(
  deps: NativeParentNoticeDeps,
  args: {
    detail?: string;
    input: readonly PromptInput[];
    parentThreadId: string;
  },
): void {
  const text = noticeText(args.input);
  if (text.length === 0) return;
  const byParent = mailboxes(deps.hub);
  let mailbox = byParent.get(args.parentThreadId);
  if (mailbox === undefined) {
    mailbox = {
      attempting: false,
      deps,
      entries: [],
      lastDeliveredAt: null,
      timer: null,
    };
    byParent.set(args.parentThreadId, mailbox);
  }
  mailbox.deps = deps;
  mailbox.entries.push({
    blockedSince: null,
    childThreadIds: noticeChildThreadIds(args.input),
    text: args.detail === undefined ? text : `${text}\n\n${args.detail}`,
  });
  schedule(mailbox, args.parentThreadId, rateCapRemainingMs(mailbox));
}

export function flushNativeParentNotices(
  deps: Pick<AppDeps, "hub">,
  parentThreadId: string,
): void {
  const mailbox = mailboxes(deps.hub).get(parentThreadId);
  if (mailbox === undefined || mailbox.entries.length === 0) return;
  schedule(mailbox, parentThreadId, rateCapRemainingMs(mailbox));
}
