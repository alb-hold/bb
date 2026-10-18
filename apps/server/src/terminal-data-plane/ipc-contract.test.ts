import { describe, expect, it } from "vitest";
import {
  parseTerminalDataPlaneChildToMainMessage,
  parseTerminalDataPlaneMainToChildMessage,
  TERMINAL_DATA_PLANE_IPC_VERSION,
  TerminalDataPlaneIpcError,
  terminalDataPlaneChildMessageSchema,
  terminalDataPlaneMainMessageSchema,
} from "./ipc-contract.js";

const v = TERMINAL_DATA_PLANE_IPC_VERSION;
const request = {
  url: "/ws/terminals/term_from_url",
  headers: [["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="]],
  headBase64: "",
};

describe("terminal data plane IPC contract", () => {
  it("binds a handed-over browser socket to ids chosen by main", () => {
    const parsed = terminalDataPlaneMainMessageSchema.parse({
      v,
      type: "browser.attach",
      attachId: "attach_1",
      terminalId: "term_authorized",
      daemonSessionId: "session_1",
      outputAcks: true,
      sinceSeq: null,
      request,
    });

    expect(parsed).toMatchObject({
      terminalId: "term_authorized",
      daemonSessionId: "session_1",
    });
    expect(
      terminalDataPlaneMainMessageSchema.safeParse({
        v,
        type: "browser.attach",
        attachId: "attach_1",
        outputAcks: true,
        sinceSeq: null,
        request,
      }).success,
    ).toBe(false);
  });

  it("rejects messages from another contract version in both directions", () => {
    expect(
      terminalDataPlaneMainMessageSchema.safeParse({ v: v + 1, type: "shutdown" })
        .success,
    ).toBe(false);
    expect(
      terminalDataPlaneChildMessageSchema.safeParse({
        v: v + 1,
        type: "ready",
        pid: 1,
      }).success,
    ).toBe(false);
  });

  it("lets only resize frames cross to main as browser control", () => {
    const control = (message: unknown) =>
      terminalDataPlaneChildMessageSchema.safeParse({
        v,
        type: "browser.control",
        attachId: "attach_1",
        terminalId: "term_1",
        message,
      }).success;

    expect(control({ type: "resize", cols: 80, rows: 24 })).toBe(true);
    expect(control({ type: "input", dataBase64: "YQ==" })).toBe(false);
    expect(control({ type: "ping" })).toBe(false);
  });

  it("lets main send only control frames to a terminal's browser sockets", () => {
    const send = (message: unknown) =>
      terminalDataPlaneMainMessageSchema.safeParse({
        v,
        type: "browser.send",
        terminalId: "term_1",
        message,
      }).success;

    expect(
      send({ type: "error", code: "terminal_closed", message: "closed" }),
    ).toBe(true);
    expect(send({ type: "output", chunk: { seq: 1, dataBase64: "YQ==" } })).toBe(
      false,
    );
    expect(send({ type: "pong" })).toBe(false);
  });

  it("binds relayed terminal input to the attach that received it", () => {
    const input = {
      v,
      type: "terminal.input",
      terminalId: "term_1",
      dataBase64: "YQ==",
    };
    expect(terminalDataPlaneChildMessageSchema.safeParse(input).success).toBe(
      false,
    );
    expect(
      terminalDataPlaneChildMessageSchema.safeParse({
        ...input,
        attachId: "attach_1",
      }).success,
    ).toBe(true);
  });

  it("rejects fields outside the contract", () => {
    expect(
      terminalDataPlaneChildMessageSchema.safeParse({
        v,
        type: "terminal.input",
        attachId: "attach_1",
        terminalId: "term_1",
        dataBase64: "YQ==",
        daemonSessionId: "session_chosen_by_child",
      }).success,
    ).toBe(false);
  });

  const rejection = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof TerminalDataPlaneIpcError) {
        return `${error.direction}:${error.rejection}`;
      }
      throw error;
    }
    return "accepted";
  };
  const resync = {
    v,
    type: "browser.resync",
    attachId: "attach_1",
    terminalId: "term_1",
    fromSeq: 7,
  };
  const replay = {
    v,
    type: "terminal.resync",
    terminalId: "term_1",
  };

  it("accepts a replay gap request only from the child", () => {
    expect(parseTerminalDataPlaneChildToMainMessage(resync)).toEqual(resync);
    expect(
      rejection(() => parseTerminalDataPlaneMainToChildMessage(resync)),
    ).toBe("main-to-child:wrong-direction");
  });

  it("accepts a terminal resync order only from main", () => {
    expect(parseTerminalDataPlaneMainToChildMessage(replay)).toEqual(replay);
    expect(
      rejection(() => parseTerminalDataPlaneChildToMainMessage(replay)),
    ).toBe("child-to-main:wrong-direction");
  });

  it("rejects malformed and other-version messages with a typed error", () => {
    expect(
      rejection(() =>
        parseTerminalDataPlaneChildToMainMessage({ ...resync, fromSeq: -1 }),
      ),
    ).toBe("child-to-main:malformed");
    expect(
      rejection(() => parseTerminalDataPlaneChildToMainMessage("resync")),
    ).toBe("child-to-main:malformed");
    expect(
      rejection(() =>
        parseTerminalDataPlaneMainToChildMessage({ ...replay, v: v + 1 }),
      ),
    ).toBe("main-to-child:unsupported-version");
    expect(
      rejection(() =>
        parseTerminalDataPlaneMainToChildMessage({ type: "shutdown" }),
      ),
    ).toBe("main-to-child:malformed");
  });

  it("reports the last acknowledged sequence when a browser socket closes", () => {
    const detached = {
      v,
      type: "browser.detached",
      attachId: "attach_1",
      terminalId: "term_1",
    };

    expect(
      parseTerminalDataPlaneChildToMainMessage({
        ...detached,
        lastAckedSeq: 41,
      }),
    ).toMatchObject({ lastAckedSeq: 41 });
    expect(
      parseTerminalDataPlaneChildToMainMessage({
        ...detached,
        lastAckedSeq: null,
      }),
    ).toMatchObject({ lastAckedSeq: null });
    expect(
      rejection(() =>
        parseTerminalDataPlaneChildToMainMessage({ ...detached, nextSeq: 41 }),
      ),
    ).toBe("child-to-main:malformed");
  });

  it("closes browser sockets by one attach or by one terminal, never both", () => {
    const close = (target: unknown) =>
      rejection(() =>
        parseTerminalDataPlaneMainToChildMessage({
          v,
          type: "browser.close",
          target,
          code: 1013,
          reason: "overloaded",
        }),
      );

    expect(close({ kind: "attach", attachId: "attach_1" })).toBe("accepted");
    expect(close({ kind: "terminal", terminalId: "term_1" })).toBe("accepted");
    expect(
      close({ kind: "attach", attachId: "attach_1", terminalId: "term_1" }),
    ).toBe("main-to-child:malformed");
    expect(close({})).toBe("main-to-child:malformed");
  });
});
