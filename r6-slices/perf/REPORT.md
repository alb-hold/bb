# Round 6 slice A: performance

Serves P1/P3. Branch `feat/ui-polish-perf-r6`. App source `badff084647546f0b3f9682a0ae3a443dd4ccb0c` (later changes are test typing/formatting and evidence only). Developer persona using the owner-supplied seeded workspace; production preview http://127.0.0.1:16830; control round 5 http://127.0.0.1:16800; untouched API/WebSocket server 24706. No PR, merge, install, shared-plugin edit, thread submission, creation/deletion, or backend restart.

## First-key outcome

**PASS: 18/18 immediate runs ≤16 ms** on the changed build. The interleaved control reached 4/18. Each run uses a fresh context in a dedicated extension-free Chromium process, viewport 1280×800; the supplied early-input probe’s visible-composer boundary, focus, 40 ms wait, `a`, 40 ms wait, `b`, and task-sum formula are preserved. Tracing is captured in every run. AB/BA order alternates by pair. All raw traces remain local under ignored `raw/` directories. This is a task-wall metric, not key-to-paint latency.

The existing deferred boot now waits for the home composer’s first input or two seconds after readiness, whichever comes first, before the existing two-frame and idle scheduling. The listener and timeout are cleaned up on either path. Non-home routes and a missing composer bypass the added wait. The composer selector is shared to keep the unchanged bundle budget. No setting, flag, dependency, or public plugin API was added.

### Measurements

**Initial diagnostic control**
Load average before [99.42236328125, 64.75830078125, 54.5380859375]; after [141.25927734375, 77.26904296875, 59.33740234375] (1/5/15-minute).
- Port 16800: n=6, median 22.5335 ms, ≤16 ms 2/6; raw ms: `[28.517, 13.13, 97.571, 82.745, 10.339, 16.55]`.
Raw full metrics: `before/early.json`; attribution: `before/trace-summary.json`.

**Pre-change interleaved**
Load average before [127.69189453125, 92.1318359375, 71.859375]; after [163.56103515625, 110.650390625, 80.6630859375] (1/5/15-minute).
- Port 16800: n=18, median 16.8645 ms, ≤16 ms 6/18; raw ms: `[16.628, 35.952, 22.009, 15.556, 17.043, 15.722, 17.156, 29.367, 16.686, 17.296, 15.937, 16.097, 12.354, 59.852, 26.93, 20.495, 14.643, 15.389]`.
- Port 16830: n=18, median 16.2835 ms, ≤16 ms 8/18; raw ms: `[14.398, 25.08, 14.504, 18.006, 16.184, 26.9, 15.996, 16.964, 14.87, 15.108, 18.103, 17.299, 24.221, 15.966, 15.506, 16.383, 14.696, 20.169]`.
Raw full metrics: `./early.json`; attribution: `./trace-summary.json`.

**Changed-build interleaved**
Load average before [45.12939453125, 72.33203125, 70.91259765625]; after [60.6923828125, 70.919921875, 70.46337890625] (1/5/15-minute).
- Port 16800: n=18, median 20.3135 ms, ≤16 ms 4/18; raw ms: `[20.275, 23.047, 38.507, 15.532, 15.682, 35.429, 20.352, 15.99, 16.846, 44.826, 14.848, 20.173, 32.168, 16.057, 50.684, 22.733, 17.072, 29.473]`.
- Port 16830: n=18, median 14.1305 ms, ≤16 ms 18/18; raw ms: `[14.118, 14.791, 14.204, 12.793, 14.453, 11.939, 11.762, 14.246, 14.956, 15.729, 12.464, 15.3, 14.143, 11.375, 14.921, 12.71, 13.888, 12.516]`.
Raw full metrics: `after/early.json`; attribution: `after/trace-summary.json`.

### Attribution and limits

The traces separate same-thread RunTask wall duration and `tdur` CPU time, scripting interval union, style, layout, painting and module evaluation. These categories can nest and must not be added together. `outsideTasksMs` includes the intentional 40 ms probe delay, protocol delivery and browser waits; it is not presented as measured frame latency. `postTaskGapMs` is likewise not a frame-wait verdict.

The six initial control traces include a 71.667 ms task with 71.403 ms CPU inside React scheduler function E in boot-vendor, without module evaluation in that key window. Those tails cannot all be called host waiting or plugin evaluation. In the pre-change interleaved candidate, three of four >20 ms tails include 4.201–7.433 ms module evaluation; the fourth includes style/layout work. The bounded queue delay addresses the established overlapping module work, without claiming it explains every tail. Load changed materially between measurement windows; only each window’s live interleaved control is used for comparison. Settled-key performance was not remeasured.

## Renderer soak

Read round 5’s report and reused its final broad deterministic sequence, thread inventory, checkpoints, heap summarizer, live prototype-query method, and assertions. Replaced the BB adapter with the harness’s Playwright install and a freshly launched Chromium headless-shell 155.0.8059.12. There is no extension and `typeof __REACT_DEVTOOLS_GLOBAL_HOOK__` is `undefined`. The browser and context belong only to this run. Snapshot chunk listeners and query handles are released. GC runs twice before each checkpoint; snapshots are at 0/150/300.

### Pre-change source 5a160b645b

One browser run, n=1 per checkpoint: raw values equal checkpoint medians.
| Navigation | Heap MiB | DOM | Listeners | Live xterm | Live WebGL |
|---:|---:|---:|---:|---:|---:|
|0|44.988445|1450|810|1|1|
|50|63.399895|2650|1114|0|0|
|150|66.720676|2656|1117|0|0|
|200|66.276165|2672|1117|0|0|
|300|67.229115|2656|1117|0|0|

**PASS**: 150→300 heap 0.7620%; DOM 0.0000%. Completed 56 distinct threads, 42 native visits, 12 panel cycles, 12 palette cycles, 26 long-thread scrolls. Raw: `broad-soak.json`, `broad-visits.json`; snapshots in that directory’s ignored `raw/`.

### Delivered app source badff08464

One browser run, n=1 per checkpoint: raw values equal checkpoint medians.
| Navigation | Heap MiB | DOM | Listeners | Live xterm | Live WebGL |
|---:|---:|---:|---:|---:|---:|
|0|44.284157|1438|809|1|1|
|50|62.944592|2656|1115|0|0|
|150|66.150654|2656|1117|0|0|
|200|65.857342|2672|1117|0|0|
|300|66.789490|2656|1117|0|0|

**PASS**: 150→300 heap 0.9657%; DOM 0.0000%. Completed 56 distinct threads, 42 native visits, 12 panel cycles, 12 palette cycles, 26 long-thread scrolls. Raw: `final-soak/broad-soak.json`, `broad-visits.json`; snapshots in that directory’s ignored `raw/`.

The pre-change 150→300 snapshots add only 83,072 array bytes, 182,496 code bytes, 151,028 object bytes and 223,120 string bytes. Native self size adds 867,837 bytes; snapshot self sizes include native storage and are not JS heap usage. `retainer-paths.json` records two complete native retainer paths: lifecycle-observer hash backing → Window → NativeContext → ScriptState global handle → GC roots, and DOMTimer hash backing → DOMTimerCoordinator → Window supplement table → Window → NativeContext → ScriptState global handle → GC roots. The bounded search did not find root paths for the selected new arrays/context/string objects; no full attribution is claimed for the residual sub-1% growth. Stable later DOM/listener/live-terminal counts do not establish a full-day installed-app leak result. No speculative cache eviction was made.

Physical footprint: **not attributable / not collected**. Although the browser was dedicated, no renderer-PID-to-physical-footprint evidence was collected; no shared PID value is used.

Harness corrections before the successful soak: `.xterm` initially matched two transient elements (changed to `.first()`); a missing writer import was added; synthetic Escape did not close the palette (real Playwright Escape plus hidden assertion now does). Initial QA packet used an inconsistent not-required authentication label, corrected to `not_required`; passing gate is in `checks/qa-gate.log`.

## Checks and delivery limits

Run `pnpm install --frozen-lockfile` first; the noninteractive confirmation initially returned without installing, then CI=1 completed. No node_modules symlink. Production builds use Turbo and the serialized local wrapper because the actual local preview is required. Checks use remote-heavy on HSRPC; no full monorepo suite.

Full baseline app suite on unchanged source 5a160b645b: **FAIL** (not a clean candidate-suite PASS). Raw summary:
```text
Test Files  14 failed | 747 passed (761)
Tests  18 failed | 7810 passed | 25 skipped (7853)
```
Failure inventory and assertions: `checks/failed-files.json`, `checks/full-app-baseline.log`. These failures precede the scheduler patch; they include timeout paths, terminal repaint/replay and existing UI/math assertions. They were not silently reclassified as passes or edited outside scope.

Bundle: `checks/bundle-final.log`, unchanged caps, PASS. `verify.py doctor`: NOT VERIFIED by the repository completion-contract system; top finding is missing `.verify/config.json`. No contract requested or created. No visual/layout change, so no before/after screenshot claim. Browser runs use this app build and coordinator-served plugins, as requested.

Declined: speculative app-memory fixes without an accumulating product retainer, installed-app/day-long leak conclusions, footprint attribution without a renderer PID, unrelated baseline test/UI repairs, cap increases, settings, dependencies, flags and public APIs. No desktop app swap or install was requested.


## Final candidate checks

Developer persona, app source badff08464 (test typing/formatting finalized afterward; production source unchanged). Goal: defer only the home optional queue while preserving input, fallback, non-home boot, live reconciliation and reload behavior. New timing/cleanup regression: 4 added tests; boot-schedule file 9/9 PASS. Broader plugin-path command: 82 PASS / 1 timeout; the same boot timeout existed on the baseline. Isolating that file with --maxWorkers=1 passed 1/1 in 9.06 s, supporting import contention rather than a new scheduler failure. This does not convert the earlier failed full-suite run into a clean pass.

```text
@bb/app:test:  Test Files  1 failed | 7 passed (8)
@bb/app:test:       Tests  1 failed | 82 passed (83)
@bb/app:test:  Test Files  1 passed (1)
@bb/app:test:       Tests  1 passed (1)
 Tasks:    6 successful, 6 total
Bundle budget OK.
```

Typecheck: PASS, explicit server worker generation plus @bb/app#typecheck; raw 6 successful tasks in checks/final-checks.log. The initial combined filtered command forwarded plugin-frontend to typecheck and failed TS5042; corrected by separate typecheck and test commands. No TS errors remain in the corrected command. Commands: check-final.sh; isolated retry in checks/boot-isolated.log. Test-only tuple typing was changed to object rows before these checks.

Final source memory: +0.9657% heap, 0% DOM from 150 to 300. Final snapshot self-size deltas are in final-soak/heap-diff.json. Immediate retainers in final-soak/retainer-paths.json include WeakMap/Set backing tables, DOMTimerCoordinator and SoftNavigationPaintAttributionTracker backing tables, dataBase64 and timeline-key strings. The bounded search did not establish their full root chains; no complete leak attribution is claimed. Final memory journey deterministic gate: checks/qa-gate-final.log PASS. Final trace attribution medians and all raw per-run values: attribution-table.md and after/trace-summary.json.

Own localhost:16830 preview PID 85985 was identified through its listener and stopped after all measurements. Every dedicated browser closes in finally. No public shares are listed. Shared backend was left running untouched. No installation performed.
