# Mobile terminal interface rollback

## Report

On 2026-10-15, the owner reported that phone users could no longer paste images or attach files in native terminal threads, that the terminal rendered chat or timeline content over its surface after input blur, and that a padded gap stayed fixed while scrolling. The requested rollback targets the two recent mobile terminal changes while preserving later terminal behavior.

## Change and evidence

This branch reverts #206 (`7a45943df`, deferred hidden rendering and resize work) followed by #205 (`ba0d16c89`, mobile terminal controls), on top of `ours` at `b78961878`. The reversions were applied in that order. Conflicts from #206 were resolved to remove its deferred rendering path while retaining the later `TerminalAttentionPane` wrapper from #212. The #205 revert applied cleanly.

The owner changed the priority from root-cause bisect to an urgent rollback. This investigation therefore does not claim that either commit is the first bad commit, and does not bisect unrelated terminal changes unless a symptom remains after the rollback. The requested remaining work is a phone-width before/after workflow walk and exact-head CI. Test and workflow results will be recorded with the PR evidence.

## Reland

Reland of mobile terminal controls belongs in a separate change after the layout, blur, overlay, paste, and scroll-gap behavior is corrected and verified. The controls should not be hidden behind a feature flag.
