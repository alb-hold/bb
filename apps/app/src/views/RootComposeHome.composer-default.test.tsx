// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  SystemExecutionOptionsResponse,
  SystemProviderStatesResponse,
} from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  providerListCacheKey,
  writeCachedProviderList,
} from "@/lib/provider-list-cache";
import {
  hostsQueryKey,
  systemConfigQueryKey,
} from "@/hooks/queries/query-keys";
import { liveSystemExecutionOptionsQueryOptions } from "@/hooks/queries/system-queries";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { ExecutionControls } from "@/components/promptbox/ExecutionControls";
import { RootComposeHome } from "./RootComposeHome";

vi.mock("@/lib/sdk", () => ({
  BbHttpError: class BbHttpError extends Error {},
  sdk: {
    system: {
      config: vi.fn(),
      executionOptions: vi.fn(),
      providerStates: vi.fn(),
    },
    providers: { list: vi.fn() },
    projects: {
      defaultExecutionOptions: vi.fn(),
    },
  },
}));

const CODEX_PROVIDER = makeProviderInfo({
  id: "codex",
  displayName: "Codex",
  capabilities: {
    supportsNativeTerminal: true,
    supportsServiceTier: false,
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsNativeUserQuestion: false,
    supportsFork: true,
    supportsSessionRewind: true,
    modelCatalogScope: "host",
    permissionModes: ["accept-edits", "auto", "full"],
  },
});

const PI_PROVIDER = makeProviderInfo({
  id: "pi",
  displayName: "Pi",
  capabilities: {
    supportsNativeTerminal: false,
    supportsServiceTier: false,
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsNativeUserQuestion: false,
    supportsFork: true,
    supportsSessionRewind: true,
    modelCatalogScope: "host",
    permissionModes: ["accept-edits", "auto", "full"],
  },
});

const FULL_CATALOG: SystemExecutionOptionsResponse = {
  providers: [CODEX_PROVIDER, PI_PROVIDER],
  models: [
    {
      id: "codex-default",
      model: "codex-default",
      displayName: "Codex Default",
      description: "",
      reasoningDiscovery: "known",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
      defaultReasoningEffort: "medium",
      isDefault: true,
    },
  ],
  selectedOnlyModels: [],
  permissionCeiling: "full",
  modelLoadError: null,
};

const PI_ONLY_CATALOG: SystemExecutionOptionsResponse = {
  ...FULL_CATALOG,
  providers: [PI_PROVIDER],
  models: [],
};

function providerStatesNoneReady(): SystemProviderStatesResponse {
  return {
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "unauthenticated",
        statusMessage: null,
        planLabel: null,
        accountEmail: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
        localLoginCommand: null,
      },
      {
        providerId: "pi",
        displayName: "Pi",
        status: "not_installed",
        statusMessage: null,
        planLabel: null,
        accountEmail: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: true,
        canUpdate: false,
        loginCommand: null,
        localLoginCommand: null,
      },
    ],
  };
}

function seedHarness(queryClient: QueryClient): void {
  queryClient.setQueryData(systemConfigQueryKey(), {
    generalSettings: { defaultProviderId: "codex" },
  });
  queryClient.setQueryData(hostsQueryKey(), [
    makeHost({ id: "home-host", maxPermissionMode: "auto" }),
  ]);
}

async function prefetchPiScopedCatalog(queryClient: QueryClient): Promise<void> {
  vi.mocked(sdk.system.executionOptions).mockResolvedValueOnce(PI_ONLY_CATALOG);
  await queryClient.fetchQuery(
    liveSystemExecutionOptionsQueryOptions({
      hostId: "home-host",
      providerId: "pi",
    }),
  );
}

function HomeComposerProbe({ isCompact }: { isCompact: boolean }) {
  const options = useThreadCreationOptions({
    preferReadyProviderWhenUnset: true,
    resolveProviderRouting: () => ({ hostId: "home-host" }),
  });
  const nativeTerminalAvailable =
    options.providers.find((provider) => provider.id === options.selectedProviderId)
      ?.capabilities.supportsNativeTerminal === true;
  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompact}>
      <span data-testid="selected-provider">{options.selectedProviderId}</span>
      <RootComposeHome
        isCompact={isCompact}
        compactScrollContent={null}
        homepageSections={null}
        composer={
          <ExecutionControls
            provider={{
              selectedId: options.selectedProviderId,
              options: options.providerOptions,
            }}
            model={{
              active: options.activeModel,
              selected: options.selectedModel,
              options: options.modelOptions,
              moreOptions: options.moreModelOptions,
              isLoading: options.isLoadingModels,
              loadFailed: options.modelLoadFailed,
              onChange: options.setSelectedModel,
            }}
            reasoning={{
              value: options.reasoningLevel,
              options: options.reasoningOptions,
              onChange: options.setReasoningLevel,
            }}
            nativeTerminal={{
              enabled: nativeTerminalAvailable,
              onChange: () => {},
              disabled: !nativeTerminalAvailable,
            }}
          />
        }
      />
    </CompactViewportOverrideProvider>
  );
}

describe("RootComposeHome composer defaults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(FULL_CATALOG);
    vi.mocked(sdk.system.providerStates).mockResolvedValue(
      providerStatesNoneReady(),
    );
    vi.mocked(sdk.providers.list).mockResolvedValue([CODEX_PROVIDER, PI_PROVIDER]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("matches codex terminal defaults on phone and desktop after a pi-scoped cache warm", async () => {
    for (const isCompact of [false, true]) {
      cleanup();
      window.localStorage.clear();
      window.sessionStorage.clear();
      let resolveHome!: (value: SystemExecutionOptionsResponse) => void;
      const pendingHomeCatalog = new Promise<SystemExecutionOptionsResponse>(
        (resolve) => {
          resolveHome = resolve;
        },
      );
      vi.mocked(sdk.system.executionOptions).mockImplementation((args = {}) => {
        if (args.providerId === "pi") {
          return Promise.resolve(PI_ONLY_CATALOG);
        }
        return pendingHomeCatalog;
      });
      const { queryClient, wrapper } = createQueryClientTestHarness();
      seedHarness(queryClient);
      writeCachedProviderList(
        providerListCacheKey({ environmentId: null, hostId: "home-host" }),
        [PI_PROVIDER],
      );
      await prefetchPiScopedCatalog(queryClient);
      render(<HomeComposerProbe isCompact={isCompact} />, { wrapper });
      await waitFor(() => {
        expect(screen.getByTestId("selected-provider").textContent).toBe("codex");
      });
      resolveHome(FULL_CATALOG);
      await waitFor(() => expect(screen.getByTestId("selected-provider").textContent).toBe("codex"));
      await waitFor(() => {
        const trigger = screen.getByRole("button", {
          name: /^Provider, model and reasoning/,
        });
        expect(trigger.textContent).toContain("Codex");
      });
      const terminal = screen.getByRole("radio", { name: "Terminal" });
      expect(terminal.getAttribute("aria-checked")).toBe("true");
    }
  });
});
