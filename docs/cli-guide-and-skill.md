# CLI, Guide, And Skill

Thread terminal actions are available through `bb terminal surfaces --thread
<id> [--json]`, `bb terminal focus <terminalId> [--json]`, `bb terminal open-link
<terminalId> <url> [--json]`, `bb terminal split <terminalId> --side right|left|up|down
[--json]`, and `bb terminal move <terminalId> --to-pane-of <otherTerminalId>
[--json]`. The SDK exposes these as
`terminals.experimental_surfaces.list({ threadId })`,
`terminals.experimental_focus({ terminalId })`, and
`terminals.experimental_openBrowser({ terminalId, url })`,
`terminals.experimental_layout.split({ terminalId, side })`, and
`terminals.experimental_layout.move({ terminalId, targetTerminalId })`. The first lists
server-known terminal surfaces; `deliveredClients` is the number of open app
sockets the request was sent to. A zero-client response exits non-zero with a
message to open bb and retry; a positive count does not confirm receipt or
application. A client without an in-app browser offers the URL
through an Open action instead of creating an unavailable browser tab. Pane
limits and compact layouts are client state, so split and move can still be
rejected by the app after the request is sent; the CLI cannot confirm whether
the client received or applied them.

`bb terminal output <id> --lines <n>` prints the latest lines, including from
recently exited terminals. The server retains at most 64 KiB per terminal,
2 MiB and 128 terminals per machine for 30 minutes, evicting oldest output
first. The retained output is stored in the server database and survives server
restarts. Use
`bb terminal pipe <id> --follow [--command <cmd>]` to stream output to stdout or
a local command until the terminal exits or Ctrl-C.

Keep the discoverable surfaces in sync whenever you add or change a `bb` CLI command, flag, or a user-facing configuration knob (env var, `.bb/` workspace file, settings field):

- The in-CLI guide templates under `packages/templates/src/templates/bb-guide-*.md` are the core CLI manual. Document core commands, flags, and settings there; turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- The bb-cli skill (`plugins/bb-guide/skills/bb-cli/SKILL.md`) only routes agents to guide chapters and states agent habits and safety rules. Do not copy command documentation into it. Add new core command paths to its `references/command-index.md`.
- For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Configuration knobs also belong in `docs/configuration.md`.
- Keep maintainer and repository-development instructions (source startup, release and publishing steps) in `docs/` and app READMEs, not in the guide or shipped skills.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.

Device handoff is available as `bb device copy [text]` (or stdin) and
`bb device open <url>`, with SDK methods under `sdk.device.request()`. A
thread-only handoff goes to the device that most recently sent a message in the
thread's current turn, whether it started the turn or steered it. `bb` finds
that turn itself. If `BB_TURN_ID` is set, it must name that turn, or the request
fails with: `BB_TURN_ID does not match the thread's current turn`. With no current turn, it goes to the device that most recently sent a
message in the thread, and fails with the existing message if none has: “No device has sent a message
in this thread yet; open the thread on your phone and send a message, then run
the command again.” The app generates and stores its device id in local storage
so it can receive pending handoffs after reconnect. Handoffs are not sent to
other viewers. Terminal-bearing handoffs require a linked, visible terminal
attachment on the target device.

`bb thread row-status set <key> <value> [--icon <icon>] [--color <color>] [--priority <number>]`, `bb thread row-status clear [<key>]`, and `bb thread row-status list` manage up to eight status chips on the current thread's sidebar row. `bb thread progress <0..1> [--label <text>]` sets its progress bar; `bb thread progress clear` removes it. These commands use `BB_THREAD_ID` and fail outside a thread. `bb thread status <id>` remains an alias for `bb thread show <id>`. Row state clears when a managed turn settles to idle or error, or when a native terminal session closes with process exit or user close. A daemon disconnect does not clear native row state because the terminal may reattach. Explicit clear commands remove the selected state, and a targeted read hides state after 60 minutes without an update as a backstop. The SDK equivalents are `threads.experimental_rowState` and `threads.experimental_updateRowState`.
