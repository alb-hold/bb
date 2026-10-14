import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminalCommandGutter } from "./TerminalCommandGutter";

describe("TerminalCommandGutter", () => {
  it("marks visible completed commands with success and failure theme tokens", () => {
    const { getByLabelText } = render(
      <TerminalCommandGutter
        commandMarks={[
          { line: 3, exitCode: 0 },
          { line: 5, exitCode: 2 },
          { line: 20, exitCode: 0 },
          { line: 6, exitCode: null },
        ]}
        lineHeight={16}
        rows={10}
        viewportLine={2}
      />,
    );
    expect(
      getByLabelText("Command succeeded").classList.contains("bg-success"),
    ).toBe(true);
    expect(
      getByLabelText("Command failed with exit code 2").classList.contains(
        "bg-destructive",
      ),
    ).toBe(true);
  });
});
