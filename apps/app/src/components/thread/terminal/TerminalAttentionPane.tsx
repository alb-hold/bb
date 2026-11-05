import type { ComponentProps } from "react";
import type { TerminalSession } from "@bb/server-contract";

interface TerminalAttentionPaneProps extends ComponentProps<"div"> {
  attention: TerminalSession["attention"];
  bannerOnly?: boolean;
}

export function TerminalAttentionPane({
  attention,
  bannerOnly = false,
  className,
  ...props
}: TerminalAttentionPaneProps) {
  return (
    <div
      {...props}
      className={`${className ?? ""} ${attention && !bannerOnly ? "ring-2 ring-inset ring-attention" : ""}`}
    />
  );
}
