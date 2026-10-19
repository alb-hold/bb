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
      "Thread-only handoffs go to the device bound to BB_TURN_ID when it is set; otherwise they go to the device that most recently sent a message in that thread. If no device has sent one, open the thread on the target device, send a message, then run the command again. A disconnected device can receive its pending handoffs after reconnecting.",
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
