import {
  terminalColorReply,
  type TerminalDefaultColors,
} from "./terminal-default-colors.js";

const queries = [
  "\x1b]10;?\x07",
  "\x1b]10;?\x1b\\",
  "\x1b]11;?\x07",
  "\x1b]11;?\x1b\\",
];

export class TerminalColorQueries {
  private pending = "";
  private passthroughOsc = false;

  constructor(private readonly colors: TerminalDefaultColors) {}

  push(chunk: string, reply: (data: string) => void): string {
    if (
      !this.pending &&
      !this.passthroughOsc &&
      (!chunk.includes("]") || !chunk.includes("\x1b]"))
    ) {
      if (!chunk.endsWith("\x1b")) return chunk;
      this.pending = "\x1b";
      return chunk.slice(0, -1);
    }
    const data = this.pending + chunk;
    this.pending = "";
    const output: string[] = [];
    let at = 0;
    while (at < data.length) {
      if (this.passthroughOsc) {
        const bell = data.indexOf("\x07", at);
        const escape = data.indexOf("\x1b", at);
        const end =
          bell < 0 ? escape : escape < 0 ? bell : Math.min(bell, escape);
        if (end < 0) {
          output.push(data.slice(at));
          break;
        }
        output.push(data.slice(at, end));
        this.passthroughOsc = false;
        if (end === bell) {
          output.push("\x07");
          at = end + 1;
        } else at = end;
        continue;
      }
      const start = data.indexOf("\x1b]", at);
      if (start < 0) {
        if (data.endsWith("\x1b")) {
          this.pending = "\x1b";
          output.push(data.slice(at, -1));
        } else output.push(data.slice(at));
        break;
      }
      output.push(data.slice(at, start));
      const query = queries.find((candidate) =>
        data.startsWith(candidate, start),
      );
      if (query) {
        const slot = query.startsWith("\x1b]10;") ? 10 : 11;
        reply(
          terminalColorReply(
            slot,
            slot === 10 ? this.colors.foreground : this.colors.background,
            "\x1b\\",
          ),
        );
        at = start + query.length;
      } else {
        const tail = data.slice(start, start + 8);
        if (queries.some((candidate) => candidate.startsWith(tail))) {
          this.pending = tail;
          break;
        }
        output.push("\x1b]");
        this.passthroughOsc = true;
        at = start + 2;
      }
    }
    return output.join("");
  }

  flush(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }
}
