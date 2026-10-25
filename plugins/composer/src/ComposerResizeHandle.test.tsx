// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Internal_DO_NOT_USE_ComposerSizing } from "@get-bb/plugin-sdk/app";
import { CONTENT_MEASURE_WIDTH_PX } from "./content-measure";
import { ComposerResizeHandle } from "./ComposerResizeHandle";

const CONTENT_MEASURE_CSS_VARIABLE = "--bb-content-measure";

const FLOOR_PX = 68;
const VIEWPORT_HEIGHT_PX = 713;

type SizingValues = Pick<
  Internal_DO_NOT_USE_ComposerSizing,
  "editorHeight" | "contentMeasure" | "contentWidth"
>;

type SizingControls = Pick<
  Internal_DO_NOT_USE_ComposerSizing,
  "setEditorHeight" | "setContentWidth"
>;

function Harness({
  containerHeightPx,
  initialSizing,
  sizingStateRef,
  sizingControlsRef,
}: {
  containerHeightPx: number;
  initialSizing: SizingValues;
  sizingStateRef: MutableRefObject<SizingValues>;
  sizingControlsRef: MutableRefObject<SizingControls | null>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [editorHeight, setEditorHeight] = useState(initialSizing.editorHeight);
  const [contentWidth, setContentWidth] = useState(initialSizing.contentWidth);
  const contentMeasure = initialSizing.contentMeasure;
  sizingStateRef.current = { editorHeight, contentMeasure, contentWidth };
  const setWidth = useCallback(
    (width: number | null) => {
      setContentWidth(width);
      document.documentElement.style.setProperty(
        CONTENT_MEASURE_CSS_VARIABLE,
        `${width ?? CONTENT_MEASURE_WIDTH_PX[contentMeasure]}px`,
      );
    },
    [contentMeasure],
  );
  sizingControlsRef.current = {
    setEditorHeight,
    setContentWidth: setWidth,
  };
  return (
    <div>
      <ComposerResizeHandle
        scrollContainerRef={scrollContainerRef}
        layout="thread"
        floorPx={FLOOR_PX}
        sizing={{
          editorHeight,
          setEditorHeight,
          contentMeasure,
          contentWidth,
          setContentWidth: setWidth,
        }}
      />
      <div
        ref={(node) => {
          scrollContainerRef.current = node;
          if (node) {
            node.getBoundingClientRect = () =>
              ({ height: containerHeightPx }) as DOMRect;
          }
        }}
        data-testid="scroll"
      />
    </div>
  );
}

function renderHandle(
  containerHeightPx = FLOOR_PX,
  initialSizing: SizingValues = {
    editorHeight: null,
    contentMeasure: "comfortable",
    contentWidth: null,
  },
) {
  const sizingStateRef = { current: initialSizing };
  const sizingControlsRef: MutableRefObject<SizingControls | null> = {
    current: null,
  };
  const view = render(
    <Harness
      containerHeightPx={containerHeightPx}
      initialSizing={initialSizing}
      sizingStateRef={sizingStateRef}
      sizingControlsRef={sizingControlsRef}
    />,
  );
  const heightHandle = view.container.querySelector<HTMLDivElement>(
    "[data-promptbox-height-resize-handle]",
  );
  const leftWidthHandle = view.container.querySelector<HTMLDivElement>(
    '[data-promptbox-width-resize-side="left"]',
  );
  const rightWidthHandle = view.container.querySelector<HTMLDivElement>(
    '[data-promptbox-width-resize-side="right"]',
  );
  if (!heightHandle || !leftWidthHandle || !rightWidthHandle) {
    throw new Error("resize handles missing");
  }
  return {
    ...view,
    handle: heightHandle,
    heightHandle,
    leftWidthHandle,
    rightWidthHandle,
    sizing: () => sizingStateRef.current,
    setEditorHeight: (height: number | null) =>
      act(() => sizingControlsRef.current?.setEditorHeight(height)),
    setContentWidth: (width: number | null) =>
      act(() => sizingControlsRef.current?.setContentWidth(width)),
  };
}

describe("ComposerResizeHandle", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty(CONTENT_MEASURE_CSS_VARIABLE);
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT_HEIGHT_PX,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1_200,
    });
  });
  afterEach(cleanup);

  it("remembers a drag upward as the new editor height, clamped to the viewport ceiling", () => {
    const { handle, sizing } = renderHandle();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 500 });
    expect(document.activeElement).toBe(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 380 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 380 });
    expect(sizing().editorHeight).toBe(FLOOR_PX + 120);

    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientY: 500 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: -2000 });
    expect(sizing().editorHeight).toBe(
      Math.floor(VIEWPORT_HEIGHT_PX * 0.5 - 48),
    );
  });

  it("previews the height on the editor while dragging and drops the preview on cancel", () => {
    const { handle, getByTestId, sizing } = renderHandle(200);
    const scroll = getByTestId("scroll");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 450 });
    expect(scroll.style.getPropertyValue("--bb-composer-preview-height")).toBe(
      "250px",
    );
    fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 450 });
    expect(scroll.style.getPropertyValue("--bb-composer-preview-height")).toBe(
      "",
    );
    expect(sizing().editorHeight).toBeNull();
  });

  it("drops the memory when dragged back to the floor or reset by double-click", () => {
    const { handle, sizing, setEditorHeight } = renderHandle(300, {
      editorHeight: 300,
      contentMeasure: "comfortable",
      contentWidth: null,
    });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 900 });
    expect(sizing().editorHeight).toBeNull();

    setEditorHeight(300);
    fireEvent.doubleClick(handle);
    expect(sizing().editorHeight).toBeNull();
  });

  it("steps the height from the keyboard", () => {
    const { handle, sizing } = renderHandle(100);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(sizing().editorHeight).toBe(124);
    expect(handle.getAttribute("aria-valuenow")).toBe("124");
  });

  it("grows only the composer from its top resize handle", () => {
    const { heightHandle, sizing } = renderHandle();
    fireEvent.pointerDown(heightHandle, {
      pointerId: 1,
      button: 0,
      clientX: 500,
      clientY: 500,
    });
    fireEvent.pointerMove(heightHandle, {
      pointerId: 1,
      clientX: 620,
      clientY: 380,
    });
    fireEvent.pointerUp(heightHandle, {
      pointerId: 1,
      clientX: 620,
      clientY: 380,
    });

    expect(sizing().editorHeight).toBe(FLOOR_PX + 120);
    expect(sizing().contentWidth).toBeNull();
  });

  it("grows only the chat from either top corner resize handle", () => {
    const { leftWidthHandle, rightWidthHandle, sizing } = renderHandle();
    fireEvent.pointerDown(rightWidthHandle, {
      pointerId: 1,
      button: 0,
      clientX: 500,
      clientY: 500,
    });
    fireEvent.pointerMove(rightWidthHandle, {
      pointerId: 1,
      clientX: 620,
      clientY: 380,
    });
    expect(
      rightWidthHandle.getAttribute("data-promptbox-resize-dragging"),
    ).toBe("");
    expect(
      leftWidthHandle.getAttribute("data-promptbox-resize-dragging"),
    ).toBeNull();
    fireEvent.pointerUp(rightWidthHandle, {
      pointerId: 1,
      clientX: 620,
      clientY: 380,
    });

    expect(sizing().editorHeight).toBeNull();
    expect(sizing().contentWidth).toBe(880);
    expect(
      document.documentElement.style.getPropertyValue(
        CONTENT_MEASURE_CSS_VARIABLE,
      ),
    ).toBe("880px");
    expect(rightWidthHandle.getAttribute("aria-valuetext")).toContain(
      "Chat width 880 pixels",
    );

    fireEvent.pointerDown(leftWidthHandle, {
      pointerId: 2,
      button: 0,
      clientX: 500,
      clientY: 500,
    });
    fireEvent.pointerUp(leftWidthHandle, {
      pointerId: 2,
      clientX: 380,
      clientY: 380,
    });
    expect(sizing().contentWidth).toBe(1_000);
  });

  it("keeps the chosen width when the viewport resizes", () => {
    const { rightWidthHandle, sizing } = renderHandle();
    fireEvent.keyDown(rightWidthHandle, { key: "ArrowRight" });
    expect(sizing().contentWidth).toBe(784);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    fireEvent(window, new Event("resize"));
    expect(sizing().contentWidth).toBe(784);
    expect(
      document.documentElement.style.getPropertyValue(
        CONTENT_MEASURE_CSS_VARIABLE,
      ),
    ).toBe("784px");
  });

  it("keeps a saved width through a cancelled drag and a narrow-then-wide window cycle", () => {
    const { rightWidthHandle, sizing, setContentWidth } = renderHandle();
    setContentWidth(900);
    fireEvent.pointerDown(rightWidthHandle, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(rightWidthHandle, {
      pointerId: 1,
      clientX: 200,
      clientY: 100,
    });
    expect(
      document.documentElement.style.getPropertyValue(
        CONTENT_MEASURE_CSS_VARIABLE,
      ),
    ).toBe("1000px");

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    fireEvent(window, new Event("resize"));
    fireEvent.pointerUp(rightWidthHandle, {
      pointerId: 1,
      clientX: 200,
      clientY: 100,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1_600,
    });
    fireEvent(window, new Event("resize"));

    expect(sizing().contentWidth).toBe(900);
    expect(
      document.documentElement.style.getPropertyValue(
        CONTENT_MEASURE_CSS_VARIABLE,
      ),
    ).toBe("900px");
  });

  it("cancels a width drag in progress when the viewport resizes", () => {
    const { rightWidthHandle, sizing } = renderHandle();
    fireEvent.pointerDown(rightWidthHandle, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(rightWidthHandle, {
      pointerId: 1,
      clientX: 300,
      clientY: 100,
    });
    fireEvent(window, new Event("resize"));
    expect(
      document.documentElement.style.getPropertyValue(
        CONTENT_MEASURE_CSS_VARIABLE,
      ),
    ).toBe("760px");
    fireEvent.pointerUp(rightWidthHandle, {
      pointerId: 1,
      clientX: 300,
      clientY: 100,
    });
    expect(sizing().contentWidth).toBeNull();
  });

  it("resets each axis from its own resize handle", () => {
    const { heightHandle, leftWidthHandle, rightWidthHandle, sizing } =
      renderHandle();
    fireEvent.keyDown(heightHandle, { key: "ArrowUp" });
    fireEvent.keyDown(rightWidthHandle, { key: "ArrowRight" });
    fireEvent.doubleClick(heightHandle);
    expect(sizing().editorHeight).toBeNull();
    expect(sizing().contentWidth).toBe(784);
    fireEvent.keyDown(leftWidthHandle, { key: "ArrowLeft" });
    expect(sizing().contentWidth).toBe(808);
    fireEvent.doubleClick(leftWidthHandle);
    expect(sizing().contentWidth).toBeNull();
  });
});
