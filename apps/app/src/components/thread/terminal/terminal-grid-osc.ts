import {
  parseTerminalGridMarker,
  TERMINAL_GRID_OSC_IDENTIFIER,
} from "@bb/domain";

export function registerTerminalGridOscHandler(
  terminal: {
    parser: {
      registerOscHandler(
        identifier: number,
        callback: (payload: string) => boolean | Promise<boolean>,
      ): { dispose(): void };
    };
  },
  onGrid: () => void,
): { dispose(): void } {
  return terminal.parser.registerOscHandler(
    TERMINAL_GRID_OSC_IDENTIFIER,
    (payload) => {
      const grid = parseTerminalGridMarker(payload);
      if (grid === null) return false;
      onGrid();
      return true;
    },
  );
}
