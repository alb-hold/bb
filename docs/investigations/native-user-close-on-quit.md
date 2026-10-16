# Native terminal closed during daemon swap

## Incident and impact

During the 2026-10-15 16:29 daemon swap, 24 native terminals were present and 23 kept their CLI process. The affected terminal was `term_q48dsj6b5u`, held for thread `thr_efcerz7cvn` (`claude-code`, CLI PID 6666). Server 205 logged its daemon disconnect at 16:30:03.924. A targeted read-only query of the live database later showed that the session had been changed to `status=exited`, `close_reason=user`, at 16:30:05.545, 1.621 seconds later. At 16:30:06.603 the holder logged `pty-child-exit 129` followed by `holder-finish "explicit close"`; it had observed the terminal as closed for good and sent SIGHUP to the CLI. The installer recovered the thread at 16:35:42 on terminal `term_xq27fsbn3e`. The affected thread and both terminal records were left untouched during this investigation.

## Caller assessment

The exact request caller is inferred from source and timing; it was not recorded by the old server. The strongest match is the open-panel cleanup effect in `apps/app/src/components/thread/terminal/useThreadTerminalController.ts`. When the panel is open, the effect force-closes sessions that are disconnected and not retained by a mounted terminal view. `apps/app/src/lib/terminal-session-visibility.ts` defines that eligibility. A daemon swap disconnects the sessions, so this cleanup can run while the old server is still answering. At the incident revision, `packages/sdk/src/areas/terminals.ts` sent every SDK close as reason `user`; the lifecycle service then upgraded an exited `daemon-disconnect` row to `user`. That sequence matches both the 1.621-second gap and the holder's subsequent close decision.

The old server logs (`server.204` and `server.205`) have no request line that identifies the caller, and no matching desktop or browser client log was found in the target thread storage or `~/Library/Logs`. The route, SDK, and caller are therefore not proven from incident telemetry.

## Other paths checked

- `apps/server/src/services/threads/native-terminal-threads.ts` closes a reattach that finishes after its deadline. That path logs `Discarding a native terminal reattach that finished after its deadline` with the terminal ID. No such log exists for `term_q48dsj6b5u`, so this specific caller is ruled out.
- The public close route in `apps/server/src/routes/terminals.ts` is used by explicit app tab closes, the `bb terminal close` CLI command, SDK consumers, and plugin surfaces. The current investigation cannot distinguish an explicit close through this route from automatic app cleanup because the old server did not log the request or caller.
- `apps/server/src/services/threads/native-terminal-mode.ts` closes a terminal when switching a native thread back to chat; `apps/server/src/services/terminals/terminal-session-lifecycle.ts` closes the old terminal during restart; and `apps/server/src/services/machines/lifecycle.ts` closes terminals during machine lifecycle operations. No incident log proves any of these occurred, and none can be ruled out retrospectively from the available logs.
- No separate mobile terminal-close caller was found in the checked client source. Mobile or other SDK clients using the shared public close route remain indistinguishable in the old logs.

## Change and next-incident evidence

Automatic panel cleanup now sends `client-cleanup`; explicit user closes keep reason `user`. The server leaves an exited `daemon-disconnect` row unchanged for cleanup and leaves a disconnected native terminal attached to its native thread for reattach. Only an explicit `user` close may upgrade the exited row. If cleanup reaches a running terminal, the server translates it to the existing daemon wire reason `user`; the daemon contract and `HOST_DAEMON_PROTOCOL_VERSION` do not change.

Every close handled by the lifecycle service now logs `terminalId`, incoming `reason`, `mode`, and a caller name. The public route, native mode exit, reattach deadline, machine lifecycle, and restart paths identify themselves in that field, so a future incident can identify which server path submitted the close.

## Reproduction and verification limits

The migrated in-memory database regression tests cover client cleanup of exited and disconnected native terminals, explicit user close, and native reattach. HSRPC also ran the app cleanup effect and SDK reason tests. A full isolated live dev-stack swap walk was not run here: the assigned local worktree lacks the Electron executable in its dependency installation, and this task prohibited touching the live app. The installer's post-install native-survival check across 24 terminals will exercise survival during the actual install/swap.
