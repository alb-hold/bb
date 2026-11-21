import { useSyncExternalStore } from "react";
import type { ProviderCliInstallLogDialogProps } from "@/components/dialogs/ProviderCliInstallLogDialog";
import { defineSplit } from "@/lib/define-split";
import {
  closeProviderCliInstallLog,
  getProviderCliInstallSnapshot,
  subscribeProviderCliInstalls,
} from "./provider-cli-install-state";

const ProviderCliInstallLogDialogSplit =
  defineSplit<ProviderCliInstallLogDialogProps>({
    id: "provider-cli-install-log-dialog",
    tier: "intent",
    load: () =>
      import("@/components/dialogs/ProviderCliInstallLogDialog").then(
        (module) => module.ProviderCliInstallLogDialog,
      ),
    loading: () => null,
    mountWhen: ({ state }) => state !== null,
    keepMounted: true,
  });

export function ProviderCliInstallLogDialogHost() {
  const snapshot = useSyncExternalStore(
    subscribeProviderCliInstalls,
    getProviderCliInstallSnapshot,
  );

  return (
    <ProviderCliInstallLogDialogSplit
      state={snapshot.logDialogState}
      onClose={closeProviderCliInstallLog}
    />
  );
}
