---
kind: instruction
title: bb Terminal Guide
summary: Managing persistent terminals across thread, environment, and machine scopes, and running one command elsewhere with terminal run.
intent: Help agents route terminal sessions explicitly, manage them by terminal ID, and run one-shot commands on another machine.
editingNotes: Keep scope selectors, run and wait exit codes, and ID-only commands aligned with bb terminal --help.
---
Terminal commands

Use terminals for long-running commands that should stay alive for the user,
such as dev servers, watch tasks, REPLs, and database consoles. A terminal is a
real persistent PTY and appears in the bb UI.

List and create require exactly one explicit scope:

  bb terminal list --thread <thread-id>
  bb terminal list --environment <environment-id>
  bb terminal list --machine <id-or-name> [--cwd <path>]

  bb terminal create --thread <thread-id> [--working-directory <path>] --command "pnpm dev"
  bb terminal create --environment <environment-id>
  bb terminal create --machine <id-or-name> [--cwd <path>]   (alias: start)
    --working-directory <path>       Initial shell working directory
    --host <id-or-name>                   Alias for --machine
    --title <title>                       Display title
    --id <terminal-id>                    Use this ID (term_ plus 10 characters); fails if it exists
    --cols <n>                            Initial terminal columns (default: 200)
    --rows <n>                            Initial terminal rows (default: 50)
    --attach                              Attach after creating
    --json                                Print machine-readable output

Machine names are resolved to an explicit machine ID. No scope defaults to the
server machine, and --cwd is valid only with --machine or --host.

A terminal runs the machine's own shell: $SHELL (then zsh, bash, sh) on macOS
and Linux; on Windows, PowerShell 7 when `pwsh` is on PATH, otherwise Windows
PowerShell, otherwise cmd. Write --command in that shell's syntax. To run a
program with arguments without knowing the shell, pass them after `--`
(`bb terminal create --thread <id> -- pnpm test "my file.ts"`): the machine
quotes each argument for its own shell. `send --enter` presses Enter (a carriage
return), which every one of those shells accepts. The terminal's exit code is
the command's own exit code on every shell.

All other operations need only the terminal ID. They also accept the scope
flags above and ignore them, so a command built for `list` or `create` still
runs:

Thread terminal surfaces can also be listed and controlled from the CLI. Focus
and browser requests open the terminal's thread in connected bb app clients.
The browser action uses the same thread panel placement as terminal links.

  bb terminal surfaces --thread <thread-id> [--json]
  bb terminal focus <terminal-id> [--all]
  bb terminal open-link <terminal-id> <http-or-https-url> [--all]
  bb terminal split <terminal-id> --side right|left|up|down [--all]
  bb terminal move <terminal-id> --to-pane-of <other-terminal-id> [--all]

`focus`, `open-link`, `split`, and `move` reach only the app clients currently viewing the calling
thread (`BB_THREAD_ID`), so an agent never moves another window or another
agent's browser. If the terminal belongs to a different thread, the calling
thread's clients are moved to it. Outside a thread, or with no client viewing
the calling thread, nothing is sent and the command exits non-zero with
`no_caller_thread` or `no_client_viewing_caller_thread`. `--all` sends to every
open app client. `bb thread open` follows the same rule.

The SDK exposes `sdk.terminals.experimental_surfaces.list({ threadId })`,
`sdk.terminals.experimental_focus({ terminalId, callerThreadId? | all? })`, and
`sdk.terminals.experimental_openBrowser({ terminalId, url, callerThreadId? | all? })`. A surface
includes its thread and terminal IDs, title, status, and whether it is a
regular or native terminal. Archived threads and terminal IDs outside the
requested thread fail closed.
`sdk.terminals.experimental_layout.split({ terminalId, side, callerThreadId? | all? })` and
`sdk.terminals.experimental_layout.move({ terminalId, targetTerminalId })`
arrange terminal tabs in persisted sidebar panes and return `deliveredClients`,
the number of open app sockets the request was sent to. A zero-client response
means no request was sent. A positive count does not confirm receipt or
application; pane limits and compact layouts can still cause the client to
reject a split or move.
On clients without an in-app browser, `open-link` presents an Open action for
the external browser instead of adding an unavailable browser tab.

From inside a bb terminal, `bb terminal notify --title "Build" --body "Finished"`
raises attention on its terminal. The SDK exposes the same operation as
`sdk.terminals.notify({ terminalId, title, body })`.

Device handoffs

Agent commands and terminal shells can offer text to copy or an HTTP(S) URL to
open on a device whose WebSocket is admitted by BB's browser request guard.
Thread-only handoffs go to the device that most recently sent a message in the
thread's current turn, whether it started the turn or steered it. `bb` finds
that turn itself. If `BB_TURN_ID` is set, it must name that turn, or the request
fails with: `BB_TURN_ID does not match the thread's current turn`. With no current turn, it goes to the device that most recently sent a
message in the thread, and fails with the existing message if none has: “No device has sent a message
in this thread yet; open the thread on your phone and send a message, then run
the command again.” The app generates and stores its device id in local storage
so the same device receives pending handoffs after reconnect. Handoffs are not
sent to other viewers. Terminal-bearing handoffs require a linked, visible
terminal attachment on the target device. Examples:

  bb device copy "text to copy"
  printf '%s' "text to copy" | bb device copy
  bb device open https://example.com/login

The SDK exposes `sdk.device.request({ kind: "copy-text", text, origin })` and
`sdk.device.request({ kind: "open-url", url, origin })`. On the host, `pbcopy`,
`open`, `xdg-open`, and `$BROWSER` preserve their local behavior and also offer
supported text or URLs to the viewing device. Handoffs expire after ten minutes
and never copy or open anything until the user taps the offered action.

  bb terminal show <terminal-id>
  bb terminal attach <terminal-id>        Ctrl-B d detaches
  bb terminal send <terminal-id> --text <text> [--enter]
    --stdin                               Read bytes from stdin instead of --text
  bb terminal resize <terminal-id> --cols <n> --rows <n>
  bb terminal rename <terminal-id> <title>
  bb terminal notify --title <title> --body <body>   Raise attention from this terminal
  bb terminal attention list                     List uncleared terminal attention
  bb terminal attention next                     Print the oldest terminal needing attention
  bb terminal attention clear <terminal-id>       Clear attention for a terminal
  bb terminal restart <terminal-id>       Atomically replaces it with a shell; does not replay the original command
  bb terminal close <terminal-id> [--if-clean]   (alias: stop)

  A terminal has one size. When several windows or devices show it, the one
  you last typed, pasted or clicked in sets the size; opening or resizing
  another view does not change it until you use that view. bb terminal attach
  takes the size when it attaches and when its window resizes.

The app's “Next terminal needing attention” command and Alt+Shift+N open the
oldest uncleared terminal in its thread and terminal pane. When no terminal
needs attention, the app shows “Nothing needs attention.” The CLI's `next`
prints the target because it has no app window. The SDK exposes
`sdk.terminals.experimental_attention.list()`, `.next()`, and `.clear({ terminalId })`.

  bb terminal output <terminal-id>
    --lines <n>                          Print the latest N lines
    --since-seq <n>                       Read output chunks from a sequence
    --tail-bytes <n>                      Bound output to latest N bytes
    --limit-chunks <n>                    Bound output to latest N chunks
    --plain                               Print plain text, with colors and progress redraws removed
    --json                                Print chunks, nextSeq, truncated, status, exitCode, and closeReason

  bb terminal pipe <terminal-id> --follow
    --command <command>                  Pipe output into a local command

  Output stays readable after the command exits for 30 minutes, capped at 64 KiB
  per terminal, 2 MiB and 128 terminals per machine, with oldest output evicted first. Output
  is stored in the server database and survives server restarts. `pipe --follow` streams
  output until exit or Ctrl-C. For an exited terminal the output is followed by
  `Terminal <id> exited with code N` on stderr. Once the scrollback is gone,
  output fails with `terminal_output_unavailable` and says why.

  bb terminal screen <terminal-id>
    --lines <n>                          Print latest rendered rows, up to 500
    --json                                Include cursor position, grid size, and completeness

  Screen reads replay at most 64 KiB of retained output into disposable
  server-side terminal renderers. The default returns the visible grid. JSON
  includes `complete`, true when the retained output fully determines the visible
  screen. A false value means the retained output does not prove the screen is
  complete.
  Selection
  is client-local and is not available through this command.

  bb terminal wait <terminal-id>
    --exit                                Wait until the terminal exits (the default)
    --contains <text>                     Return once new output contains text
    --regex <pattern>                     Return once new output matches regex
    --since-seq <n>                       Start from this sequence (default: the current end for --contains or --regex, 0 otherwise)
    --from-start                          Start from sequence 0
    --timeout <duration>                  Stop waiting after this long; the terminal keeps running. Seconds, or a duration with a unit: 90s, 5m (default: 30s)
    --poll-interval <duration>            Milliseconds, or a duration with a unit (default: starts at 100ms and backs off to 1s)
    --max-output-bytes <n>                Return the last N bytes of output (default: 65536)
    --json                                Print terminalId, status, observation, exitCode, closeReason, output, truncated, and nextSeq

  Wait prints the terminal's output from where the wait started as plain text,
  with colors and progress redraws removed, then a status line on stderr. Text
  and regex matching ignore terminal escapes too, so `--contains "Local:"`
  matches a bold `Local`. It ends with the same exit codes as `terminal run`
  below.

For a dev server, prefer:

  bb terminal create --thread <thread-id> --title "pnpm dev" --command "pnpm dev"
  bb terminal wait <terminal-id> --contains "Local:" --timeout 120

Do not run long-lived servers as one-off foreground commands when the user will
need to inspect logs, refresh the page, or stop the process later.

Run a command and get its result

Use your own shell for commands in your current workspace. Use `bb terminal
run` to run a command on another machine or in another environment and get its
output and exit code in one call. It takes the same scope flags as `create`:

  bb terminal run --machine <id-or-name> --cwd <path> -- <program> [args...]
  bb terminal run --environment <environment-id> -- <program> [args...]
    --contains <text>                     Return once the output contains text
    --regex <pattern>                     Return once the output matches regex
    --timeout <duration>                  Stop waiting after this long; the command keeps running (default: 30s)
    --max-output-bytes <n>                Return the last N bytes of output (default: 65536)
    --id <terminal-id>                    Run under this ID (term_ plus 10 characters); a retry with it fails instead of running twice
    --title <title>                       Terminal title (default: the command)
    --cols <n>, --rows <n>                As for create
    --json                                Same shape as terminal wait --json

Pass the program and its arguments after `--`; the machine quotes them for its
shell, as `terminal create -- ...` does. Write `sh -c '...'` (or the machine's
shell) for pipes and `&&`. The command runs in a new terminal, so it appears in
the bb UI and the other terminal commands work on its ID. It runs in a PTY:
stdout and stderr arrive interleaved in one output, colors and progress
redraws are removed from it, and commands that page or prompt (`git log`,
`npm init`) wait for input. Use `git --no-pager` or the command's
non-interactive flags.

Run and wait end with the same exit codes:

  the command's exit code                 It exited
  0                                       --contains or --regex matched; it may still be running
  1                                       It exited before the text appeared, or its terminal was closed before it finished
  124                                     Still running after --timeout

Returning never stops the command. Continue with the `bb terminal wait` line
printed on stderr, stop it with `bb terminal close <terminal-id>`, or read all
of its output with `bb terminal output <terminal-id>`. After the machine
discards a finished command's output, wait still reports its exit code, with
`output` null. When run fails without printing a result, check
`bb terminal list` in the same scope before running it again, or pass `--id`
so a retry cannot run it twice.

In the app, Find in terminal (`terminal.find`; Cmd+F on macOS, Ctrl+Shift+F
elsewhere) searches the focused terminal's scrollback; Enter and Shift+Enter
move between matches, Match case toggles case sensitivity, and Escape closes
find and returns focus. Rebind it in Settings → Keyboard or with
`bb settings keyboard set terminal.find <shortcut>`; the SDK's
`system.updateKeyboardSettings` accepts the same command ID.

Terminal URLs and file paths open with Cmd+click on macOS, Ctrl+click
elsewhere, or a tap on touch screens. Printed file paths, including `path:line`
and `path:line:column`, open in bb's file viewer on the terminal's machine.
Relative paths use the shell's OSC 7 working directory when reported, otherwise
the session's initial directory. Quoted paths may contain spaces.

`bb terminal colors <terminalId> --foreground <r,g,b> --background <r,g,b>
--viewer-token <token> [--json]` updates OSC 10/11 replies using sRGB integers
from 0 to 255. Only the app viewer currently holding terminal size control may
update colours; its live viewer token is required. Read-only observers are rejected.
The SDK method is `terminals.experimental_setDefaultColors({ terminalId,
foreground, background, viewerToken })`. Accepted colours survive daemon reconnect;
native sessions use the dark fallback until the first accepted viewer update.
