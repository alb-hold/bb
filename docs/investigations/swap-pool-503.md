# Managed Codex turns during a server swap

## Incidents

On 2026-10-14, the old bb main began quitting at 11:38:12 and exited at 11:38:19. At 11:38:19, `server.201.log` recorded that the account-pool service hub had not stopped within 5,000 ms and the plugin was degraded. The hub stopped at 11:39:14. While the old server remained alive, pooled requests received terminal HTTP 503 responses because the account-pool plugin was degraded. The replacement server answered HTTP 200 at 11:40:35. Eleven managed Codex turns exhausted their five reconnects and entered error at 11:39:43, although their Codex processes and sessions had survived. The installer timeline is in the 2026-10-14 11:46 entry of `coord-tui-perf.md`; `server.201.log` was inspected read-only.

At 18:54:53 and 18:55:48, two more managed Codex turns started while the old server was shutting down. The read-only `server.201.log` sequence from 18:55–18:58 was account-pool stop, pooled 503 responses, then HTTP close. Both turns errored. The installer recorded the outcome in the 2026-10-14 19:01 entry of `coord-tui-perf.md`; the server log is named there and was read-only.

## Root cause

Shutdown stopped plugin services before the HTTP listener stopped accepting requests. A slow account-pool hub stop marked the plugin degraded while its server process still served pooled requests, so the route converted those requests into a terminal “plugin is not running” 503. The earlier shutdown order also waited indefinitely for open HTTP or upgraded WebSocket connections before plugin teardown, even though plugin teardown could be what closed those connections. The old retry defaults did not span the observed outage. A separate budget mismatch let the launcher's daemon-detach head start plus server shutdown exceed the desktop's six-second grace, while the AppImage supervisor had a four-second cap.

## Findings and change

The server now stops accepting HTTP before plugin teardown. It bounds the HTTP and WebSocket drain, destroys remaining tracked sockets before stopping plugins, and runs update-check shutdown concurrently with plugin shutdown inside the bounded phase. This avoids serving pool requests after shutdown begins and ensures plugin teardown cannot be held behind a socket that only plugin stop can close.

The shared shutdown schedule uses a 6,000 ms maximum daemon-detach head start, a 3,700 ms server shutdown bound, a 4,200 ms server-process termination deadline, a 10,200 ms daemon-process termination allowance, a 10,700 ms launcher maximum, and an 11,500 ms Desktop/AppImage grace. The head-start wait ends immediately when daemon detach completes. Read-only daemon logs yielded 64 complete shutdown-step samples: minimum 147 ms, median 492 ms, nearest-rank p95 1,739 ms, and maximum 4,736 ms. The 6,000 ms head start leaves 1,250 ms beyond that observed maximum. The full sample list and parsing method are in `/tmp/p7-swap503/detach-measurement.txt`.

Managed Codex is configured with `request_max_retries=11` and `stream_max_retries=11`. The installed Codex v0.162.1 was exercised against a Node stub bound only to `127.0.0.1`: it succeeded after five HTTP 503 responses and after five dropped SSE streams, making six requests in each case. With the overrides removed, the client failed after its default reconnect limit. The retry source formula gives about 409 seconds nominal cumulative backoff, within the 180–600 second target. Raw output is in `/tmp/p7-swap503/codex-162-runtime-proof.log`.

## Ruled out

The 18:55 failures occurred before HTTP close, while the account-pool plugin was degraded; they were not caused by the replacement server failing to bind. The Codex process and session remained alive in the 11:38 incident, so process loss was not the trigger for those terminal errors. The pool was not returning an authentication error: the recorded response was the plugin-not-running 503. No server/daemon wire field changed, and the host-daemon protocol remains version 240. No account-pool plugin source was changed for this fix.

## Live restart status

NOT RUN: a live managed Codex turn across a real development-stack restart was not exercised because the development stack did not have `BB_ACCOUNT_POOL_PARENT_URL` configured. No live bb process or data directory was used. The installer has the isolated-stack reproduction script at `/tmp/p7-swap503/repro-p7-swap503.sh` for its post-install run.
