import { Buffer } from "node:buffer";
import { Command } from "commander";
import { DEVICE_HANDOFF_TEXT_MAX_BYTES } from "@bb/server-contract";
import { action, CliUsageError } from "../action.js";
import type { CommandGroupDeps } from "../command-groups.js";
import { createCliBbSdk } from "../client.js";

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > DEVICE_HANDOFF_TEXT_MAX_BYTES) {
      throw new CliUsageError({
        code: "invalid_argument",
        message: "Copy text exceeds the 1 MiB limit.",
        hint: null,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getOrigin(deps: CommandGroupDeps) {
  const context = deps.getContext();
  const origin = {
    ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
    ...(process.env.BB_TURN_ID === undefined
      ? {}
      : { turnId: process.env.BB_TURN_ID }),
    ...(process.env.BB_TERMINAL_SESSION_ID === undefined
      ? {}
      : { terminalSessionId: process.env.BB_TERMINAL_SESSION_ID }),
  };
  if (origin.threadId === undefined && origin.terminalSessionId === undefined) {
    throw new CliUsageError({
      code: "missing_context",
      message:
        "Device handoff requires BB_THREAD_ID or BB_TERMINAL_SESSION_ID.",
      hint: null,
    });
  }
  return origin;
}

export function registerDeviceCommands(
  program: Command,
  deps: CommandGroupDeps,
): void {
  const device = program
    .command("device")
    .description("Hand off text and URLs to a device viewing the origin")
    .addHelpText(
      "after",
      "A thread-only handoff goes to the device that most recently sent a message in the thread's current turn, whether it started the turn or steered it. bb finds that turn itself. If BB_TURN_ID is set, it must name that turn, or the request fails with: BB_TURN_ID does not match the thread's current turn. With no current turn, it goes to the device that most recently sent a message in the thread, and fails with the existing no-recipient error if none has. A disconnected device can receive its pending handoffs after reconnecting.",
    );

  device
    .command("copy [text]")
    .description("Offer text for copying on the device viewing bb")
    .action(
      action(async (text?: string) => {
        const value = text ?? (await readStdinText());
        if (Buffer.byteLength(value, "utf8") > DEVICE_HANDOFF_TEXT_MAX_BYTES) {
          throw new CliUsageError({
            code: "invalid_argument",
            message: "Copy text exceeds the 1 MiB limit.",
            hint: null,
          });
        }
        await createCliBbSdk(deps.getUrl()).device.request({
          kind: "copy-text",
          text: value,
          origin: getOrigin(deps),
        });
      }),
    );

  device
    .command("open <url>")
    .description("Offer an HTTP or HTTPS URL to the device viewing bb")
    .action(
      action(async (url: string) => {
        await createCliBbSdk(deps.getUrl()).device.request({
          kind: "open-url",
          url,
          origin: getOrigin(deps),
        });
      }),
    );
}
