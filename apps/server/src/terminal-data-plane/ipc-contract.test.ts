import { describe, expect, it } from "vitest";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
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

  it("rejects fields outside the contract", () => {
    expect(
      terminalDataPlaneChildMessageSchema.safeParse({
        v,
        type: "terminal.input",
        terminalId: "term_1",
        dataBase64: "YQ==",
        daemonSessionId: "session_chosen_by_child",
      }).success,
    ).toBe(false);
  });
});
