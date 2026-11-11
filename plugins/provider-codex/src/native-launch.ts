// Flags placed first on every native Codex launch (`bb thread native`).
//
// `check_for_update_on_startup=false`: when a newer Codex release exists, the
// CLI otherwise opens a blocking "Update available" picker before the session
// screen. A native thread usually runs with no viewer attached, so nothing
// answers it: a resumed session sits there indefinitely, and `bb thread tell`
// fails because the input box never appears (2026-11-10, Codex 0.166.0 ->
// 0.167.0). Set per launch so it holds on every host, whatever that host's
// ~/.codex/config.toml says.
export const CODEX_NATIVE_LAUNCH_ARGS: readonly string[] = [
  "--no-daemon",
  "--dangerously-bypass-approvals-and-sandbox",
  "--no-alt-screen",
  "-c",
  "check_for_update_on_startup=false",
];
