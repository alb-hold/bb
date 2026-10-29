# Thread row-state API

`GET /api/v1/threads/{id}/row-state` reads the sidebar statuses and progress
for a thread. `PATCH /api/v1/threads/{id}/row-state` updates that row state.

`action: "clear"` is the global reset: it clears all statuses, progress, and
the stored terminal owner of progress.

`action: "progress-clear"` clears progress only when the supplied `terminalId`
matches its owner. Without `terminalId`, it clears only ownerless progress.
`force: true` explicitly overrides that ownership check and clears any current
progress. The CLI's `bb thread progress clear` command uses this override so an
explicit user request clears terminal-owned progress too.

`threads.experimental_updateRowState` accepts the same request shape. SDK
callers can pass `force: true` when they intend to clear progress regardless
of its owner. Callers that omit `force` and `terminalId` cannot clear
terminal-owned progress.
