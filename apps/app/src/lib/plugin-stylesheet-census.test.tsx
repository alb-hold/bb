// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadInfoSections } from "@/components/secondary-panel/info/ThreadInfoSlots";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  applyPluginCss,
  resetPluginCssForTest,
  retainPluginCss,
} from "@/lib/plugin-css";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { HOST_TAILWIND_VERSION } from "@bb/plugin-build/host-tailwind-version";

function automationsSheetUrl(): string {
  return `/api/v1/plugins/automations/assets/app.css?h=census&host-tailwind=${HOST_TAILWIND_VERSION}`;
}

function autoLoadPluginStylesheets(): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          !(node instanceof HTMLLinkElement) ||
          (!node.hasAttribute("data-bb-plugin-css") &&
            !node.hasAttribute("data-bb-plugin-css-preload"))
        ) {
          continue;
        }
        queueMicrotask(() => {
          if (!node.isConnected) return;
          node.dispatchEvent(new Event("load"));
        });
      }
    }
  });
  observer.observe(document.head, { childList: true });
  return () => observer.disconnect();
}

function pluginCssLink(pluginId: string): HTMLLinkElement | null {
  return document.head.querySelector(
    `link[data-bb-plugin-css="${pluginId}"]`,
  );
}

afterEach(() => {
  cleanup();
  removePluginSlotRegistrations("automations");
  resetPluginCssForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin stylesheet census", () => {
  it("does not retain automations CSS on thread Info plugin slots", async () => {
    const stop = autoLoadPluginStylesheets();
    await applyPluginCss("automations", automationsSheetUrl());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    stop();
    setPluginSlotRegistrations(
      "automations",
      makePluginRegistrationSet({
        threadInfoSections: [
          {
            id: "automations",
            group: "1_a",
            component: () => createElement("p", null, "auto section"),
          },
        ],
      }),
    );
    render(
      <ThreadInfoSections
        core={[]}
        threadId="thr_1"
        projectId="proj_1"
        environment={null}
      />,
    );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
    expect(pluginCssLink("automations")).toBeNull();
  });

  it("drops a panel surface stylesheet after consumers and the grace elapse", async () => {
    vi.useFakeTimers();
    const stop = autoLoadPluginStylesheets();
    await applyPluginCss("automations", automationsSheetUrl());
    const release = retainPluginCss("automations");
    await act(async () => {
      await Promise.resolve();
    });
    expect(pluginCssLink("automations")).not.toBeNull();
    stop();
    release();
    const { unmount } = render(
      <PluginSlotMount
        pluginId="automations"
        slotKind="homepageSection"
        slotId="promo"
      >
        <span>promo</span>
      </PluginSlotMount>,
    );
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(pluginCssLink("automations")).toBeNull();
  });
});
