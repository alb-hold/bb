import { createContext, useContext } from "react";

export const SidebarListVisibleContext = createContext(true);

export function useSidebarListShown(): boolean {
  return useContext(SidebarListVisibleContext);
}
