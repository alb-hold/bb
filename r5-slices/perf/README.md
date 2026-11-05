# Round 5 performance probes

Run from this worktree with exactly one BB browser instance owned by this thread. `diagnostics.mjs` pins the observed CDP target. Confirm ownership with `bb isolated-browser status` before adjusting it. Interaction uses the adapter and its input certificate; direct CDP is diagnostic only.

- `build-plugin.mjs`: build this worktree's composer with `NODE_OPTIONS=--conditions=source node --import tsx` and the existing plugin builder.
- `preview.config.mjs`: serve app on 16820 against the seeded backend, overriding only the observed composer JS/CSS asset URL with local build files.
- `ab.mjs`: six alternating pairs per probe; clear only browser-local new-thread draft, reload, assert empty, press one `a`. Profile JavaScript self time separately from task wall/thread CPU. Adapter-ready timing differs from the canonical early-input probe.
- `broad-soak.mjs`: final 300 SPA navigations from 60 unique API-selected chat IDs plus long/native threads; native every seventh navigation. Assert mounted content, actual distinct coverage, panel/palette open-close with Cmd+Shift+P and long-thread scrolling. Force GC every 25; count live xterm by the app-bundled `assets/xterm-CLyyFzQe.js` prototype and non-lost WebGL contexts. Release remote handles. Snapshot at 0, 150, 300. The coordinator samples footprint from `footprint-requests.txt`; every value may include slice B and snapshot overhead.
- `candidate-soak.mjs`: earlier 300-navigation walk with correct panel/palette assertions but only seven source IDs. Incomplete distinct-thread coverage; retained as supplemental evidence.
- `soak.mjs`: supplemental initial walk using shared plugins. Its palette shortcut was incorrect, so it does not establish the complete journey.
- `heap-summary.py`, `tables.py`: derive snapshot summaries and measurement tables.
- `heap-retainers.py`, `retainer-paths.py`, `devtools-queues.py`: trace the eight largest arrays back to React DevTools and quantify its growing pending-operation queue from saved snapshots. Queue IDs come from the recorded retainer paths.
- `finalize-evidence.py`: assert completed coverage and derive the summary, snapshot table, and private measurement-journey packet. Run the deterministic QA gate on that packet before reporting the journey complete.

Large raw snapshots/traces are ignored under `raw/`; summaries and check logs are committed. Original A/B JSON paths under `/tmp/perf-r5-ab` were copied to `raw/perf-r5-ab/` before the midnight sweep.
