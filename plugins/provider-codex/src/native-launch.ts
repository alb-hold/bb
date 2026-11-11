export const CODEX_NATIVE_LAUNCH_ARGS: readonly string[] = [
  "--no-daemon",
  "--dangerously-bypass-approvals-and-sandbox",
  "--no-alt-screen",
  "-c",
  "check_for_update_on_startup=false",
];
