import { expect, it, vi } from "vitest";
import { warmNativeTerminal } from "./native-terminal-warmup";
import { preloadNativeTerminalPanel } from "./native-terminal-panel-preload";
import { preloadTerminalModules } from "./terminal-modules";
import { prefetchTerminalScreen } from "./terminal-screen-prefetch";

vi.mock("./native-terminal-panel-preload", () => ({
  preloadNativeTerminalPanel: vi.fn(() => new Promise(() => {})),
}));
vi.mock("./terminal-modules", () => ({ preloadTerminalModules: vi.fn() }));
vi.mock("./terminal-screen-prefetch", () => ({
  prefetchTerminalScreen: vi.fn(),
}));

it("starts snapshot and xterm warmup without waiting for the panel download", () => {
  expect(prefetchTerminalScreen).not.toHaveBeenCalled();
  expect(preloadNativeTerminalPanel).not.toHaveBeenCalled();
  expect(preloadTerminalModules).not.toHaveBeenCalled();
  warmNativeTerminal("terminal", "thread");
  expect(prefetchTerminalScreen).toHaveBeenCalledWith("terminal", "thread");
  expect(preloadNativeTerminalPanel).toHaveBeenCalledOnce();
  expect(preloadTerminalModules).toHaveBeenCalledOnce();
});
