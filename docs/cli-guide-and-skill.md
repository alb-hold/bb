# CLI, Guide, And Skill

Keep the discoverable surfaces in sync whenever you add or change a `bb` CLI command, flag, or a user-facing configuration knob (env var, `.bb/` workspace file, settings field):

- The in-CLI guide templates under `packages/templates/src/templates/bb-guide-*.md` are the core CLI manual. Document core commands, flags, and settings there; turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- The bb-cli skill (`plugins/bb-guide/skills/bb-cli/SKILL.md`) only routes agents to guide chapters and states agent habits and safety rules. Do not copy command documentation into it. Add new core command paths to its `references/command-index.md`.
- For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Configuration knobs also belong in `docs/configuration.md`.
- Keep maintainer and repository-development instructions (source startup, release and publishing steps) in `docs/` and app READMEs, not in the guide or shipped skills.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.

`bb thread row-status set <key> <value> [--icon <icon>] [--color <color>] [--priority <number>]`, `bb thread row-status clear [<key>]`, and `bb thread row-status list` manage up to eight status chips on the current thread's sidebar row. `bb thread progress <0..1> [--label <text>]` sets its progress bar; `bb thread progress clear` removes it. These commands use `BB_THREAD_ID` and fail outside a thread. `bb thread status <id>` remains an alias for `bb thread show <id>`. Row statuses and progress clear when an agent turn settles to idle or error, and when a native terminal session exits. Native terminal threads have no bb-managed turns; their status and progress remain until explicitly cleared or the state expires after 60 minutes without an update. The SDK equivalents are `threads.experimental_rowState` and `threads.experimental_updateRowState`.
