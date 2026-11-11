#!/usr/bin/env bash
set -euo pipefail
export CI=1
D=600
LOG=evidence-out/c17-pool-same-inject
PATCH="$LOG/inject-first-incomplete.patch"
SERVER=plugins/account-pool/src/server.ts
TEST=plugins/account-pool/src/server.test.ts
mkdir -p "$LOG"
cp "$SERVER" "$LOG/server.ts.bak"
cp "$TEST" "$LOG/pool-test-new.ts"
OLD_SNAPSHOT=scripts/c17-pool-test-old-snapshot.ts
if [[ -f "$OLD_SNAPSHOT" ]]; then
  cp "$OLD_SNAPSHOT" "$LOG/pool-test-old.ts"
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git show 9199020bc6:plugins/account-pool/src/server.test.ts >"$LOG/pool-test-old.ts"
else
  echo "missing $OLD_SNAPSHOT and no git for old pool test" >&2
  exit 1
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
cp "$LOG/pool-test-old.ts" "$TEST"
pnpm exec turbo run test --filter=bb-plugin-account-pool -- --testNamePattern "logs deferred progress" >"$LOG/pool-delay-red.log" 2>&1 || true
grep -q " FAIL " "$LOG/pool-delay-red.log" && echo OLD_FAIL_OK | tee "$LOG/red.status" || { echo OLD_UNEXPECTED; exit 1; }
apply_inject
cp "$LOG/pool-test-new.ts" "$TEST"
pnpm exec turbo run test --filter=bb-plugin-account-pool -- --testNamePattern "logs deferred progress" --testTimeout 120000 >"$LOG/pool-delay-green.log" 2>&1 || true
if grep -q '1 passed' "$LOG/pool-delay-green.log" &&
  ! grep -qE 'Tests.*[0-9]+ failed|Test Files.*failed' "$LOG/pool-delay-green.log"; then
  echo GREEN_PASS_OK | tee "$LOG/green.status"
else
  echo GREEN_FAIL | tee "$LOG/green.status"
  cp "$LOG/server.ts.bak" "$SERVER"
  cp "$LOG/pool-test-new.ts" "$TEST"
  exit 1
fi
cp "$LOG/server.ts.bak" "$SERVER"
cp "$LOG/pool-test-new.ts" "$TEST"
