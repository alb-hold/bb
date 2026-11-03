# Server process orphan after a swap

## Finding

The launcher started the server as a child but the server had no parent-loss handler. When desktop exhausted its launcher grace and killed the launcher, the server could continue running independently, keeping its listener and database open. During swaps, the installer then waited for the old server process to release `bb.db`. The 2026-10-15 orphan was started by a recovery-opened bb main from an earlier swap; the evidence did not support a server restart racing with quit.

## Shutdown behavior

The launcher now starts the server with an IPC channel, and the server treats that channel's disconnect as a request to run its normal shutdown path. The watcher queues a disconnect received before shutdown registration so database, HTTP, and websocket cleanup still runs. The server process alone exits; provider workers and detached native CLI holders remain alive.

On launcher SIGTERM, daemon detach must retain its bounded head start before the server stops. The shared schedule in `packages/config/src/full-stack-shutdown.ts` bounds the whole launcher shutdown inside desktop's owned-runtime grace. The public launcher test checks the real child PIDs after SIGTERM, and the server-entry test kills the launcher and checks that the server exits, its HTTP port is freed, and the database can be opened again.

## Evidence

- Desktop owns the launcher grace in `apps/desktop/src/main.ts` and `apps/desktop/src/bb-process.ts`.
- The launcher child creation and termination schedule are in `packages/bb-app/src/launcher.ts`.
- Parent-loss cleanup starts in `apps/server/src/services/system/launcher-disconnect.ts` and reaches `runShutdown` in `apps/server/src/start-server.ts`.
- The historical installer wait was observed during the 2026-10-15 swap investigation. The orphan was not caused by a restart loop spawning a server during quit.
