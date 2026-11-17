# Antigravity CLI (`agy`) pooling map

Date: 2026-11-17. Read-only research (web search plus curl of public pages). Nothing was installed or run, no sign-in done. Claims below are tagged OFFICIAL (Google staff text), COMMUNITY (third-party write-up) or UNVERIFIED.

## Verdict: STOP. Pooling is forbidden by Google, and agy cannot be redirected per account

Two of root's stop conditions are met.

### 1. Terms forbid pooling (OFFICIAL, Google staff)
Google AI Developers Forum, Google staff reply (Ambati_Rajendra, 2026-09-28) to a user asking whether an orchestrator may rotate several paid AI Pro accounts through the official `agy` binary:
> "No, this is not allowed. ... using an orchestrator to cycle through multiple Google AI Pro accounts to bypass quota limits, pool capacity, or distribute tasks is a direct violation of the Terms of Service. ... Multiplexing 15 accounts in an automated fashion will trigger abuse detection and result in permanent suspensions across those accounts."
The supported route for scaled use is the Gemini Developer API or Vertex AI.
Source: https://discuss.ai.google.dev/t/one-person-several-paid-google-ai-pro-accounts-may-a-local-orchestrator-use-them-with-the-official-agy-cli/185460
Context (COMMUNITY, unverified): reports of suspensions for proxying the Antigravity backend for third-party products; accounts can lose more than Antigravity. The Antigravity terms page itself (antigravity.google/terms) was not read in full.
That reply addresses AI Pro. I found no Google text that exempts Ultra. Rotating accounts on quota is the exact case (b) it names.

### 2. agy cannot be redirected per account (COMMUNITY)
Source: https://agentsroom.dev/blog/multiple-accounts-antigravity-cli (2026-08-24; cites open agy repo issues #155 and #381, not independently opened).
- agy stores one Google credential in the OS keyring (macOS Keychain, service `gemini`, account `antigravity`), a single machine-wide slot.
- No `--profile`, `--auth-store`, `--data-dir`, and no env var relocates it. Account switchers rewrite the keyring entry for the whole machine.
- The only per-process credential is a Gemini API key from the environment (`GEMINI_API_KEY`). That is billed API use, not the Ultra subscription.
- Another search result mentions a `GOOGLE_GEMINI_BASE_URL` override (UNVERIFIED, single source). Even if real, it applies to API-key mode, not subscription sign-in.
- A Linux token file `~/.gemini/antigravity-cli/antigravity-oauth-token` is reported by one source (UNVERIFIED).

## Questions root asked
- **Install:** official installer script `curl -fsSL https://antigravity.google/cli/install.sh | bash` (COMMUNITY, several guides). Go binary. One guide lists npm `@google/antigravity-cli`, another says no npm or Homebrew package exists: conflict, UNVERIFIED.
- **ACP:** a separate official runtime exists in the ACP registry (https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json). `agy_acp_server.par` / `.exe` plus a `localharness_external` helper. It is a separate download and sign-in from the CLI and IDE (acpx docs, https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md, read in full).
- **Credentials (ACP runtime):** profile rooted at `GEMINI_HOME` (default `~/.gemini`), `<GEMINI_HOME>/antigravity-acp/settings.json` with `{"auth":{"type":"oauth-personal"}}`; macOS keychain unless `AGY_ACP_FORCE_FILE_STORAGE=1` selects a profile-local file (acpx docs). So the ACP server, unlike the CLI, can isolate a home per account. Google terms still forbid pooling accounts through it. A forum thread titled "Parallel Antigravity ACP Sessions Across Multiple Paid AI Pro Accounts" exists (2026-11-16); its answer was not read.
- **Endpoint:** not established. No source found naming the API host or a hub-redirect env var for subscription auth. Unknown whether cloudcode-pa v1internal is still used.
- **Project / tier rule, quota call, out-of-quota signal:** not established from sources. Not researched further since the stop condition is met.
- **Reuse of #508:** nothing should be built. If Google ever permits it, the hub, token model, rollback-safe storage and 429 allowlist (`QUOTA_EXHAUSTED`, `RATE_LIMIT_EXCEEDED`) are provider-neutral, but the Code Assist wire rewrite (`project`, `cloudaicompanionProject`) would need re-deriving against the new API.

## Supported alternatives (owner decision, not mine)
- Gemini Developer API or Vertex AI keys per workload (Google's stated route).
- Fewer, higher-tier single accounts used directly and interactively, without rotation.
- Shift load to the Claude/Codex pools already built.

## Not done
No sign-in, no install, no agy run, no network traffic through any hub. #508 untouched (draft, head 8fae9a30, NOT VERIFIED).
