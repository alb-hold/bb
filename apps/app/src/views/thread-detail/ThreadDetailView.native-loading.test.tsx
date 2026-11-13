// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { DefaultPaneContextProvider } from "./PaneContext";
import { ThreadDetailView } from "./ThreadDetailView";

const loading = vi.hoisted(() => ({ evaluated: false }));
const thread = makeThreadResponse({
  id: "thr_native",
  projectId: "proj_native",
  environmentId: "env_native",
  nativeTerminal: true,
});
const environment = makeEnvironment({
  id: "env_native",
  projectId: "proj_native",
});

vi.mock("./ThreadScreen", () => {
  loading.evaluated = true;
  return {
    ThreadScreen: () => <p>Native thread timeline content</p>,
    useThreadComposerAddToChat: () => () => {},
  };
});
vi.mock("./ThreadDetailHeader", () => ({ ThreadDetailHeader: () => null }));
vi.mock("@/components/thread/terminal/NativeThreadTerminalMain", () => ({
  NativeThreadTerminalMain: () => <p>Native terminal panel</p>,
}));
vi.mock("@/hooks/queries/native-terminal-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/native-terminal-queries")
  >()),
  useNativeTerminalThread: () => ({
    data: { terminal: { status: "running" } },
    isPending: false,
  }),
}));
vi.mock("./useThreadDetailThread", () => ({
  useThreadDetailThread: () => ({
    hasThreadDetailBootstrapSettled: true,
    thread,
    threadDetailBootstrapQuery: { isFetching: false },
    threadQuery: {
      data: thread,
      isFetching: false,
      isLoadingError: false,
      error: null,
    },
    unreadDividerState: { ready: true, anchor: null },
  }),
}));
vi.mock("@/hooks/queries/environment-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/environment-queries")
  >()),
  useEnvironment: () => ({
    data: environment,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./ThreadDetailSecondaryContent", () => ({
  ThreadDetailSecondaryContent: ({
    main,
    nativeTerminalMain,
  }: {
    main: ReactNode;
    nativeTerminalMain: ReactNode;
  }) => {
    const [chat, setChat] = useState(false);
    return (
      <>
        <button onClick={() => setChat(true)}>Open chat</button>
        {chat ? main : nativeTerminalMain}
      </>
    );
  },
}));
afterEach(cleanup);

it("renders the native terminal before evaluating chat, then loads the requested timeline", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Provider>
        <MemoryRouter>
          <DefaultPaneContextProvider
            paneId="main"
            onRequestClose={null}
            navigateInPane={() => {}}
          >
            <ThreadDetailView
              surface="pane"
              projectId={thread.projectId}
              threadId={thread.id}
              timelineEnabled={false}
            />
          </DefaultPaneContextProvider>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Native terminal panel")).toBeDefined();
  expect(loading.evaluated).toBe(false);
  fireEvent.click(screen.getByText("Open chat"));
  expect(
    await screen.findByText("Native thread timeline content"),
  ).toBeDefined();
  expect(loading.evaluated).toBe(true);
});
