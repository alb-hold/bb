import type { ComponentProps } from "react";
import type { TerminalSession } from "@bb/server-contract";

interface TerminalAttentionPaneProps extends ComponentProps<"div"> {
  attention: TerminalSession["attention"];
}

export function TerminalAttentionPane({
  attention,
  className,
  ...props
}: TerminalAttentionPaneProps) {
  return (
    <div
      {...props}
      className={`${className ?? ""} ${attention ? "ring-2 ring-inset ring-attention" : ""}`}
    />
  );
}
