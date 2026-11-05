# Round 5 slice A — performance

Serves: P1, P3. Branch: `feat/ui-polish-perf-r5`. Product source commit: `8e616a15e61fec57da8c5aef6680c50287dc8c80`. Control app: round-4 `89ec8e7f9e` on port 16800. No PR, merge, installation, or other branch push. `pnpm install --frozen-lockfile` ran first in this worktree; no `node_modules` symlink was created.

Persona: developer using the owner's read-only seeded workspace. Target: own production preview `http://127.0.0.1:16820`, proxying the untouched API/WebSocket server on 24706. BB isolated browser, owned target `269F876CEB09E6AEFD0AAAA289FD157B`, 1280×800. No submission, thread creation/deletion, terminal typing, shared plugin edit, or server restart. The canonical supplied Playwright probes are assigned to the coordinator, who explicitly accepted adapted BB-browser diagnostics for this slice.

## First transaction

Read round 4's `council/r4-slices/perf/REPORT.md` first. Its parent composer/history fixes are preserved. This change removes a different source of work: Tiptap 3.26's Placeholder plugin installs a viewport tracker that computes geometry at initialization and schedules another measurement whenever document size changes. Its scheduler starts with `lastCompute=0`, so the first edited frame immediately measures and may dispatch a metadata transaction. Later input can be throttled to the 150 ms interval. The composer configures `showOnlyCurrent=true` and `includeChildren=false`; the decoration builder's resolved-current-node path does not consume viewport state at all.

The private `CurrentNodePlaceholder` retains upstream decoration props and omits its unused viewport state/view. Placeholder text, empty-editor class, current paragraph behavior, deletion, and read-only handling remain owned by the upstream decoration callback. No idle transaction, user-text insertion, new setting, flag, dependency, API, or comment was added. The regression checks geometry is never requested while initializing, typing, and deleting; it fails on the unchanged round-4 extension and passes on the candidate.

### Plugin preview method

Built this worktree's composer through `buildPluginApp` using the existing toolchain and `NODE_OPTIONS=--conditions=source node --import tsx r5-slices/perf/build-plugin.mjs`. The source condition resolves SDK source without requiring its missing local dist build. The first attempt without that condition failed with `Cannot find module .../plugin-sdk/dist/app.js`; no dependency or shared checkout was changed.

Started own Vite preview using `r5-slices/perf/preview.config.mjs`. Its middleware substitutes only `/api/v1/plugin-app-assets/b8008bfe471efeaf/app.js` and `app.css` with this worktree's `plugins/composer/dist/` files before API proxying. Both local JS and HTTP response SHA-256: `fa37c4e700ac9f395589649dfa7d13d538ea40e21a1b043eb36c740f5211f7b4`. Control 16800 continues using the backend's original composer. The coordinator's worktree and the shared plugin files were never edited.

### Interleaved measurements

`ab.mjs`: six pairs per probe, alternating AB/BA by pair. Before each run, remove only the browser-local new-thread draft, reload, and assert an empty editor. Focus through the certified adapter, wait 40 ms for adapter-ready or 3 seconds for settled, then press one `a` through the adapter. CDP sampling interval 100 µs. Summarize sampled function self time in keydown through +50 ms; report `(program)`, idle, and GC separately. Tiny negative profiler timing corrections are clamped to zero for sample attribution. Task wall and task thread CPU sum main-thread RunTask records starting between keydown−2 ms and keydown+48 ms. Nested event durations are not added again.

Results: [A/B table](ab-table.md), every run/top-ten function attribution in [ab.json](ab.json), raw profiles/traces under ignored `raw/perf-r5-ab/`. JavaScript sampled self time is not task wall duration or RunTask `tdur`.

**Verdict: no established JavaScript CPU improvement.** Ready task-wall median 12.642→12.590 ms; settled 13.043→12.014 ms. Ready JS self median 4.726→4.915 ms; settled 5.013→5.046 ms. Both controls and candidates are below 16 ms under this method. This does not establish the original canonical target: BB adapter round trips delay the early key beyond the supplied probe's first-visible boundary, its browser includes a React DevTools hook, and its settled wait differs from capture's network-idle sequence. The coordinator owns canonical `early-input.mjs`/`capture.mjs` integration A/B. No wall-time result is presented as a CPU gain.

The profiles retain editor DOM/state updates, React work, and browser selection/geometry work. They do not establish a lazy schema compilation as the remaining bottleneck. Removing viewport tracking is a proved elimination of unnecessary work; a claim that it solves the complete ~31 ms canonical first-key path would exceed this evidence.

## Long-session renderer memory

The initial supplemental walk completed 300 navigations and 42 native-terminal visits. [Initial series](soak-shared-plugin-table.md) uses this worktree's app build with the shared round-4 composer. It used Cmd+K instead of the actual Cmd+Shift+P palette shortcut. An input audit also found the shared `council/threads.json` had only seven entries, despite taking a slice of up to 60. The initial and next candidate walks therefore visited only eight distinct threads, not the initially claimed 50+. Neither establishes the complete requested journey. Their data is retained separately, not substituted for the final broad-coverage walk.

Initial heap: 92.43 MiB at native entry, 106.88 at 50 navigations, 113.96 at 100, 126.89 at 250, 130.78 at 300. DOM/listeners vary with active view. A late chat snapshot contains zero xterm wrappers. This increase alone does not prove either unbounded retention or bounded warmup. Snapshot summaries and the corrected candidate series provide the follow-up evidence.

Every physical-footprint value in the series is **shared-process, PID 67005, potentially including slice B's page**. This renderer was identified from this page's input trace, but exclusive process ownership is not established. Do not attribute its footprint to this preview alone or compare it directly with the installed app's day-long 1.5 GB figure. Heap/DOM diagnostics are issued on this slice's own CDP session. Raw footprint output is retained beside the tables.

The corrected candidate uses Cmd+Shift+P and asserts the command palette appeared and closed, along with right-panel open/close assertions. It uses SPA navigation without reload, forces GC twice every 25 navigations, and samples CDP `Runtime.getHeapUsage` and `Memory.getDOMCounters`. Live xterm counts use `Runtime.queryObjects` against the actual current app-bundle terminal prototype; WebGL counts query context prototypes and exclude lost contexts. Query handles are released after each count.

**Attribution correction:** no enabled plugin bundle matched the xterm wrapper fields. The actual bundle is app asset `assets/xterm-CLyyFzQe.js`, containing `_core`, `_addonManager`, and `_publicOptions`. The earlier “plugin-bundled xterm prototype” description was incorrect. `raw/candidate-0.heapsnapshot` has four wrapper-shaped instances across the broader V8 snapshot; only one is queryable through this page's current xterm prototype at native entry. These are different scopes, not four proven retained instances belonging to a plugin. [Initial snapshot summary](candidate-heap-0.json), [plugin bundle scan](xterm-bundle-owners.json).

The candidate zero footprint was sampled during a heap snapshot (1,435 MB, shared PID, may include B, snapshot-inflated) and is explicitly discarded in `footprint-candidate-0-during-snapshot-DISCARD.txt`. `candidate-0b` is from an earlier incomplete attempt, not a substitute zero for the final run. All later footprints are sampled by the coordinator's approved read-only `/usr/bin/footprint -p 67005` watcher after a checkpoint request. Snapshot overhead can persist into later samples, so even a large footprint cannot establish a preview leak. Local footprint access was refused: `Unable to configure physical footprint data collection: Operation not permitted`; the coordinator's sampler is the separately authorized collection route.

The limited-coverage candidate completed 300 navigations, 42 native visits, 12 panel/palette cycles and 26 long-thread scrolls. Its [series](candidate-soak-table.md) fell from 309.01 to 136.85 MiB. Snapshot wrapper counts were 4→1→0 at 0/150/300; total snapshot self sizes were 428.97→301.45→178.86 MiB, including native allocations. This supports release of prior contexts during the walk, but cannot replace the requested broad thread coverage.

For the final walk, fetched `/api/v1/threads?limit=80` read-only and retained 60 unique non-native thread IDs in [seeded-chat-ids.json](seeded-chat-ids.json). The harness refuses fewer than 60 unique input IDs. The deterministic 300-navigation [sequence](broad-sequence.json) covers 56 distinct threads, including the long chat and native terminal. Every navigation records mounted chat rows or a mounted terminal in [broad-visits.json](broad-visits.json); each checkpoint records actual distinct counts. It refuses fewer than 50 distinct completed visits or fewer than 40 native visits. Footprint sampling precedes the 150/300 snapshots, with a six-second collection window; initial snapshot overhead can still persist.

### Final broad-coverage result

**Measurement journey PASS** for the developer persona on source `8e616a15e61fec57da8c5aef6680c50287dc8c80` at 16820: 300 completed navigations, 56 distinct threads, 42 native-terminal visits, 12 secondary-panel cycles, 12 command-palette cycles and 26 long-thread scroll cycles. [Full checkpoint table](broad-soak-table.md), [summary](broad-summary.json), [snapshot table](snapshot-table.md), [visit-by-visit evidence](broad-visits.json). The deterministic QA gate passes for this read-only measurement journey only (`checks/qa-measurement-gate.log`); its private packet is under ignored `raw/`. The first gate attempt had packet-label mismatches, corrected without rerunning or changing the observed journey; its failure log is retained.

Heap after forced GC: 121.90 MiB initially, 141.29 at 50 navigations, 149.01 at 150, 151.73 at 200, and 159.59 at 300. It grew by 37.69 MiB; this is **not a flat-heap result**. DOM nodes were 3,624 initially, 4,853 at 150 and 4,911 at 300; listeners were 1,808, 2,120 and 2,139. Connected chat elements were exactly 1,925 at those later long-chat checkpoints. Live xterm/WebGL were 1/1 at native checkpoints and 0/0 at all chat checkpoints. Snapshot wrapper counts were 2→0→0 at 0/150/300. No accumulating terminal/context chain was found.

Physical footprint ranged from 647 to 744 MB (**shared PID 67005, may include slice B, snapshot overhead possible**). Every number in the checkpoint table repeats that caveat. The 150/300 footprint outputs were written before their respective snapshot files were created; the final ordering is retained in `checks/footprint-snapshot-order.log`. The snapshot peak from earlier instrumentation remains in raw footprint output and is not a product peak. This does not reproduce or disprove the installed app's day-long 1.5 GB footprint.

### Growing array retainer: browser instrumentation

Snapshot comparison found array self-size growth of 18.59 MiB, compiled-code growth of 11.91 MiB, generic-object growth of 2.44 MiB, and native self-size reduction of 4.15 MiB. These are snapshot self sizes, including native allocations, not `Runtime.getHeapUsage` values.

The eight largest array nodes in `raw/broad-300.heapsnapshot` all trace through the injected React DevTools `rendererInterfaces` machinery. [Eight retainer paths](broad-array-paths.json) are committed; the full incoming-edge graph remains local at `raw/broad-array-retainers.json`. In particular, operation batches are retained by array root **#3592539**, through context variable **`Lt`**, then the renderer interface's `cleanup`/`clearErrorsAndWarnings` closures and the hook's `rendererInterfaces` map. This is React Developer Tools **8.0.0** from BB's isolated Chrome profile, `build/installHook.js`; the [source digest and short excerpts](devtools-source.json) confirm that operations use `Lt.push(...)` until `flushInitialOperations` sets `Lt=null` and emits the queued batches.

| Snapshot | Growing DevTools queue entries | Queue array storage bytes | Other DevTools queue entries |
|---:|---:|---:|---:|
| 0 | 14 | 270,388 | 2,162 |
| 150 | 1,043 | 9,519,604 | 2,162 |
| 300 | 1,952 | 18,600,908 | 2,162 |

[Queue summaries](devtools-queues-300.json) count only array objects and their backing stores, not arbitrary reachable application data. The growing queue adds **17.48 MiB**, approximately **94% of total array growth**. The other queue, root #862417, remains at 20,041,728 array-storage bytes. The snapshots expose more than one hook/context; these measurements do not assign the other queue to this page. This establishes a growing **instrumentation** retainer and prevents treating the raw heap slope as an application leak. It does not establish that every remaining allocation is bounded.

No product memory-lifecycle change is included: terminal wrappers are released, and no unbounded product retainer was established. Existing source caps touched timeline/bootstrap caches at 20 threads. Editing the third-party browser extension or BB browser tooling is outside this slice, and the coordinator's final instruction was to finish from saved snapshots without further live measurement. The canonical headless probes have a different instrumentation environment. **Installed-app leak: NOT REPRODUCED; product boundedness over a full day: NOT VERIFIED.**

## Checks

Developer persona; source target `8e616a15e61fec57da8c5aef6680c50287dc8c80`. Goal: preserve editing/placeholder behavior while removing unused geometry work. Focused regression PASS; full plugin tests/typecheck PASS. Remote-heavy Linux ran tests/typechecks; own local production build supplied the localhost preview.

```text
bb-plugin-bb--composer:test:  Test Files  1 failed (1)
bb-plugin-bb--composer:test:       Tests  1 failed | 1 passed (2)
bb-plugin-bb--composer:test:  Test Files  1 passed (1)
bb-plugin-bb--composer:test:       Tests  2 passed (2)
bb-plugin-bb--composer:test:  Test Files  14 passed | 1 skipped (15)
bb-plugin-bb--composer:test:       Tests  113 passed | 3 skipped (116)
 Tasks:    8 successful, 8 total
 Tasks:    6 successful, 6 total
@bb/app:test:  Test Files  2 failed | 756 passed (758)
@bb/app:test:       Tests  2 failed | 7809 passed | 25 skipped (7836)
@bb/app:test:  Test Files  2 passed (2)
@bb/app:test:       Tests  24 passed (24)
 Tasks:    5 successful, 5 total
Bundle budget OK.
```

Logs: [checks/](checks/). The full app run was on unchanged round-4 app sources and overlapped other builds. The terminal viewport test timed out at 30 seconds; terminal repaint expected 40 columns but observed 39. The coordinator reran both files on clean unchanged `89ec8e7f9e`: 24/24 passed (`council/r5-two-tests.log`, copied into `checks/coordinator-terminal-rerun.log`). Treat these as observed load-sensitive failures, not a clean full-suite PASS and not a proved product regression caused by this plugin change.

App typecheck's first invocation omitted the explicit cross-package worker dependency and failed on `terminal-screen-worker.js`. Corrected command: `remote-heavy.sh "$PWD" pnpm exec turbo run @bb/server#generate:terminal-screen-worker @bb/app#typecheck`, which passed. Composer command: `remote-heavy.sh "$PWD" pnpm exec turbo run test typecheck --filter=bb-plugin-bb--composer`. No full monorepo suite ran.

`verify.py doctor`: **NOT VERIFIED** by the repository completion-contract system; highest finding is missing `.verify/config.json`. No contract was requested or created. No layout change was made; no visual before/after claim. Browser screenshots are not a substitute for CPU or memory evidence.

## Scope and delivery limits

- Product files: `plugins/composer/src/editor/prompt-editor-extensions.ts`, `plugins/composer/src/editor/prompt-editor-placeholder.test.ts`.
- Evidence/harness files: `r5-slices/perf/`; raw snapshots/profiles remain ignored in `raw/` to avoid committing large heaps.
- Declined: new public API, settings, flags, dependencies, speculative cache eviction, installed-app changes, and unrelated terminal-test edits. None are required to remove unused placeholder viewport work.
- Declined: changing React DevTools or browser tooling to flush/disable its growing operation queue; outside the permitted product slice. No further soak was started after the coordinator announced the shared-server restart.
- Canonical first-key target and a day-long installed-app leak remain separate outcomes; this report does not infer them from unit tests, heap size, or shared-process footprint.

Own preview 16820 and the thread-owned BB browser page were stopped after the final sample. All task-owned soak/watch processes completed. Shared backend was left untouched by this slice. `bb connect shares` reports no shared ports. Raw heaps/profiles remain local under ignored `raw/`; committed summaries and retainer paths carry the review evidence.
