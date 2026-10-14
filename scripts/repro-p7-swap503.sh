#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -z "${BB_ACCOUNT_POOL_PARENT_URL:-}" ]]; then
  printf '%s\n' 'BB_ACCOUNT_POOL_PARENT_URL must point at the configured local or approved account-pool parent.' >&2
  exit 2
fi

runtime_json="$(node --conditions=source --import tsx --input-type=module -e 'import { resolveCurrentDevInstanceConfig } from "@bb/config/runtime"; const c = resolveCurrentDevInstanceConfig(process.cwd()); console.log(JSON.stringify({ dataDir: c.dataDir, serverPort: c.ports.serverPort, hostDaemonPort: c.ports.hostDaemonPort }));')"
server_port="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).serverPort))' "$runtime_json")"
daemon_port="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).hostDaemonPort))' "$runtime_json")"
data_dir="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).dataDir)' "$runtime_json")"
server_url="http://127.0.0.1:${server_port}"
if [[ "$server_port" == 38886 || "$daemon_port" == 38886 ]]; then
  printf '%s\n' 'Refusing the live app ports.' >&2
  exit 2
fi
if [[ "$data_dir" == "$HOME/.bb" || "$data_dir" == "$HOME/.bb/"* ]]; then
  printf '%s\n' 'Refusing to use the live bb data directory.' >&2
  exit 2
fi

mkdir -p /tmp/p7-swap503
log_file="/tmp/p7-swap503/dev-stack.log"
pnpm start:worktree >"$log_file" 2>&1 &
stack_pid=$!
cleanup() {
  kill -INT "$stack_pid" 2>/dev/null || true
  wait "$stack_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=0
for attempt in $(seq 1 180); do
  if curl --silent --show-error --fail --max-time 2 "$server_url/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  printf '%s\n' 'The isolated dev server did not become healthy.' >&2
  exit 1
fi

project_json="$(BB_SERVER_URL="$server_url" pnpm bb:dev project create --name 'P7 swap503 reproduction' --root "$repo_root" --json)"
project_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$project_json")"
thread_json="$(BB_SERVER_URL="$server_url" pnpm bb:dev thread spawn --project "$project_id" --provider codex --prompt 'Run a shell command that waits for 45 seconds, then reply exactly: P7 turn survived. Do not change any files.' --json)"
thread_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$thread_json")"

active=0
for attempt in $(seq 1 120); do
  status_json="$(BB_SERVER_URL="$server_url" pnpm bb:dev thread show "$thread_id" --json)"
  status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).thread.status)' "$status_json")"
  if [[ "$status" == active ]]; then
    active=1
    break
  fi
  if [[ "$status" == error ]]; then
    printf '%s\n' 'The managed Codex turn failed before the restart.' >&2
    exit 1
  fi
  sleep 1
done
if [[ "$active" != 1 ]]; then
  printf '%s\n' 'The managed Codex turn did not become active.' >&2
  exit 1
fi

BB_SERVER_URL="$server_url" pnpm dev:restart-server

completed=0
for attempt in $(seq 1 360); do
  if curl --silent --show-error --fail --max-time 2 "$server_url/health" >/dev/null 2>&1; then
    status_json="$(BB_SERVER_URL="$server_url" pnpm bb:dev thread show "$thread_id" --json)"
    status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).thread.status)' "$status_json")"
    if [[ "$status" == idle ]]; then
      completed=1
      break
    fi
    if [[ "$status" == error ]]; then
      printf '%s\n' 'The managed Codex turn entered error during the restart.' >&2
      exit 1
    fi
  fi
  sleep 1
done
if [[ "$completed" != 1 ]]; then
  printf '%s\n' 'The managed Codex turn did not complete after the restart.' >&2
  exit 1
fi
if ! rg -q 'service hub did not stop within 5000ms' "$data_dir"/logs/server.*.log; then
  printf '%s\n' 'The turn completed, but the log did not prove a slow plugin stop.' >&2
  exit 1
fi

printf 'P7 swap503 passed: server=%s daemon=%s data=%s thread=%s\n' "$server_port" "$daemon_port" "$data_dir" "$thread_id"
