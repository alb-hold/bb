import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../client.js", () => ({
  createCliBbSdk: () => ({ device: { request } }),
}));

import { registerDeviceCommands } from "../commands/device.js";

afterEach(() => {
  vi.unstubAllEnvs();
  request.mockReset();
});

describe("bb device commands", () => {
  it("includes the turn identity when the caller provides BB_TURN_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-1");
    vi.stubEnv("BB_TURN_ID", "turn-1");
    request.mockResolvedValue({ delivered: 1 });
    const program = new Command();
    registerDeviceCommands(program, {
      getUrl: () => "http://server.test",
      getContext: () => ({
        serverUrl: "http://server.test",
        threadId: "thread-1",
      }),
    });

    await program.parseAsync([
      "node",
      "bb",
      "device",
      "open",
      "https://example.com/login",
    ]);

    expect(request).toHaveBeenCalledWith({
      kind: "open-url",
      url: "https://example.com/login",
      origin: { threadId: "thread-1", turnId: "turn-1" },
    });
  });
});
