import { expect, it } from "vitest";
import { createTerminalHiddenOutput } from "./terminal-hidden-output";

it("keeps hidden chunks in sequence without retaining duplicates after draining", () => {
  const output = createTerminalHiddenOutput();
  output.push({ seq: 7, dataBase64: "YQ==" }, 7);
  output.push({ seq: 7, dataBase64: "YQ==" }, 7);
  output.push({ seq: 8, dataBase64: "Yg==" }, 7);
  expect(output.take()?.map((chunk) => chunk.seq)).toEqual([7, 8]);
  expect(output.take()).toEqual([]);
  output.push({ seq: 9, dataBase64: "Yw==" }, 9);
  expect(output.take()?.map((chunk) => chunk.seq)).toEqual([9]);
});

it.each(["gap", "overflow"])(
  "requires one replay after a hidden %s",
  (reason) => {
    const output = createTerminalHiddenOutput();
    output.push({ seq: 7, dataBase64: "YQ==" }, 7);
    output.push(
      {
        seq: reason === "gap" ? 9 : 8,
        dataBase64: reason === "gap" ? "Yw==" : "A".repeat(2 * 1024 * 1024),
      },
      7,
    );
    output.push({ seq: 10, dataBase64: "ZA==" }, 7);
    expect(output.take()).toBeNull();
    expect(output.take()).toEqual([]);
  },
);
