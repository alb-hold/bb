// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContext, useLayoutEffect, useRef } from "react";
import { RootComposeHome } from "./RootComposeHome";
import { ComposerMaxHeightContext } from "@/components/promptbox/composer-max-height";
import { registerPaneComposerFocus } from "@/lib/pane-composer-focus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ComposerRootProbe() {
  const rootRef = useRef<HTMLDivElement>(null);
  const maxHeight = useContext(ComposerMaxHeightContext);
  useLayoutEffect(
    () => registerPaneComposerFocus(rootRef.current!, () => false),
    [],
  );
  return (
    <div
      ref={rootRef}
      data-testid="composer-root"
      data-max-height={maxHeight}
    />
  );
}

function renderCompactHome() {
  return render(
    <RootComposeHome
      isCompact
      composer={<div data-testid="composer" />}
      compactScrollContent={<div data-testid="recents" />}
      homepageSections={null}
    />,
  );
}

describe("RootComposeHome", () => {
  it("centres the desktop composer without pinning tall content offscreen", () => {
    render(
      <RootComposeHome
        isCompact={false}
        composer={<div />}
        compactScrollContent={null}
        homepageSections={null}
      />,
    );
    const column = screen.getByTestId("root-compose-compact-home");
    expect(screen.getByText("Start a new thread").className).toContain(
      "text-muted-foreground",
    );
    expect(column.className).toContain("my-auto");
    expect(column.className).toContain("shrink-0");
    expect(column.parentElement?.className).toContain("overflow-y-auto");
  });
  it("keeps mobile recents separate from the composer and desktop anchor", () => {
    renderCompactHome();

    const viewport = screen.getByTestId("root-compose-compact-scroll-viewport");
    const composer = screen.getByTestId("root-compose-compact-composer");

    expect(screen.queryByText("Start a new thread")).toBeNull();
    expect(viewport.style.bottom).toBe("0px");
    expect(viewport.className).toContain("overflow-y-auto");
    expect(composer.className).toContain("absolute");
    expect(composer.className).toContain("bottom-0");
    expect(composer.className).toContain("z-10");
    expect(composer.contains(screen.getByTestId("composer"))).toBe(true);
    expect(viewport.contains(screen.getByTestId("recents"))).toBe(true);
  });

  it("writes measured geometry directly before the compact home paints", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "root-compose-compact-home") return 852;
        if (this.dataset.testid === "root-compose-compact-composer") {
          return 188;
        }
        return 0;
      },
    );

    renderCompactHome();

    const leadingSpacer = screen.getByTestId(
      "root-compose-compact-leading-spacer",
    );
    expect(leadingSpacer.style.height).toBe("164px");
    expect(
      screen.getByTestId("root-compose-compact-scroll-viewport").style.bottom,
    ).toBe("188px");
  });

  it("caps the composer so a tall draft keeps it below the app chrome row", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "root-compose-compact-home") return 480;
        if (this.dataset.testid === "root-compose-compact-composer") {
          return 682;
        }
        if (this.dataset.testid === "composer-root") return 600;
        return 0;
      },
    );

    render(
      <RootComposeHome
        isCompact
        composer={<ComposerRootProbe />}
        compactScrollContent={<div />}
        homepageSections={null}
      />,
    );

    expect(screen.getByTestId("composer-root").dataset.maxHeight).toBe(
      `${480 - 56 - (682 - 600)}`,
    );
  });

  it("starts the scroll viewport at the app chrome row so rows scroll up through the band", () => {
    renderCompactHome();

    const viewport = screen.getByTestId("root-compose-compact-scroll-viewport");
    const content = screen.getByTestId("root-compose-compact-scroll-content");
    expect(viewport.style.top).toBe("56px");
    expect(content.firstElementChild).toBe(
      screen.getByTestId("root-compose-compact-leading-spacer"),
    );
  });

  it("rests a list that fits on the composer instead of the band top", () => {
    renderCompactHome();

    const content = screen.getByTestId("root-compose-compact-scroll-content");
    expect(content.className).toContain("min-h-full");
    expect(content.className).toContain("justify-end");
    expect(
      content.lastElementChild?.contains(screen.getByTestId("recents")),
    ).toBe(true);
  });
});
