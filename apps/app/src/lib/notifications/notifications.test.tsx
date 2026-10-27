// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast as sonnerToast } from "sonner";
import { AppToasterView } from "@/components/AppToasterView";
import { AppToastContent, appToast } from "@/components/ui/app-toast";
import { createPluginToast } from "./plugin-toast";
import {
  getNotificationCenterState,
  getNotifications,
  resetNotificationStore,
} from "./notification-store";

let verifyNoSonnerTimerAfterTeardown = false;
const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
let pendingSonnerTimeouts = new Map<
  Parameters<typeof globalThis.clearTimeout>[0],
  () => void
>();

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNotificationStore();
  pendingSonnerTimeouts = new Map();
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, timeout, ...args) => {
      const isSonnerTimeout =
        new Error().stack?.includes("sonner/dist/index.mjs") ?? false;
      if (!isSonnerTimeout || typeof handler !== "function") {
        return originalSetTimeout(handler, timeout, ...args);
      }
      let timeoutId: ReturnType<typeof setTimeout>;
      const wrappedHandler = (...handlerArgs: Parameters<typeof handler>) => {
        pendingSonnerTimeouts.delete(timeoutId);
        handler(...handlerArgs);
      };
      timeoutId = originalSetTimeout(wrappedHandler, timeout, ...args);
      pendingSonnerTimeouts.set(timeoutId, () => wrappedHandler());
      return timeoutId;
    },
  );
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((timeoutId) => {
    pendingSonnerTimeouts.delete(timeoutId);
    return originalClearTimeout(timeoutId);
  });
});

async function drainSonnerTimeouts() {
  await act(async () => {
    while (pendingSonnerTimeouts.size > 0) {
      const next = pendingSonnerTimeouts.entries().next();
      if (next.done) {
        break;
      }
      const [timeoutId, runTimeout] = next.value;
      originalClearTimeout(timeoutId);
      runTimeout();
      await Promise.resolve();
    }
  });
}

afterEach(async () => {
  const shouldVerifyTimers = verifyNoSonnerTimerAfterTeardown;
  verifyNoSonnerTimerAfterTeardown = false;
  try {
    if (vi.isFakeTimers()) {
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
    }
    await drainSonnerTimeouts();
    cleanup();
    sonnerToast.dismiss();
    await drainSonnerTimeouts();
    expect(pendingSonnerTimeouts.size).toBe(0);
    if (shouldVerifyTimers) {
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    if (shouldVerifyTimers) {
      vi.useRealTimers();
    }
    vi.restoreAllMocks();
    resetNotificationStore();
  }
});

describe("toast history", () => {
  it("leaves no Sonner timer pending after the test is torn down", () => {
    vi.useFakeTimers();
    verifyNoSonnerTimerAfterTeardown = true;
    render(<AppToasterView />);
    const toast = createPluginToast(sonnerToast);

    act(() => toast.error("Timer cleanup probe"));

    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("collapses a toast that is replaced by its result into one entry", () => {
    appToast.message("Installing…", { id: "install" });
    appToast.error("Install failed", {
      id: "install",
      description: 'Could not resolve "@radix-ui/react-tabs"',
    });

    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0]?.tone).toBe("error");
    expect(getNotifications()[0]?.description).toBe(
      'Could not resolve "@radix-ui/react-tabs"',
    );
  });

  it("renders and records plugin toasts through core's toast", async () => {
    render(<AppToasterView />);
    const toast = createPluginToast(sonnerToast);

    act(() => {
      toast.error("Sandbox boot failed", { description: "exit code 1" });
    });

    const title = await screen.findByText("Sandbox boot failed");
    expect(title.dataset.testid).toBe("app-toast-title");
    expect(
      title
        .closest(".bb-app-toast")
        ?.querySelector('[aria-label="Dismiss notification"]'),
    ).not.toBeNull();
    expect(getNotifications()[0]).toMatchObject({
      tone: "error",
      title: "Sandbox boot failed",
      description: "exit code 1",
    });

    let resolve: (value: string) => void = () => {};
    act(() => {
      toast.promise(new Promise<string>((done) => (resolve = done)), {
        id: "deploy",
        loading: "Deploying",
        success: (value) => `Deployed ${value}`,
      });
    });
    await waitFor(() => expect(screen.getByText("Deploying")).toBeDefined());
    await act(async () => resolve("v2"));
    await waitFor(() => expect(screen.getByText("Deployed v2")).toBeDefined());
    act(() => {
      toast.dismiss();
    });
  });
});

describe("truncated toast descriptions", () => {
  function renderToast() {
    render(
      <AppToastContent
        title="Installing the plugin failed"
        description="a very long esbuild error"
        tone="error"
        notificationId="notification-7"
      />,
    );
  }

  function mockWidths(scrollWidth: number, clientWidth: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "app-toast-description"
          ? scrollWidth
          : clientWidth;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      clientWidth,
    );
  }

  it("offers Show more only when the description does not fit", () => {
    mockWidths(300, 300);
    renderToast();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    cleanup();
    mockWidths(600, 300);
    renderToast();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeNull();
  });

  it("offers full details when wrapped text exceeds the visible height", () => {
    mockWidths(300, 300);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "app-toast-description" ? 160 : 20;
      },
    );
    renderToast();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(getNotificationCenterState().focusedId).toBe("notification-7");
  });
});
