# SQL-FIX-1b shelved

Passive WebSocket observation target: `ws://127.0.0.1:38999/ws` on hsrpc, duration 600,255 ms (10 minutes).

| Change kind | Thread messages | Would dirty a list key |
| --- | ---: | ---: |
| `events-appended` | 952 | 2 |
| `queue-changed` | 1 | 1 |
| `status-changed` | 12 | 0 |
| `terminals-changed` | 16 | 0 |
| `thread-created` | 0 | 0 |
| `thread-deleted` | 0 | 0 |
| `history-rewritten` | 0 | 0 |
| `history-compacted` | 0 | 0 |
| `interactions-changed` | 0 | 0 |
| `title-changed` | 0 | 0 |
| `archived-changed` | 0 | 0 |
| `pin-state-changed` | 0 | 0 |
| `parent-changed` | 0 | 0 |
| `environment-changed` | 0 | 0 |
| `read-state-changed` | 0 | 0 |
| `tabs-changed` | 0 | 0 |

An active thread list with 192 rows costs about 12 ms per refetch.

shelved 2026-10-23 by root: a second list-maintenance path that can drift from server ordering, for a negligible measured gain
