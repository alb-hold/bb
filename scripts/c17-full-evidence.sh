#!/usr/bin/env bash
set -euo pipefail
export CI=1
D=600
LOG=evidence-out/c17-bundle
PATCH="$LOG/inject-first-incomplete.patch"
SERVER=plugins/account-pool/src/server.ts
TEST=plugins/account-pool/src/server.test.ts
OLD_SNAPSHOT=scripts/c17-pool-test-old-snapshot.ts
mkdir -p "$LOG"
cp "$SERVER" "$LOG/server.ts.bak"
cp "$TEST" "$LOG/pool-test-new.ts"
if [[ -f "$OLD_SNAPSHOT" ]]; then
  cp "$OLD_SNAPSHOT" "$LOG/pool-test-old.ts"
else
  git show 9199020bc6:"$TEST" >"$LOG/pool-test-old.ts"
fi
apply_inject() {
  cp "$LOG/server.ts.bak" "$SERVER"
  perl -i -pe 's/let complete = startupComplete;/let complete = startupComplete;\n    let c17DelayArmed = false;/' "$SERVER"
  perl -i -0pe "s/(complete = await sweepThreadCredentialsOnce\(signal\);)/\$1\n        if (!complete && !c17DelayArmed) {\n          c17DelayArmed = true;\n          await new Promise<void>((resolve) => { const doneAt = Date.now() + $D; const step = () => (Date.now() >= doneAt ? resolve() : setImmediate(step)); step(); });\n        }/s" "$SERVER"
}
apply_inject
diff -u "$LOG/server.ts.bak" "$SERVER" >"$PATCH" || true
sha256sum "$PATCH" | tee "$LOG/inject.sha256"
{
  echo "IDENTICAL_INJECT=first_incomplete_sweep_one_shot_600ms_real_spin"
  echo "PATCH_PATH=$PATCH"
  echo "INJECT_SHA256=$(sha256sum "$PATCH" | awk '{print $1}')"
} | tee "$LOG/patch-meta.txt"

run_deferred() {
  pnpm exec turbo run test --filter=bb-plugin-account-pool -- --testNamePattern "logs deferred progress" --testTimeout 120000 >"$1" 2>&1 || true
}

cp "$LOG/pool-test-old.ts" "$TEST"
run_deferred "$LOG/pool-delay-red.log"
grep -q " FAIL " "$LOG/pool-delay-red.log" && echo OLD_FAIL_OK | tee "$LOG/red.status" || {
  echo OLD_UNEXPECTED | tee "$LOG/red.status"
  exit 1
}

apply_inject
cp "$LOG/pool-test-new.ts" "$TEST"
run_deferred "$LOG/pool-delay-green.log"
if grep -q '1 passed' "$LOG/pool-delay-green.log" &&
  ! grep -qE 'Tests.*[0-9]+ failed|Test Files.*failed' "$LOG/pool-delay-green.log"; then
  echo GREEN_PASS_OK | tee "$LOG/green.status"
else
  echo GREEN_FAIL | tee "$LOG/green.status"
  exit 1
fi

cp "$LOG/server.ts.bak" "$SERVER"
cp "$LOG/pool-test-new.ts" "$TEST"
run_deferred "$LOG/pool-nodelay-green.log"
if grep -q '1 passed' "$LOG/pool-nodelay-green.log" &&
  ! grep -qE 'Tests.*[0-9]+ failed|Test Files.*failed' "$LOG/pool-nodelay-green.log"; then
  echo NODELAY_PASS_OK | tee "$LOG/nodelay.status"
else
  echo NODELAY_FAIL | tee "$LOG/nodelay.status"
  exit 1
fi

cp "$LOG/pool-test-new.ts" "$LOG/pool-mutation-retry0.ts"
perl -i -pe 's/threadSweepRetryMs: 40,/threadSweepRetryMs: 0,/' "$LOG/pool-mutation-retry0.ts"
apply_inject
cp "$LOG/pool-mutation-retry0.ts" "$TEST"
run_deferred "$LOG/pool-mutation-retry0.log"
grep -q " FAIL " "$LOG/pool-mutation-retry0.log" && echo MUTATION_RETRY0_FAIL_OK | tee "$LOG/mutation-retry0.status" || {
  echo MUTATION_RETRY0_UNEXPECTED | tee "$LOG/mutation-retry0.status"
  exit 1
}

cp "$LOG/pool-test-new.ts" "$LOG/pool-mutation-fallback-skip.ts"
perl -0777 -i -pe 's/\n    await whenSetTimeoutDelayAfter\(\n      40,\n      retryTimersBeforeSecondDeferred,\n      fortyMsTimersBeforeSecondDeferred,\n    \);\n    expect\(\n      timers\.mock\.calls\.filter\(\(\[, ms\]\) => ms === 40\)\.length,\n    \)\.toBeGreaterThan\(fortyMsTimersBeforeSecondDeferred\);\n//s' "$LOG/pool-mutation-fallback-skip.ts"
apply_inject
cp "$LOG/pool-mutation-fallback-skip.ts" "$TEST"
run_deferred "$LOG/pool-mutation-fallback-skip.log"
grep -q " FAIL " "$LOG/pool-mutation-fallback-skip.log" && echo MUTATION_FALLBACK_SKIP_FAIL_OK | tee "$LOG/mutation-fallback-skip.status" || {
  echo MUTATION_FALLBACK_SKIP_UNEXPECTED | tee "$LOG/mutation-fallback-skip.status"
  exit 1
}

cp "$LOG/pool-test-new.ts" "$LOG/pool-mutation-retry1000.ts"
perl -i -pe 's/threadSweepRetryMs: 40,/threadSweepRetryMs: 1000,/' "$LOG/pool-mutation-retry1000.ts"
apply_inject
cp "$LOG/pool-mutation-retry1000.ts" "$TEST"
run_deferred "$LOG/pool-mutation-retry1000.log"
grep -q " FAIL " "$LOG/pool-mutation-retry1000.log" && echo MUTATION_RETRY1000_FAIL_OK | tee "$LOG/mutation-retry1000.status" || {
  echo MUTATION_RETRY1000_UNEXPECTED | tee "$LOG/mutation-retry1000.status"
  exit 1
}

cp "$LOG/server.ts.bak" "$SERVER"
cp "$LOG/pool-test-new.ts" "$TEST"
pnpm exec turbo run test --filter=bb-plugin-account-pool -- src/server.test.ts >"$LOG/pool-focused-file.log" 2>&1 || true
if grep -q 'Tests.*failed' "$LOG/pool-focused-file.log" && grep -qE 'Tests.*[0-9]+ failed' "$LOG/pool-focused-file.log"; then
  grep -E 'Tests.*failed' "$LOG/pool-focused-file.log" | grep -qv '0 failed' && {
    echo FOCUSED_FILE_FAIL | tee "$LOG/focused-file.status"
    exit 1
  }
fi
grep -q 'passed' "$LOG/pool-focused-file.log" && echo FOCUSED_FILE_PASS_OK | tee "$LOG/focused-file.status"

git diff >"$LOG/test.diff" || true
cp "$SERVER" "$LOG/server.injected.ts" 2>/dev/null || true
apply_inject
cp "$SERVER" "$LOG/server.injected.ts"
cp "$LOG/server.ts.bak" "$SERVER"
cp "$LOG/pool-test-new.ts" "$TEST"

cat "$LOG"/*.status 2>/dev/null || true
