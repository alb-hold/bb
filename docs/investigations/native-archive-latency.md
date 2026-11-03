# Native terminal archive latency investigation

## Finding

Installer post-install packet `inst-34d9` recorded that archiving a native terminal thread took about 40 seconds for its CLI to exit. The server archive response returned promptly; the delay was in terminal teardown.

## Root cause

Archiving marked the thread for teardown, but the periodic lifecycle sweep preserved its terminal during the 30-second undo grace. The sweep runs every 10 seconds, so the terminal closed on the first sweep after grace expired. Depending on sweep phase, that produced 30–40 seconds before the CLI exited. The five baseline archive-to-exit runs at `af1713b865a016a7727b0754545bb19a0e65ecaf` measured 35.922, 31.792, 33.734, 41.502, and 39.498 seconds.

The native holder's detached status check runs every two seconds and can discover a close later, but it was not the source of the observed delay: the server had intentionally deferred the archived-terminal close until the grace elapsed and the next sweep ran. The server's repeated “already has an active writer” warnings also were not the cause. The archive returned before teardown, and the close path did not wait for a writer to finish; on the current head the same isolated stack closed all five archived native terminals in 1.826, 1.804, 1.833, 1.828, and 1.848 seconds, each with close reason `thread-archived`.

The fix makes native terminal closure immediate through the existing archived-thread lifecycle path while preserving the undo grace for ordinary terminal sessions.

## Undo timing and reconnect

Ending the CLI at archive initially exposed a separate behavior: undo restored the thread while leaving the native terminal exited. Unarchive now uses the same native reopen and resume machinery as daemon reconnect. If reconnect and unarchive race for the same thread, the pending reattach is coalesced so they dispatch one `terminal.open` and start one holder. The tests exercise archived and deleted thread guards, the `thread-archived` close-reason gate, same-provider-session resume, and the reconnect/unarchive race.

The earlier 15.109, 16.096, and 17.354 second undo figures were composite measurements. Their script waited for resumed CLI output and then made an additional `bb thread native` status request; those numbers were not the time for the terminal to become running. The staged trace measured unarchive response at 0.998, 1.385, and 1.165 seconds; terminal status became `running` at 1.000, 1.387, and 1.167 seconds; resumed stand-in CLI output arrived at 1.848, 3.656, and 2.278 seconds. The additional status request took 0.964, 2.473, and 1.181 seconds. `terminal.open` send to daemon receipt took 1–10 ms, and daemon receipt to PTY spawn took 6–20 ms. The trace machine was under high load, with one-minute load averages of 33.1–45.4 and five-minute averages of 40.3–42.5. No application poll, reopen retry, or wait for the previous holder accounted for the composite result.

On current head `0e5bc5b60582a8a115843debd5ef8da78f1e9c17`, three archive-then-undo walks returned to a running terminal in 1.254, 1.240, and 1.171 seconds. Each walk observed one archived holder exit, a replacement holder attached to the resumed terminal, and the stand-in CLI running again.

## Timing evidence

| Behavior | Commit | Results |
| --- | --- | --- |
| Baseline archive to CLI exit | `af1713b865a016a7727b0754545bb19a0e65ecaf` | 35.922s, 31.792s, 33.734s, 41.502s, 39.498s |
| Fixed archive to CLI exit | `0e5bc5b60582a8a115843debd5ef8da78f1e9c17` | 1.826s, 1.804s, 1.833s, 1.828s, 1.848s |
| Fixed undo to terminal running | `0e5bc5b60582a8a115843debd5ef8da78f1e9c17` | 1.254s, 1.240s, 1.171s |

The timing JSONL files record the source head, worktree porcelain count, server PID, and server start time. The HSRPC server suite passed 86 archive, native-terminal, and lifecycle tests at the current head. Three mutants—removing the archived-thread guard, removing the `thread-archived` reason gate, and removing reconnect/unarchive deduplication—each failed its intended regression test at that head.

Evidence files: `baseline-archive-to-exit.jsonl`, `archive-to-exit-0e5.jsonl`, `undo-to-running-0e5.jsonl`, `undo-stage-runs.jsonl`, `undo-detailed-timeline.jsonl`, `final-head-timings.log`, `final-server-0e5bc5b60.log`, `reconnect-mutant-archived.log`, `reconnect-mutant-reason.log`, and `reconnect-mutant-dedupe.log`.
