# Thread pruning timeout investigation

The `finishes unarchived cleanup in the background and advances past retained task progress` test exceeded its 15-second limit because the progress probe forced `events_thread_type_sequence_idx`, loaded the thread's progress rows in sequence order, and filtered by task ID in JavaScript. With 510 distinct task IDs, each candidate repeated an increasingly large scan, producing quadratic work. The two original failures are [run 38670754493, job 116213060098](https://github.com/albrand/bb/actions/runs/38670754493/job/116213060098) and [run 38639968021, job 116138642036](https://github.com/albrand/bb/actions/runs/38639968021/job/116138642036).

## Write-path and storage findings

The provider bridge's `item.progress` translation builds an item whose type is `backgroundTask` and emits `item/backgroundTask/progress`. Server ingestion in `apps/server/src/internal/events.ts` converts the event through `deriveStoredEventItemFields`, which derives `item_kind` from that payload. The database append path in `packages/db/src/data/events.ts` persists `AppendDaemonEventInput.itemKind` directly; the lower-level `insertEvents` path likewise persists its nullable `itemKind` argument directly. `events.item_kind` is nullable, and no database constraint ties it to the event type. Therefore, the normal provider path writes `backgroundTask`, but the database boundary does not guarantee that every stored progress row has that kind, and older or direct-inserted rows can have another kind or `NULL`.

A read-only live-database inventory reported 6,389 task progress events across 11,070 threads, all with `item_kind = backgroundTask`. That describes the inspected data, not a durable write invariant.

## Change and safety behavior

The normal probe keeps using the existing `events_background_task_thread_type_item_sequence_idx` fast path for correctly typed rows. If it finds no such row, it probes mismatched and `NULL` rows through a second partial composite index keyed by thread, event type, item ID, and sequence. The index covers only legacy/mismatched progress rows, so this safety path remains selective without reverting to a per-candidate scan over all progress events. A real migrated in-memory SQLite test covers both `NULL` and mismatched kinds; without the fallback, the older task progress rows remain and the test fails.

No event payload is rewritten and no database rows are migrated. The additional index is required because the existing fast index intentionally excludes mismatched and `NULL` item kinds; scanning the general sequence index for fallback rows on each candidate would reintroduce the quadratic behavior.
