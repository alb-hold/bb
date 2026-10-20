import { z } from "zod";

export const TERMINAL_DATA_PLANE_PROBE_TIMEOUT_MS = 3_000;

export const TERMINAL_HOLDER_SESSIONS_TIMEOUT_MS = 3_000;

export const terminalHolderSessionsCommandSchema = z
  .object({
    type: z.literal("terminal.holder-sessions"),
    terminalIds: z.array(z.string().min(1)).max(1_000),
  })
  .strict();

export const terminalHolderSessionsResultSchema = z
  .object({ terminalIds: z.array(z.string().min(1)).max(1_000) })
  .strict();
export type TerminalHolderSessionsResult = z.infer<
  typeof terminalHolderSessionsResultSchema
>;

export const terminalDataPlaneProbeCommandSchema = z
  .object({
    type: z.literal("terminal-data-plane.probe"),
  })
  .strict();

export const terminalDataPlaneProbeResultSchema = z
  .object({
    dataSocket: z.boolean(),
    ipcVersion: z.number().int().positive(),
  })
  .strict();
export type TerminalDataPlaneProbeResult = z.infer<
  typeof terminalDataPlaneProbeResultSchema
>;

export const terminalDataPlaneConnectCommandSchema = z
  .object({
    type: z.literal("terminal-data-plane.connect"),
    url: z.string().min(1),
    ticket: z.string().min(16),
  })
  .strict();

export const terminalDataPlaneConnectResultSchema = z
  .object({
    connected: z.boolean(),
  })
  .strict();
export type TerminalDataPlaneConnectResult = z.infer<
  typeof terminalDataPlaneConnectResultSchema
>;

export const TERMINAL_DATA_SOCKET_PATH = "/internal/terminal-data";
export const TERMINAL_DATA_SOCKET_TICKET_HEADER = "x-bb-terminal-data-ticket";
