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
    expect(output.takeBatch(8192)).toEqual([]);
    expect(output.take()).toBeNull();
    expect(output.take()).toEqual([]);
  },
);

it("drains a bounded prefix while preserving sequence validation and the adoption tail", () => {
  const output = createTerminalHiddenOutput();
  for (let seq = 0; seq < 100; seq++)
    output.push({ seq, dataBase64: "YQ==" }, 0);
  const batch = output.takeBatch(720);
  expect(batch.map((chunk) => chunk.seq)).toEqual(
    Array.from({ length: 10 }, (_, index) => index),
  );
  output.push({ seq: 100, dataBase64: "YQ==" }, 10);
  expect(output.take()?.map((chunk) => chunk.seq)).toEqual(
    Array.from({ length: 91 }, (_, index) => index + 10),
  );
});
