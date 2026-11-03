import { createContext, useContext, type ReactNode } from "react";
import {
  useInlineRename,
  useRenameSessionValue,
  type InlineRenameArgs,
  type InlineRenameEditorProps,
  type RenameController,
} from "@bb/shared-ui/inline-rename";
import { defineSplit } from "@/lib/define-split";

const RenameSessionDialog = defineSplit<{
  controller: RenameController;
  active: boolean;
}>({
  id: "sidebar-rename-dialog",
  load: () =>
    import("@bb/shared-ui/rename-session-dialog").then(
      (module) => module.RenameSessionDialog,
    ),
  loading: () => null,
  tier: "intent",
  mountWhen: ({ active }) => active,
  keepMounted: true,
});

const InlineRenameEditor = defineSplit<InlineRenameEditorProps>({
  id: "sidebar-rename-editor",
  load: () =>
    import("@bb/shared-ui/inline-rename-editor").then(
      (module) => module.InlineRenameEditor,
    ),
  loading: ({ session }) => (
    <span role="status" className="min-w-0 flex-1 truncate">
      {session.name}
    </span>
  ),
  tier: "intent",
});

const RenameControllerContext = createContext<RenameController | null>(null);

export function RenameControllerProvider({
  controller,
  children,
}: {
  controller: RenameController;
  children: ReactNode;
}) {
  const dialogActive =
    useRenameSessionValue(
      controller,
      (session) => session.presentation === "dialog",
    ) === true;
  return (
    <RenameControllerContext.Provider value={controller}>
      {children}
      <RenameSessionDialog controller={controller} active={dialogActive} />
    </RenameControllerContext.Provider>
  );
}

export function useSidebarRename(args: InlineRenameArgs) {
  const controller = useContext(RenameControllerContext);
  if (!controller) {
    throw new Error("useSidebarRename requires a RenameControllerProvider");
  }
  return useInlineRename(args, {
    controller,
    Editor: InlineRenameEditor,
    fitEditorToContent: true,
  });
}
