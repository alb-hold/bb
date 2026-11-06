// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalThreadRowMetadataDataInput,
  ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { toPluginSidebarThread } from "@/lib/plugin-sidebar-threads";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import { ThreadRowMetadata } from "./ThreadRowMetadata";
import { ThreadRowMetadataCollectorsView } from "./ThreadRowMetadataCollectorsView";

const thread = toPluginSidebarThread(makeThreadListEntry({ id: "thr_row" }));
const otherThread = toPluginSidebarThread(
  makeThreadListEntry({ id: "thr_other" }),
);

vi.mock("@/lib/plugin-sidebar-hooks", () => ({
  useSidebarThreads: () => ({ threads: [thread, otherThread] }),
}));

const archivedThread = toPluginSidebarThread(
  makeThreadListEntry({ id: "thr_archived" }),
);

function item(label: string) {
  return function Item({
    thread,
  }: ExperimentalThreadRowMetadataProps<unknown>) {
    return <span data-testid={label}>{thread.id}</span>;
  };
}

function Crashes(): never {
  throw new Error("row metadata crashed");
}

function renderRow() {
  const view = render(
    <div data-testid="row">
      <ThreadRowMetadata thread={thread} />
    </div>,
  );
  return { ...view, row: screen.getByTestId("row") };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetPluginFrontendBootStateForTest();
  removePluginSlotRegistrations("demo");
  resetAllCrashedPluginSlotsForTest();
  vi.useRealTimers();
});

describe("thread row metadata", () => {
  it("drops remembered chrome when plugin boot finishes without metadata contributors", () => {
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadRowMetadata: [{ id: "badge", component: item("badge") }],
      }),
    );
    const first = renderRow();
    first.unmount();
    removePluginSlotRegistrations("demo");
    const next = renderRow();
    expect(next.row.querySelector("[data-reserve-line]")).not.toBeNull();
    act(() => markPluginFrontendsSettled());
    expect(next.row.querySelector("[data-reserve-line]")).toBeNull();
    next.unmount();
    expect(renderRow().row.querySelector("[data-reserve-line]")).toBeNull();
  });

  it("remembers populated rows before registration and pending data, then forgets resolved empty rows", async () => {
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadRowMetadata: [{ id: "badge", component: item("badge") }],
      }),
    );
    const first = renderRow();
    expect(first.row.querySelector("[data-reserve-line]")).not.toBeNull();
    first.unmount();
    removePluginSlotRegistrations("demo");
    const next = renderRow();
    const line = next.row.querySelector("[data-thread-row-metadata]")!;
    expect(line.hasAttribute("data-reserve-line")).toBe(true);
    expect(line.hasAttribute("data-has-items")).toBe(false);
    const empty = render(<ThreadRowMetadata thread={otherThread} />);
    expect(empty.container.querySelector("[data-reserve-line]")).toBeNull();
    let data: Map<string, string> | undefined;
    function useData() {
      return data;
    }
    function Badge({
      thread,
      data,
    }: ExperimentalThreadRowMetadataProps<unknown>) {
      const label = data instanceof Map ? data.get(thread.id) : undefined;
      return label ? <span>{label}</span> : null;
    }
    act(() =>
      setPluginSlotRegistrations(
        "demo",
        makePluginRegistrationSet({
          threadRowMetadata: [{ id: "badge", useData, component: Badge }],
        }),
      ),
    );
    const collectors = render(<ThreadRowMetadataCollectorsView />);
    await act(async () => {});
    expect(line.hasAttribute("data-reserve-line")).toBe(true);
    data = new Map([[thread.id, "#10843"]]);
    collectors.rerender(<ThreadRowMetadataCollectorsView />);
    await act(async () => {});
    expect(line.textContent).toBe("#10843");
    expect(line.hasAttribute("data-reserve-line")).toBe(true);
    data = new Map();
    collectors.rerender(<ThreadRowMetadataCollectorsView />);
    await act(async () => {});
    expect(line.hasAttribute("data-reserve-line")).toBe(false);
    next.unmount();
    act(() => removePluginSlotRegistrations("demo"));
    expect(renderRow().row.querySelector("[data-reserve-line]")).toBeNull();
  });

  it("mounts every row's items at once, whether or not the row is on screen", () => {
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadRowMetadata: [{ id: "badge", component: item("badge") }],
      }),
    );
    render(
      <>
        <ThreadRowMetadata thread={thread} />
        <ThreadRowMetadata thread={otherThread} />
      </>,
    );
    expect(
      screen.getAllByTestId("badge").map((badge) => badge.textContent),
    ).toEqual([thread.id, otherThread.id]);
  });

  it("runs useData once for every listable thread while a line is mounted, and draws rows from its result", async () => {
    const calls: string[][] = [];
    function useData({ threads }: ExperimentalThreadRowMetadataDataInput) {
      calls.push(threads.map((listed) => listed.id));
      return new Map(threads.map((listed) => [listed.id, `pr:${listed.id}`]));
    }
    function Badge({
      thread,
      data,
    }: ExperimentalThreadRowMetadataProps<unknown>) {
      const label = data instanceof Map ? data.get(thread.id) : undefined;
      return <span data-testid="badge">{String(label)}</span>;
    }
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadRowMetadata: [{ id: "badge", useData, component: Badge }],
      }),
    );
    render(<ThreadRowMetadataCollectorsView />);
    await act(async () => {});
    expect(calls).toEqual([]);

    const line = render(<ThreadRowMetadata thread={archivedThread} />);
    expect(screen.queryByTestId("badge")).toBeNull();
    await act(async () => {});
    expect(calls.at(-1)).toEqual([
      thread.id,
      otherThread.id,
      archivedThread.id,
    ]);
    expect(screen.getByTestId("badge").textContent).toBe("pr:thr_archived");

    line.unmount();
    await act(async () => {});
    const settled = calls.length;
    render(<ThreadRowMetadata thread={thread} />);
    await act(async () => {});
    expect(calls.slice(settled).at(-1)).toEqual([thread.id, otherThread.id]);
  });

  it("shows the metadata line only while one of them draws something, including updates the item makes itself", async () => {
    function Late() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const timer = setTimeout(() => setReady(true), 50);
        return () => clearTimeout(timer);
      }, []);
      return ready ? <span data-testid="late">late</span> : null;
    }
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadRowMetadata: [{ id: "late", component: Late }],
      }),
    );
    const { row } = renderRow();
    const container = row.querySelector("[data-thread-row-metadata]")!;
    expect(container.hasAttribute("data-has-items")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByTestId("late")).toBeTruthy();
    expect(container.hasAttribute("data-has-items")).toBe(true);
  });

  it("orders items, renders nothing without contributions, and drops only a crashing item", () => {
    const empty = renderRow();
    expect(empty.row.querySelector("[data-reserve-line]")).toBeNull();
    empty.unmount();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadRowMetadata: [
          { id: "unordered", component: item("unordered") },
          { id: "crash", order: 1, component: Crashes },
          { id: "second", order: 2, component: item("second") },
          { id: "first", order: 0, component: item("first") },
        ],
      }),
    );
    const { row } = renderRow();
    expect(
      [...row.querySelectorAll("[data-testid]")].map((element) =>
        element.getAttribute("data-testid"),
      ),
    ).toEqual(["first", "second", "unordered"]);
  });
});
