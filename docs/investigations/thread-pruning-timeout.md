# Thread pruning timeout investigation

The `finishes unarchived cleanup in the background and advances past retained task progress` test exceeded its 15-second limit because the progress probe forced `events_thread_type_sequence_idx`, loaded the thread's progress rows in sequence order, and filtered by task ID in JavaScript. With 510 distinct task IDs, each candidate repeated an increasingly large scan, producing quadratic work. The two original CI jobs are [run 38670754493, job 116213060098](https://github.com/albrand/bb/actions/runs/38670754493/job/116213060098) and [run 38639968021, job 116112677202](https://github.com/albrand/bb/actions/runs/38639968021/job/116112677202).

## Write-path and storage findings

The provider bridge's `item.progress` translation builds an item whose type is `backgroundTask` and emits `item/backgroundTask/progress`. Server ingestion in `apps/server/src/internal/events.ts` converts the event through `deriveStoredEventItemFields`, which derives `item_kind` from that payload. The database append path in `packages/db/src/data/events.ts` persists `AppendDaemonEventInput.itemKind` directly; the lower-level `insertEvents` path likewise persists its nullable `itemKind` argument directly. `events.item_kind` is nullable, and no database constraint ties it to the event type. Therefore, the normal provider path writes `backgroundTask`, but the database boundary does not guarantee that every stored progress row has that kind, and older or direct-inserted rows can have another kind or `NULL`.

A read-only live-database inventory reported 6,389 task progress events across 11,070 threads, all with `item_kind = backgroundTask`. That describes the inspected data, not a durable write invariant.

## Change and safety behavior

The normal probe keeps using the existing `events_background_task_thread_type_item_sequence_idx` fast path for correctly typed rows. Once per thread in each pruning pass, the pruner checks for any mismatched or `NULL` progress row using the existing `events_thread_type_sequence_idx` and a `LIMIT 1`; it performs the per-candidate legacy probe only when that check finds a row. The legacy probe also uses the existing thread/type/sequence index and filters by item ID. This avoids a startup index build and keeps the fallback off the normal path. A real migrated in-memory SQLite test covers both `NULL` and mismatched kinds; without the fallback, the older task progress rows remain and the test fails.

No event payload is rewritten and no database rows are migrated. No migration is needed: building a new partial index would scan the full events table during startup. The one-per-thread existence check runs only as pruning advances, uses an existing index, and the live inventory found no legacy progress rows.

## Load measurements

The old-query mutant reproduced the timeout once in 30 runs under 24 `yes` workers pinned with the target to CPUs 0–3 (median 10.564s, maximum 15.62s); the matched fixed set passed 30/30 (median 1.833s, maximum 3.781s). Both used `REMOTE_HEAD=f352c40036bcb9cd1b43e360da231d8e8df014e6`.

After removing migration 0143 and replacing the index with a per-thread legacy-row existence check, the final merged head `ba8cb2c86771c1391970da7d22d8c7c7616c72ed` passed 30/30 under the same 24-worker/four-core load. Target-duration median was 1.555s, p95 was 2.545s, and maximum was 2.872s. The hsrpc one-minute load average recorded before each run ranged from 11.95 to 56.51. Per-run durations and load averages are in `/tmp/p19-prune-flake/final-merged-head-load-30.log`; aggregate statistics are in `/tmp/p19-prune-flake/final-merged-head-load-30.stats.log`. The earlier run on `cd4d233d4e28b388618b626549aaf378009f6462` had two high durations (12.598s and 10.042s); the final-head rerun records load per invocation and provides the distribution above without attributing those earlier observations to a specific cause.
