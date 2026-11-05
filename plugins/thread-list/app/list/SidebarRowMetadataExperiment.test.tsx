// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SidebarRowMetadataExperiment,
  useSidebarRowMetadataExperiment,
} from "./SidebarRowMetadataExperiment.js";

const experiment = vi.hoisted(() => vi.fn(() => true));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useExperiment: experiment,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Row() {
  return (
    <span>{useSidebarRowMetadataExperiment() ? "enabled" : "disabled"}</span>
  );
}

it("shares one experiment subscription across rows and propagates flag changes", () => {
  const rows = Array.from({ length: 100 }, (_, index) => <Row key={index} />);
  const view = render(
    <SidebarRowMetadataExperiment>{rows}</SidebarRowMetadataExperiment>,
  );
  expect(experiment).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText("enabled")).toHaveLength(100);
  experiment.mockReturnValue(false);
  view.rerender(
    <SidebarRowMetadataExperiment>{rows}</SidebarRowMetadataExperiment>,
  );
  expect(screen.getAllByText("disabled")).toHaveLength(100);
  expect(experiment).toHaveBeenCalledTimes(2);
});
