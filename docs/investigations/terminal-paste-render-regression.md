# Mobile terminal interface rollback

## Report

On 2026-10-15, the owner reported that phone users could no longer paste images or attach files in native terminal threads, that the terminal rendered chat or timeline content over its surface after input blur, and that a padded gap stayed fixed while scrolling. The requested rollback targets the two recent mobile terminal changes while preserving later terminal behavior.

## Change and evidence

This branch reverts #206 (`7a45943df`, deferred hidden rendering and resize work) followed by #205 (`ba0d16c89`, mobile terminal controls), on top of `ours` at `b78961878`. The reversions were applied in that order. Conflicts from #206 were resolved to remove its deferred rendering path while retaining the later `TerminalAttentionPane` wrapper from #212. The #205 revert applied cleanly.

The owner changed the priority from root-cause bisect to an urgent rollback. This investigation therefore does not claim that either commit is the first bad commit, and does not bisect unrelated terminal changes unless a symptom remains after the rollback. The requested remaining work is a phone-width before/after workflow walk and exact-head CI. Test and workflow results will be recorded with the PR evidence.

## Observed phone interaction obstruction

At `af1713b86` in a 390×844 phone viewport, the `Message Codex` prompt measured x=60, y=790, 270×46, while the 390×53 controls bar measured x=0, y=791. A click on the prompt was refused because the hit test landed on `button[aria-label=Control for next key]`. Terminal content measured y=56–728, leaving 63 px before the controls bar at y=791; the bar overlapped the prompt. This is direct evidence that the prompt's paste/attach controls were unreachable by touch. Uploading a fixture to the hidden image input showed an attachment chip, but does not prove the visible attach button or clipboard path works.

At rollback head `fa99ac2fd`, in the same HSRPC stack and viewport, terminal content measured y=56–714, the controls bar y=728–781, and the prompt y=790–836. A tap on the prompt succeeded, and a tap on the visible attach button succeeded; uploading the same fixture showed its attachment chip. The space between content and controls measured 14 px, the bar did not cover the prompt, and content ended above the bar. Focusing the terminal and then tapping the prompt left a snapshot containing one native terminal pane with `Reconnecting…`, controls, and the message prompt; no chat text appeared over it. Earlier local rollback evidence also showed only the terminal surface after blur.

The remaining requested phone checks are incomplete. The isolated browser tools expose no page-evaluation or clipboard-dispatch method, so neither real clipboard paste nor the requested synthetic `ClipboardEvent` was run. The native Codex session exited with code 2; restarting showed `Reconnecting…`, so no 20-second stand-in stream/redraw or mid-stream snapshot was produced. The baseline had no scrollable terminal output; no scroll gesture was performed. Thus the overlap and spacing are measured at both revisions, but paste, streaming redraw, and scroll behavior are not full-workflow PASS claims.

## Reland

Reland of mobile terminal controls belongs in a separate change after the layout, blur, overlay, paste, and scroll-gap behavior is corrected and verified. The controls should not be hidden behind a feature flag.
