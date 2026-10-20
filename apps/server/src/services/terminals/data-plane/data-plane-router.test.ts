import type { Socket } from "node:net";
import type { TerminalSession } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
  type TerminalDataPlaneMainMessage,
} from "../../../terminal-data-plane/ipc-contract.js";
import type { ChildTerminalSocket } from "./child-terminal-socket.js";
import {
  TerminalDataPlaneRouter,
  type DataPlaneLifecyclePort,
} from "./data-plane-router.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;

const session: TerminalSession = {
  id: "term_1",
  threadId: "thr_1",
  environmentId: "env_1",
  hostId: "host_1",
  title: "Terminal 1",
  initialCwd: "/tmp",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
  lastUserInputAt: null,
};

function chunk(seq: number) {
  return { seq, dataBase64: "AA==" };
}

function createFixture() {
  const sent: Array<{
    message: TerminalDataPlaneMainMessage;
    handle: Socket | undefined;
  }> = [];
  const transport = {
    isReady: true,
    pendingIpcBytes: 0,
    send: vi.fn(
      (
        message: TerminalDataPlaneMainMessage,
        options?: { handle?: Socket },
      ) => {
        sent.push({ message, handle: options?.handle });
        return true;
      },
    ),
  };
  const attached: ChildTerminalSocket[] = [];
  const lifecycle: DataPlaneLifecyclePort = {
    attach: vi.fn((args) => {
      attached.push(args.socket);
      args.socket.send(
        JSON.stringify({
          type: "attached",
          session,
          replayStartSeq: 0,
          nextSeq: 2,
        }),
      );
      args.socket.send(JSON.stringify({ type: "output", chunk: chunk(0) }));
      args.socket.send(JSON.stringify({ type: "output", chunk: chunk(1) }));
    }),
    detach: vi.fn(),
    handleMessage: vi.fn(),
    recordInputActivity: vi.fn(),
    recordOutputBatch: vi.fn(),
  };
  const onTerminalExited = vi.fn();
  const router = new TerminalDataPlaneRouter(
    transport,
    lifecycle,
    onTerminalExited,
  );
  const request = { url: "/ws/terminals/term_1", headers: [], headBase64: "" };
  const attach = (
    terminalId = "term_1",
    handoffOwnerToken?: string,
  ) => {
    const raw = {} as Socket;
    const attachId = router.attachBrowser({
      daemonSessionId: "ds_1",
      handoffOwnerToken,
      outputAcks: true,
      resizeAcks: false,
      request,
      sinceSeq: 0,
      socket: raw,
      terminalId,
    });
    if (attachId === null) {
      throw new Error("attach was refused");
    }
    router.handleChildMessage({ v: V, type: "browser.attached", attachId });
    return { attachId, raw };
  };
  const types = () => sent.map((entry) => entry.message.type);
  return {
    attach,
    attached,
    lifecycle,
    onTerminalExited,
    router,
    sent,
    transport,
    types,
  };
}

describe("TerminalDataPlaneRouter", () => {
  it("keeps the app owner token on the server side of the daemon data-plane boundary", () => {
    const fixture = createFixture();
    const token = "0123456789abcdefghij_-";
    const { attachId } = fixture.attach("term_1", token);

    expect(fixture.sent[0]?.message).not.toHaveProperty("handoffOwnerToken");
    expect(fixture.sent[0]?.message).toMatchObject({
      type: "browser.attach",
      request: { url: "/ws/terminals/term_1", headers: [], headBase64: "" },
    });
    expect(fixture.lifecycle.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffOwnerToken: token,
        socket: fixture.attached[0],
        terminalId: "term_1",
      }),
    );

    fixture.router.handleChildMessage({
      v: V,
      type: "browser.resync",
      attachId,
      terminalId: "term_1",
      fromSeq: 1,
    });
    expect(fixture.lifecycle.attach).toHaveBeenLastCalledWith(
      expect.objectContaining({ handoffOwnerToken: token }),
    );
  });

  it("hands the raw socket to the child and refuses when the child is not ready", () => {
    const fixture = createFixture();
    const { attachId, raw } = fixture.attach();
    expect(fixture.sent[0]?.message).toMatchObject({
      type: "browser.attach",
      attachId,
      terminalId: "term_1",
      daemonSessionId: "ds_1",
    });
    expect(fixture.sent[0]?.handle).toBe(raw);
    fixture.transport.isReady = false;
    expect(
      fixture.router.attachBrowser({
        daemonSessionId: "ds_1",
        outputAcks: false,
        resizeAcks: false,
        request: fixture.sent[0]?.message.type === "browser.attach"
          ? fixture.sent[0].message.request
          : { url: "", headers: [], headBase64: "" },
        sinceSeq: 0,
        socket: raw,
        terminalId: "term_1",
      }),
    ).toBeNull();
  });

  it("turns the lifecycle's attached and replayed output into one browser.replay", async () => {
    const fixture = createFixture();
    const { attachId } = fixture.attach();
    expect(fixture.types()).toEqual(["browser.attach"]);
    await Promise.resolve();
    const replay = fixture.sent[1]?.message;
    expect(replay).toMatchObject({
      type: "browser.replay",
      attachId,
      terminalId: "term_1",
      replayStartSeq: 0,
      nextSeq: 2,
    });
    expect(replay?.type === "browser.replay" ? replay.chunks.length : 0).toBe(
      2,
    );
  });

  it("sends session updates after the replay and only once for several browsers", async () => {
    const fixture = createFixture();
    fixture.attach();
    fixture.attach();
    await Promise.resolve();
    const updated = JSON.stringify({ type: "session-updated", session });
    for (const socket of fixture.attached) {
      socket.send(updated);
    }
    const updates = fixture.sent.filter(
      (entry) => entry.message.type === "browser.send",
    );
    expect(updates).toHaveLength(1);
  });

  it("sends resize acknowledgements to the one browser they name, after the session update that caused them", async () => {
    const fixture = createFixture();
    const first = fixture.attach();
    fixture.attach();
    await Promise.resolve();
    const sockets = fixture.attached;
    sockets[0]?.send(
      JSON.stringify({ type: "session-updated", session }),
    );
    sockets[0]?.send(JSON.stringify({ type: "resize-applied", seq: 3 }));
    sockets[0]?.send(JSON.stringify({ type: "features", resizeAcks: true }));

    const afterReplay = fixture.sent
      .map((entry) => entry.message)
      .filter(
        (message) =>
          message.type === "browser.send" || message.type === "browser.reply",
      );
    expect(afterReplay.map((message) => message.type)).toEqual([
      "browser.send",
      "browser.reply",
      "browser.reply",
    ]);
    expect(afterReplay[1]).toMatchObject({
      attachId: first.attachId,
      message: { type: "resize-applied", seq: 3 },
    });
    expect(afterReplay[2]).toMatchObject({
      attachId: first.attachId,
      message: { type: "features", resizeAcks: true },
    });
  });

  it("relays live output once per sequence number across browsers on one terminal", async () => {
    const fixture = createFixture();
    fixture.attach();
    fixture.attach();
    await Promise.resolve();
    for (const socket of fixture.attached) {
      socket.send(JSON.stringify({ type: "output", chunk: chunk(2) }));
    }
    for (const socket of fixture.attached) {
      socket.send(JSON.stringify({ type: "output", chunk: chunk(3) }));
    }
    const relayed = fixture.sent
      .map((entry) => entry.message)
      .filter((message) => message.type === "terminal.output");
    expect(
      relayed.map((message) =>
        message.type === "terminal.output" ? message.chunk.seq : -1,
      ),
    ).toEqual([2, 3]);
  });

  it("routes acks and controls only to the socket they name", () => {
    const fixture = createFixture();
    const first = fixture.attach();
    const second = fixture.attach();
    fixture.router.handleChildMessage({
      v: V,
      type: "terminal.ack",
      attachId: second.attachId,
      terminalId: "term_1",
      nextSeq: 9,
    });
    fixture.router.handleChildMessage({
      v: V,
      type: "terminal.ack",
      attachId: "unknown",
      terminalId: "term_1",
      nextSeq: 9,
    });
    expect(fixture.lifecycle.handleMessage).toHaveBeenCalledTimes(1);
    expect(fixture.lifecycle.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { type: "ack", nextSeq: 9 },
        socket: fixture.attached[1],
        terminalId: "term_1",
      }),
    );
    expect(first.attachId).not.toBe(second.attachId);
  });

  it("uses the attach's own terminal id, never one the child reports", () => {
    const fixture = createFixture();
    const { attachId } = fixture.attach("term_1");
    fixture.router.handleChildMessage({
      v: V,
      type: "browser.control",
      attachId,
      terminalId: "term_other",
      message: { type: "resize", cols: 80, rows: 24 },
    });
    expect(fixture.lifecycle.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "term_1" }),
    );
  });

  it("delivers input only to the attach that named itself and only for its own terminal", () => {
    const fixture = createFixture();
    const first = fixture.attach("term_1");
    const other = fixture.attach("term_2");
    const input = (attachId: string, terminalId: string) =>
      fixture.router.handleChildMessage({
        v: V,
        type: "terminal.input",
        attachId,
        terminalId,
        dataBase64: "YQ==",
      });

    input(other.attachId, "term_1");
    input("unknown", "term_1");
    input(first.attachId, "term_2");
    expect(fixture.lifecycle.handleMessage).not.toHaveBeenCalled();

    input(first.attachId, "term_1");
    expect(fixture.lifecycle.handleMessage).toHaveBeenCalledTimes(1);
    expect(fixture.lifecycle.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { type: "input", dataBase64: "YQ==" },
        socket: fixture.attached[0],
        terminalId: "term_1",
      }),
    );
  });

  it("tells the owner when a terminal exits, even when another browser's identical broadcast is dropped", async () => {
    const fixture = createFixture();
    fixture.attach();
    fixture.attach();
    await Promise.resolve();
    const exited = JSON.stringify({ type: "exited", session });
    fixture.attached[0]?.send(exited);
    fixture.attached[1]?.send(exited);
    expect(fixture.onTerminalExited).toHaveBeenCalledTimes(2);
    expect(fixture.onTerminalExited).toHaveBeenCalledWith("term_1");
    expect(
      fixture.sent.filter(
        (entry) =>
          entry.message.type === "browser.send" &&
          entry.message.message.type === "exited",
      ),
    ).toHaveLength(1);
  });

  it("detaches the lifecycle socket when the child reports the browser gone", () => {
    const fixture = createFixture();
    const { attachId } = fixture.attach();
    fixture.router.handleChildMessage({
      v: V,
      type: "browser.detached",
      attachId,
      terminalId: "term_1",
      lastAckedSeq: null,
    });
    expect(fixture.lifecycle.detach).toHaveBeenCalledWith({
      socket: fixture.attached[0],
      terminalId: "term_1",
    });
    expect(fixture.router.attachedSocketCount).toBe(0);
    expect(fixture.router.hasBrowsers("term_1")).toBe(false);
  });

  it("detaches every browser from the lifecycle when the child goes down", () => {
    const fixture = createFixture();
    fixture.attach();
    fixture.attach("term_2");
    fixture.router.handleChildDown();
    expect(fixture.lifecycle.detach).toHaveBeenCalledTimes(2);
    expect(fixture.router.attachedSocketCount).toBe(0);
  });

  it("re-attaches a socket at fromSeq when the child asks for a resync", () => {
    const fixture = createFixture();
    const { attachId } = fixture.attach();
    fixture.router.handleChildMessage({
      v: V,
      type: "browser.resync",
      attachId,
      terminalId: "term_1",
      fromSeq: 7,
    });
    expect(fixture.lifecycle.detach).toHaveBeenCalledTimes(1);
    expect(fixture.lifecycle.attach).toHaveBeenLastCalledWith(
      expect.objectContaining({ sinceSeq: 7, terminalId: "term_1" }),
    );
  });

  it("stops relaying and asks the child to resync once the IPC cap is exceeded", async () => {
    const fixture = createFixture();
    fixture.attach();
    await Promise.resolve();
    fixture.transport.pendingIpcBytes =
      TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES;
    fixture.attached[0]?.send(
      JSON.stringify({ type: "output", chunk: chunk(2) }),
    );
    fixture.attached[0]?.send(
      JSON.stringify({ type: "output", chunk: chunk(3) }),
    );
    expect(
      fixture.sent.filter((entry) => entry.message.type === "terminal.resync"),
    ).toHaveLength(1);
    expect(
      fixture.sent.filter((entry) => entry.message.type === "terminal.output"),
    ).toHaveLength(0);
  });
});
