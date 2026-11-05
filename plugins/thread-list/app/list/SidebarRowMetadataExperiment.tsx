import { createContext, useContext, type ReactNode } from "react";
import { experimental_useExperiment } from "@get-bb/plugin-sdk/app";
import { THREAD_ROW_METADATA_EXPERIMENT } from "../preferences/atoms.js";

const SidebarRowMetadataExperimentContext = createContext(false);

export function SidebarRowMetadataExperiment({
  children,
}: {
  children: ReactNode;
}) {
  const enabled = experimental_useExperiment(THREAD_ROW_METADATA_EXPERIMENT);
  return (
    <SidebarRowMetadataExperimentContext.Provider value={enabled}>
      {children}
    </SidebarRowMetadataExperimentContext.Provider>
  );
}

export function useSidebarRowMetadataExperiment() {
  return useContext(SidebarRowMetadataExperimentContext);
}
