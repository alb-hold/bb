// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { useEffect } from "react";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { UNAVAILABLE_APP_PANEL_CONTROLLER } from "@/lib/app-fixed-tab-navigation";
import { wsManager } from "@/lib/ws";
import {
  createRetainedTerminalViews,
  RetainedTerminalViewSlot,
  RetainedTerminalViewsProvider,
  useRetainedTerminalPanelState,
} from "./RetainedTerminalViews";
import type { ThreadTerminalViewProps } from "./ThreadTerminalView";

const navigation: ReturnType<typeof useAppNavigationHost> = {
  panel: UNAVAILABLE_APP_PANEL_CONTROLLER,
  openFileExternally: () => false,
  openFilePreview: () => false,
  openTerminal: () => false,
  openUrl: () => false,
  openSignInWindow: () => null,
};
const View = () => <div>Terminal</div>;
const props = (id: string): ThreadTerminalViewProps => ({
  session: makeTerminalSession({ id }),
  autoFocus: false,
  isPanelOpen: true,
});
function harness() {
  const registry = createRetainedTerminalViews();
  const host = document.createElement("div");
  document.body.append(host);
  registry.setHost(host);
  const attach = (id: string, key = id) => {
    const slot = document.createElement("div");
    document.body.append(slot);
    return registry.attach(
      key,
      slot,
      View,
      { props: props(id), navigation },
      "prj_test",
    );
  };
  return { registry, host, attach };
}
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retained terminal viewers", () => {
  it("invalidates a user-closed panel while a route unmount parks it", () => {
    let mounts = 0;
    let disposals = 0;
    function Viewer() {
      useEffect(() => {
        mounts++;
        return () => {
          disposals++;
        };
      }, []);
      return <div>viewer</div>;
    }
    function Panel({ open }: { open: boolean }) {
      useRetainedTerminalPanelState("retained", open);
      return open ? (
        <RetainedTerminalViewSlot View={Viewer} {...props("retained")} />
      ) : null;
    }
    const tree = (route: boolean, open = true) => (
      <RetainedTerminalViewsProvider>
        {route ? <Panel open={open} /> : <div>Chat</div>}
      </RetainedTerminalViewsProvider>
    );
    const { rerender } = render(tree(true));
    rerender(tree(false));
    expect(disposals).toBe(0);
    rerender(tree(true));
    expect(mounts).toBe(1);
    rerender(tree(true, false));
    expect(disposals).toBe(1);
    rerender(tree(true));
    expect(mounts).toBe(2);
  });
  it("keeps twelve detached viewers in LRU order without evicting attached viewers", () => {
    const { registry, attach } = harness();
    const attached = attach("active");
    const oldest = attach("oldest");
    registry.detach(oldest);
    for (let i = 0; i < 11; i++) registry.detach(attach(`idle-${i}`));
    const evictedId = registry
      .getSnapshot()
      .find((entry) => entry.key === "idle-0")!.id;
    const adopted = attach("oldest");
    expect(adopted).toBe(oldest);
    registry.detach(adopted);
    registry.detach(attach("newest"));
    const entries = registry.getSnapshot();
    expect(entries).toContain(attached);
    expect(
      entries.filter((entry) => entry.snapshot.attachment === null),
    ).toHaveLength(12);
    expect(entries).toContain(oldest);
    expect(entries.some((entry) => entry.key === "idle-0")).toBe(false);
    expect(attach("idle-0").id).not.toBe(evictedId);
    registry.dispose();
  });
  it("clears route props and navigation on detach and adopts only current callbacks", () => {
    const { registry, attach } = harness();
    const entry = attach("retained");
    const oldCallback = vi.fn();
    registry.update(entry, {
      props: {
        ...props("retained"),
        onOpenLink: oldCallback,
        onTitleChange: oldCallback,
      },
      navigation,
    });
    registry.detach(entry);
    expect(entry.snapshot.attachment).toBeNull();
    expect(
      Object.values(entry.snapshot.retained).some(
        (value) => typeof value === "function",
      ),
    ).toBe(false);
    expect(entry.snapshot.retained).not.toHaveProperty("onOpenLink");
    const callback = vi.fn();
    const adopted = registry.attach(
      "retained",
      document.createElement("div"),
      View,
      { props: { ...props("retained"), onTitleChange: callback }, navigation },
      "prj_test",
    );
    expect(adopted).toBe(entry);
    adopted.snapshot.attachment?.props.onTitleChange?.("current");
    expect(callback).toHaveBeenCalledWith("current");
    expect(oldCallback).not.toHaveBeenCalled();
    registry.dispose();
  });
  it("evicts after five continuous hidden minutes and preserves attached viewers", () => {
    vi.useFakeTimers();
    const { registry, attach } = harness();
    const attached = attach("active");
    registry.detach(attach("idle"));
    registry.setDocumentHidden(true);
    vi.advanceTimersByTime(4 * 60_000);
    registry.setDocumentHidden(false);
    vi.advanceTimersByTime(5 * 60_000);
    expect(registry.getSnapshot()).toHaveLength(2);
    registry.setDocumentHidden(true);
    vi.advanceTimersByTime(5 * 60_000);
    expect(registry.getSnapshot()).toEqual([attached]);
    registry.dispose();
  });
  it("does not reuse invalidated or exited entries and never evicts an attached entry", () => {
    const { registry, attach } = harness();
    const entry = attach("failed");
    registry.invalidate((candidate) => candidate === entry);
    expect(registry.getSnapshot()).toContain(entry);
    registry.detach(entry);
    expect(registry.getSnapshot()).not.toContain(entry);
    const fresh = attach("failed");
    expect(fresh.id).not.toBe(entry.id);
    registry.detach(fresh);
    registry.sessionChanged(
      fresh,
      makeTerminalSession({ id: "failed", status: "exited" }),
    );
    expect(registry.getSnapshot()).not.toContain(fresh);
    registry.dispose();
  });
  it("gives simultaneous viewers of one terminal distinct containers and owners", () => {
    const { registry, attach } = harness();
    const left = attach("shared", "left");
    const right = attach("shared", "right");
    expect(left.id).not.toBe(right.id);
    expect(left.container).not.toBe(right.container);
    registry.detach(left);
    expect(attach("shared", "left")).toBe(left);
    expect(right.snapshot.attachment).not.toBeNull();
    registry.dispose();
  });
  it.each([
    "thread-deleted",
    "archived-changed",
    "environment-changed",
    "terminals-changed",
  ] as const)(
    "handles %s without treating a metadata refresh as a terminal exit",
    (kind) => {
      let changed: Parameters<typeof wsManager.onChanged>[0] = () => {};
      vi.spyOn(wsManager, "onChanged").mockImplementation((callback) => {
        changed = callback;
        return () => {};
      });
      let mounts = 0,
        disposals = 0;
      function Viewer() {
        useEffect(() => {
          mounts++;
          return () => {
            disposals++;
          };
        }, []);
        return <div>viewer</div>;
      }
      const tree = (shown: boolean) => (
        <RetainedTerminalViewsProvider>
          {shown ? (
            <RetainedTerminalViewSlot View={Viewer} {...props("retained")} />
          ) : null}
        </RetainedTerminalViewsProvider>
      );
      const { rerender } = render(tree(true));
      rerender(tree(false));
      expect(disposals).toBe(0);
      act(() =>
        changed({
          type: "changed",
          entity: "thread",
          id: "thr_test",
          changes: [kind],
        }),
      );
      expect(disposals).toBe(kind === "terminals-changed" ? 0 : 1);
      rerender(tree(true));
      expect(mounts).toBe(kind === "terminals-changed" ? 1 : 2);
    },
  );
  it.each([
    "project",
    "workspace",
    "reconnect",
    "identity",
    "disconnect",
  ] as const)("evicts parked viewers after a %s change", (kind) => {
    let connected: Parameters<typeof wsManager.onConnected>[0] = () => {};
    let stateChanged = () => {};
    vi.spyOn(wsManager, "onConnectionStateChange").mockImplementation(
      (callback) => {
        stateChanged = callback;
        return () => {};
      },
    );
    let identity: Parameters<
      typeof wsManager.onDeviceHandoffClientToken
    >[0] = () => {};
    vi.spyOn(wsManager, "onConnected").mockImplementation((callback) => {
      connected = callback;
      return () => {};
    });
    vi.spyOn(wsManager, "getDeviceHandoffClientToken").mockReturnValue(
      "old-identity",
    );
    vi.spyOn(wsManager, "onDeviceHandoffClientToken").mockImplementation(
      (callback) => {
        identity = callback;
        return () => {};
      },
    );
    let mounts = 0,
      disposals = 0;
    function Viewer() {
      useEffect(() => {
        mounts++;
        return () => {
          disposals++;
        };
      }, []);
      return <div>viewer</div>;
    }
    const tree = (
      shown: boolean,
      scope: Partial<ComponentProps<typeof RetainedTerminalViewsProvider>> = {},
    ) => (
      <RetainedTerminalViewsProvider
        projectId="old-project"
        environmentId="env_test"
        {...scope}
      >
        {shown ? (
          <RetainedTerminalViewSlot View={Viewer} {...props("retained")} />
        ) : null}
      </RetainedTerminalViewsProvider>
    );
    const { rerender } = render(tree(true));
    rerender(tree(false));
    if (kind === "project") rerender(tree(false, { projectId: "new-project" }));
    if (kind === "workspace")
      rerender(tree(false, { environmentId: "new-environment" }));
    if (kind === "reconnect")
      act(() => connected({ reconnected: true, disconnectedAt: 0 }));
    if (kind === "identity") act(() => identity("new-identity"));
    if (kind === "disconnect") {
      vi.spyOn(wsManager, "getConnectionState").mockReturnValue("connecting");
      act(stateChanged);
    }
    expect(disposals).toBe(1);
    rerender(tree(true));
    expect(mounts).toBe(2);
  });
  it("parks inside an inert host without hiding the active slot or app root", () => {
    const tree = (shown: boolean) => (
      <RetainedTerminalViewsProvider>
        {shown ? (
          <RetainedTerminalViewSlot View={View} {...props("retained")} />
        ) : (
          <button>Chat</button>
        )}
      </RetainedTerminalViewsProvider>
    );
    const { rerender } = render(tree(true));
    const host = document.querySelector("[data-retained-terminal-host]")!;
    expect(host.hasAttribute("inert")).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.textContent).toBe("");
    expect(document.body.hasAttribute("inert")).toBe(false);
    rerender(tree(false));
    expect(host.textContent).toBe("Terminal");
    expect(document.querySelector("button")?.closest("[inert]")).toBeNull();
  });
});
