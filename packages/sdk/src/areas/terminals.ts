import type {
  CreateTerminalRequest,
  TerminalInputRequest,
  TerminalListQuery,
  TerminalListResponse,
  TerminalAttentionListResponse,
  TerminalOutputQuery,
  TerminalOutputResponse,
  TerminalNotifyRequest,
  TerminalResizeRequest,
  TerminalSession,
  UpdateTerminalRequest,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface TerminalThreadScope {
  cwd?: never;
  environmentId?: never;
  hostId?: never;
  kind: "thread";
  threadId: string;
}

export interface TerminalEnvironmentScope {
  environmentId: string;
  cwd?: never;
  hostId?: never;
  kind: "environment";
  threadId?: never;
}

export interface TerminalHostPathListScope {
  cwd?: string;
  environmentId?: never;
  hostId: string;
  kind: "host_path";
  threadId?: never;
}

export interface TerminalHostPathCreateScope {
  cwd: string | null;
  environmentId?: never;
  hostId: string;
  kind: "host_path";
  threadId?: never;
}

export type TerminalListScope =
  | TerminalThreadScope
  | TerminalEnvironmentScope
  | TerminalHostPathListScope;

export type TerminalCreateScope =
  | TerminalThreadScope
  | TerminalEnvironmentScope
  | TerminalHostPathCreateScope;

export interface TerminalListArgs {
  signal?: AbortSignal;
  scope: TerminalListScope;
}

export interface TerminalCreateArgs {
  cols: number;
  cwd?: string;
  rows: number;
  scope: TerminalCreateScope;
  start?: CreateTerminalRequest["start"];
  title?: string;
}

export interface TerminalTargetArgs {
  terminalId: string;
}

export interface TerminalGetArgs extends TerminalTargetArgs {
  signal?: AbortSignal;
}

export interface TerminalRenameArgs extends TerminalTargetArgs {
  title: UpdateTerminalRequest["title"];
}

export interface TerminalCloseArgs extends TerminalTargetArgs {
  mode: "force" | "if-clean";
}

export interface TerminalInputArgs extends TerminalTargetArgs {
  dataBase64: TerminalInputRequest["dataBase64"];
}

export interface TerminalResizeArgs extends TerminalTargetArgs {
  cols: TerminalResizeRequest["cols"];
  rows: TerminalResizeRequest["rows"];
}

export interface TerminalOutputArgs extends TerminalTargetArgs {
  lines?: TerminalOutputQuery["lines"];
  limitChunks?: TerminalOutputQuery["limitChunks"];
  signal?: AbortSignal;
  sinceSeq?: TerminalOutputQuery["sinceSeq"];
  tailBytes?: TerminalOutputQuery["tailBytes"];
}

export interface TerminalNotifyArgs
  extends TerminalTargetArgs, TerminalNotifyRequest {}

export type TerminalRestartArgs = TerminalTargetArgs;

export type TerminalListResult = TerminalListResponse;
export type TerminalCreateResult = TerminalSession;
export type TerminalGetResult = TerminalSession;
export type TerminalRenameResult = TerminalSession;
export type TerminalCloseResult = TerminalSession;
export type TerminalInputResult = TerminalSession;
export type TerminalResizeResult = TerminalSession;
export type TerminalOutputResult = TerminalOutputResponse;
export type TerminalRestartResult = TerminalSession;

export interface ExperimentalTerminalAttentionArea {
  clear(args: TerminalTargetArgs): Promise<TerminalGetResult>;
  list(): Promise<TerminalAttentionListResponse["sessions"]>;
  next(): Promise<TerminalGetResult | null>;
}

export interface TerminalsArea {
  experimental_attention: ExperimentalTerminalAttentionArea;
  close(args: TerminalCloseArgs): Promise<TerminalCloseResult>;
  create(args: TerminalCreateArgs): Promise<TerminalCreateResult>;
  get(args: TerminalGetArgs): Promise<TerminalGetResult>;
  input(args: TerminalInputArgs): Promise<TerminalInputResult>;
  list(args: TerminalListArgs): Promise<TerminalListResult>;
  output(args: TerminalOutputArgs): Promise<TerminalOutputResult>;
  notify(args: TerminalNotifyArgs): Promise<TerminalGetResult>;
  experimental_follow(
    args: TerminalOutputArgs & { pollIntervalMs?: number },
  ): AsyncGenerator<Uint8Array>;
  rename(args: TerminalRenameArgs): Promise<TerminalRenameResult>;
  restart(args: TerminalRestartArgs): Promise<TerminalRestartResult>;
  resize(args: TerminalResizeArgs): Promise<TerminalResizeResult>;
}

function assertUnambiguousScope(
  scope: TerminalListScope | TerminalCreateScope,
): void {
  switch (scope.kind) {
    case "thread":
      if ("environmentId" in scope || "hostId" in scope || "cwd" in scope) {
        throw new Error(
          "Thread terminal scope cannot include environment or host selectors.",
        );
      }
      return;
    case "environment":
      if ("threadId" in scope || "hostId" in scope || "cwd" in scope) {
        throw new Error(
          "Environment terminal scope cannot include thread or host selectors.",
        );
      }
      return;
    case "host_path":
      if ("threadId" in scope || "environmentId" in scope) {
        throw new Error(
          "Host terminal scope cannot include thread or environment selectors.",
        );
      }
  }
}

function terminalListQuery(scope: TerminalListScope): TerminalListQuery {
  assertUnambiguousScope(scope);
  switch (scope.kind) {
    case "thread":
      return { threadId: scope.threadId };
    case "environment":
      return { environmentId: scope.environmentId };
    case "host_path":
      return {
        hostId: scope.hostId,
        ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
      };
  }
}

function terminalCreateTarget(
  scope: TerminalCreateScope,
): CreateTerminalRequest["target"] {
  assertUnambiguousScope(scope);
  switch (scope.kind) {
    case "thread":
      return { kind: "thread", threadId: scope.threadId };
    case "environment":
      return { kind: "environment", environmentId: scope.environmentId };
    case "host_path":
      return {
        kind: "host_path",
        hostId: scope.hostId,
        cwd: scope.cwd,
      };
  }
}

function terminalOutputQuery(args: TerminalOutputArgs): TerminalOutputQuery {
  return {
    ...(args.lines === undefined ? {} : { lines: args.lines }),
    ...(args.sinceSeq === undefined ? {} : { sinceSeq: args.sinceSeq }),
    ...(args.tailBytes === undefined ? {} : { tailBytes: args.tailBytes }),
    ...(args.limitChunks === undefined
      ? {}
      : { limitChunks: args.limitChunks }),
  };
}

export function createTerminalsArea(args: CreateSdkAreaArgs): TerminalsArea {
  const { transport } = args;

  const get = (input: TerminalGetArgs): Promise<TerminalGetResult> =>
    transport.readJson(
      transport.api.v1.terminals[":terminalId"].$get(
        {
          param: { terminalId: input.terminalId },
        },
        ...signalRequestArgs(input.signal),
      ),
    );

  const listAttention = async (): Promise<
    TerminalAttentionListResponse["sessions"]
  > => {
    const response: TerminalAttentionListResponse = await transport.readJson(
      transport.api.v1.terminals.attention.$get({}),
    );
    return response.sessions
      .filter(
        (session) =>
          session.attention !== null && session.attention !== undefined,
      )
      .sort(
        (left, right) =>
          (left.attention?.at ?? 0) - (right.attention?.at ?? 0) ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
  };

  const create = (input: TerminalCreateArgs): Promise<TerminalCreateResult> =>
    transport.readJson(
      transport.api.v1.terminals.$post({
        json: {
          cols: input.cols,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          rows: input.rows,
          start: input.start,
          target: terminalCreateTarget(input.scope),
          title: input.title,
        },
      }),
    );

  return {
    experimental_attention: {
      async clear(input) {
        return transport.readJson(
          transport.api.v1.terminals[":terminalId"].attention.clear.$post({
            param: { terminalId: input.terminalId },
          }),
        );
      },
      list: listAttention,
      async next() {
        return (await listAttention())[0] ?? null;
      },
    },
    async close(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].close.$post({
          param: { terminalId: input.terminalId },
          json: { mode: input.mode, reason: "user" },
        }),
      );
    },
    create,
    get,
    async input(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].input.$post({
          param: { terminalId: input.terminalId },
          json: { dataBase64: input.dataBase64 },
        }),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.terminals.$get(
          {
            query: terminalListQuery(input.scope),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async output(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].output.$get(
          {
            param: { terminalId: input.terminalId },
            query: terminalOutputQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async notify(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].notify.$post({
          param: { terminalId: input.terminalId },
          json: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        }),
      );
    },
    async *experimental_follow(input) {
      let sinceSeq = input.sinceSeq ?? 0;
      let first = true;
      while (!input.signal?.aborted) {
        const output = await transport.readJson(
          transport.api.v1.terminals[":terminalId"].output.$get(
            {
              param: { terminalId: input.terminalId },
              query: terminalOutputQuery({
                ...input,
                ...(first ? {} : { lines: undefined, sinceSeq }),
              }),
            },
            ...signalRequestArgs(input.signal),
          ),
        );
        first = false;
        for (const chunk of output.chunks) {
          yield Uint8Array.from(atob(chunk.dataBase64), (character) =>
            character.charCodeAt(0),
          );
        }
        sinceSeq = output.nextSeq;
        if (output.status === "exited") return;
        await new Promise((resolve) =>
          setTimeout(resolve, input.pollIntervalMs ?? 250),
        );
      }
    },
    async rename(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].$patch({
          param: { terminalId: input.terminalId },
          json: { title: input.title },
        }),
      );
    },
    async restart(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].restart.$post({
          param: { terminalId: input.terminalId },
          json: {},
        }),
      );
    },
    async resize(input) {
      return transport.readJson(
        transport.api.v1.terminals[":terminalId"].resize.$post({
          param: { terminalId: input.terminalId },
          json: { cols: input.cols, rows: input.rows },
        }),
      );
    },
  };
}
