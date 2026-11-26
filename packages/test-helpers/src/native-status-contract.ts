import type {
  ThreadListIndicator,
  ThreadRuntimeState,
  ThreadStatus,
} from "@bb/domain";

export interface NativeStatusContractCase {
  name:
    | "setup-wait"
    | "preassigned-awaiting-start"
    | "preassigned-awaiting-start-exited"
    | "preassigned-started-idle"
    | "trusted-idle"
    | "active-session-lost";
  providerId: string;
  displayName: string;
  initialThreadStatus: ThreadStatus;
  nativeSessionId: string | null;
  awaitingSessionStart: boolean;
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
      awaitingSessionStart: false,
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
      name: "preassigned-awaiting-start",
      providerId: "claude-code",
      displayName: "Claude Code",
      initialThreadStatus: "idle",
      nativeSessionId: "claude-preassigned-session",
      awaitingSessionStart: true,
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
      name: "preassigned-awaiting-start-exited",
      providerId: "claude-code",
      displayName: "Claude Code",
      initialThreadStatus: "idle",
      nativeSessionId: "claude-preassigned-exited",
      awaitingSessionStart: true,
      terminalStatus: "exited",
      terminalAgeMs: 13_000,
      terminalCloseReason: "process-exit",
      terminalExitCode: 0,
      expectedStatus: "idle",
      expectedRuntime: {
        displayStatus: "idle",
        nativeSessionExit: "clean",
      },
      expectedListIndicator: "none",
      expectedShowStatus: "idle",
      expectedListStatus: "idle",
      expectedListNeedsYou: "-",
      expectedHeaderLabel: "Exited",
    },
    {
      name: "preassigned-started-idle",
      providerId: "claude-code",
      displayName: "Claude Code",
      initialThreadStatus: "idle",
      nativeSessionId: "claude-preassigned-started",
      awaitingSessionStart: false,
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
      name: "trusted-idle",
      providerId: "codex",
      displayName: "Codex",
      initialThreadStatus: "idle",
      nativeSessionId: "codex-session-trusted",
      awaitingSessionStart: false,
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
      awaitingSessionStart: false,
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
