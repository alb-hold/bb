import { terminalColorReply, type TerminalDefaultColors } from "@bb/domain";

const queries = [
  "\x1b]10;?\x07",
  "\x1b]10;?\x1b\\",
  "\x1b]11;?\x07",
  "\x1b]11;?\x1b\\",
];

export class TerminalColorQueries {
  private pending = "";
  private passthroughOsc = false;
  private escaped = false;

  constructor(private readonly colors: TerminalDefaultColors) {}

  push(data: string, reply: (data: string) => void): string {
    if (!this.pending && !this.passthroughOsc && !data.includes("\x1b"))
      return data;
    let output = "";
    for (const char of data) {
      if (this.passthroughOsc) {
        output += char;
        if (char === "\x07" || (this.escaped && char === "\\"))
          this.passthroughOsc = false;
        this.escaped = char === "\x1b";
        continue;
      }
      if (!this.pending && char !== "\x1b") {
        output += char;
        continue;
      }
      this.pending += char;
      if (queries.includes(this.pending)) {
        const slot = this.pending.startsWith("\x1b]10;") ? 10 : 11;
        reply(
          terminalColorReply(
            slot,
            slot === 10 ? this.colors.foreground : this.colors.background,
            "\x1b\\",
          ),
        );
        this.pending = "";
      } else if (!queries.some((query) => query.startsWith(this.pending))) {
        this.passthroughOsc =
          this.pending.startsWith("\x1b]") &&
          char !== "\x07" &&
          !this.pending.endsWith("\x1b\\");
        this.escaped = char === "\x1b";
        output += this.pending;
        this.pending = "";
      }
    }
    return output;
  }

  flush(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }
}
