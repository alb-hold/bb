import { describe, expect, it } from "vitest";
import { TerminalOutputSequenceRebase } from "./terminal-output-sequence-rebase.js";

describe("terminal output sequence rebase", () => {
  it("maps replay and live sequences after retained output without collisions", () => {
    const rebase = new TerminalOutputSequenceRebase();
    rebase.setBase("term_1", 7);

    const replay = rebase.replayToServer({
      type: "terminal.replay",
      requestId: "request_1",
      terminalId: "term_1",
      replayStartSeq: 0,
      nextSeq: 2,
      chunks: [
        { seq: 0, dataBase64: "YQ==" },
        { seq: 1, dataBase64: "Yg==" },
      ],
    });

    expect(replay.replayStartSeq).toBe(7);
    expect(replay.nextSeq).toBe(9);
    expect(replay.chunks.map(({ seq }) => seq)).toEqual([7, 8]);
    expect(rebase.toServer("term_1", 2)).toBe(9);
    expect(rebase.toDaemon("term_1", 9)).toBe(2);
    expect(rebase.toDaemon("term_1", 6)).toBe(0);
  });
});
