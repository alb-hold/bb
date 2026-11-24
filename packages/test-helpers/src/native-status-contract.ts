import type {
  ThreadListIndicator,
  ThreadRuntimeState,
  ThreadStatus,
} from "@bb/domain";

export interface NativeStatusContractCase {
  name: "setup-wait" | "trusted-idle" | "active-session-lost";
  providerId: string;
  displayName: string;
  initialThreadStatus: ThreadStatus;
  nativeSessionId: string | null;
  terminalStatus: "running" | "exited";
  terminalAgeMs: number;
  terminalCloseReason: "process-exit" | null;
  terminalExitCode: number | null;
  expectedStatus: ThreadStatus;
  expectedRuntime: ThreadRuntimeState;
  expectedListIndicator: ThreadListIndicator;
  expectedShowStatus: string;
  expectedListStatus: string;
  expectedListNeedsYou: string;
  expectedHeaderLabel: string;
}

export const NATIVE_STATUS_CONTRACT_CASES: readonly NativeStatusContractCase[] =
  [
    {
      name: "setup-wait",
      providerId: "codex",
      displayName: "Codex",
      initialThreadStatus: "idle",
      nativeSessionId: null,
      terminalStatus: "running",
      terminalAgeMs: 13_000,
      terminalCloseReason: null,
      terminalExitCode: null,
      expectedStatus: "idle",
      expectedRuntime: {
        displayStatus: "idle",
        nativeSetupWaiting: true,
      },
      expectedListIndicator: "needs-input",
      expectedShowStatus: "needs-input",
      expectedListStatus: "needs-input",
      expectedListNeedsYou: "Needs input",
      expectedHeaderLabel: "Needs input",
    },
    {
      name: "trusted-idle",
      providerId: "codex",
      displayName: "Codex",
      initialThreadStatus: "idle",
      nativeSessionId: "codex-session-trusted",
      terminalStatus: "running",
      terminalAgeMs: 13_000,
      terminalCloseReason: null,
      terminalExitCode: null,
      expectedStatus: "idle",
      expectedRuntime: {
        displayStatus: "idle",
      },
      expectedListIndicator: "none",
      expectedShowStatus: "idle",
      expectedListStatus: "idle",
      expectedListNeedsYou: "-",
      expectedHeaderLabel: "Idle",
    },
    {
      name: "active-session-lost",
      providerId: "codex",
      displayName: "Codex",
      initialThreadStatus: "active",
      nativeSessionId: "codex-session-lost",
      terminalStatus: "exited",
      terminalAgeMs: 13_000,
      terminalCloseReason: "process-exit",
      terminalExitCode: 1,
      expectedStatus: "error",
      expectedRuntime: {
        displayStatus: "error",
      },
      expectedListIndicator: "none",
      expectedShowStatus: "error",
      expectedListStatus: "error",
      expectedListNeedsYou: "-",
      expectedHeaderLabel: "Error",
    },
  ];
