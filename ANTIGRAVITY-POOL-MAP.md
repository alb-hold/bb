# Antigravity CLI (`agy`) pooling map

Date: 2026-11-17. Read-only research (web search plus curl of public pages). Nothing was installed or run, no sign-in done. Claims below are tagged OFFICIAL (Google staff text), COMMUNITY (third-party write-up) or UNVERIFIED.

## Step 1 (2026-11-17, owner decided to proceed): the ACP runtime, from the real binary

Source: the registry entry and the darwin-arm64 archive itself, downloaded to a scratch dir, sha256 verified, never executed; read with `strings` (the .par is a Mach-O with an embedded Python 3.14 bytecode bundle whose docstrings and constants are readable). Line refs below are into that string dump, not a public repo.

- **Registry:** id `antigravity-acp`, name "Google Antigravity", version **1.5.0**, license proprietary (https://antigravity.google/terms). Binary distribution only, no npx: `https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.0-darwin-arm64.zip`, sha256 `c82ecb4ef476bfc35cbe5b2745cdddef873b99c9f5bd7fd11e5ca1fc1667a3fc` (matches the download). Command `./agy_acp_server.par` (Linux adds `--uid=`; linux-x86_64 sha256 36f373e8...). The zip holds `agy_acp_server.par` (180 MB) and `localharness_external` (130 MB Go helper, found via `ANTIGRAVITY_HARNESS_PATH`). Registry: https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
- **GEMINI_HOME isolation: CONFIRMED.** `paths.consumer_token_path()`: "`<home>/antigravity-acp/acp_token.json`, where `<home>` is GEMINI_HOME if set (and non-empty), otherwise `~/.gemini`". Same root for `settings.json`, `acp_business_token.json`, `trusted_workspaces.json`, sessions. Caveat: on macOS the token goes to the login keychain (service from `credential_store.KEYCHAIN_SERVICE`, account `antigravity-acp`, a single machine-wide slot) unless **`AGY_ACP_FORCE_FILE_STORAGE=1`**, which forces the file backend. Per-account isolation on the Mac therefore needs both env vars. Off macOS the file backend is always used.
- **Auth selection:** env selection was removed (`AGY_ACP_ENABLE_OAUTH` and bare `GEMINI_API_KEY` no longer select a method). Set `auth.type` in `<GEMINI_HOME>/antigravity-acp/settings.json` (`oauth-personal`) or call ACP `authenticate`. OAuth is a loopback browser flow (redirect to `http://127.0.0.1:<port>/`) with a built-in installed-app client and scopes cloud-platform, userinfo.email, aicode. No standalone login subcommand was found; sign-in needs an ACP client calling `authenticate`.
- **Endpoint: REDIRECTABLE.** Host is `https://cloudcode-pa.googleapis.com` (prod) or `https://daily-cloudcode-pa.googleapis.com`. Consumer tiers (Free, Google AI Pro/Ultra) are mapped to the **daily** host by `_determine_endpoint` from the `loadCodeAssist` response. But `OAuthCredentialManager.endpoint_url` returns `os.environ["AGY_ACP_CCPA_BASE_URL"]` first when set, ahead of the resolved endpoint, and model calls use that property. So `AGY_ACP_CCPA_BASE_URL=http://127.0.0.1:<hub>` redirects streaming and quota calls. Caveat: the onboarding `loadCodeAssist`/`onboardUser` call in `_resolve_backend` is made with `base_url=None`; whether that default honors the env var was not confirmed (it uses `default_ccpa_endpoint()` elsewhere, which does). The first sign-in must be tested for this. The model call path is Go harness -> local Python "credentials injection proxy" on 127.0.0.1 (adds the account bearer) -> CCPA via urllib (also honors `HTTPS_PROXY`). Other overrides: `AGY_LLM_GATEWAY_URL` / `_API_KEY` / `_HEADERS` / `_CA_CERT` plus `AGY_ACP_ENABLE_GATEWAY_AUTH=1` (custom-gateway auth method, "not yet ratified").
- **Wire:** same family as gemini-cli: `POST /v1internal:streamGenerateContent?alt=sse` with body `{model, project, request}`, `loadCodeAssist`, `onboardUser` (IDE type `ANTIGRAVITY`), `operations/<id>` polling, `fetchAvailableModels`, `generateContent`.
- **Project/tier rule:** still per user. Project comes from `loadCodeAssist` (managed project id after onboarding); tier from `paidTier`/`currentTier`. `AGY_ACP_CCPA_PROJECT` skips onboarding but only for `@google.com` accounts. So the hub still has to rewrite `project` to the chosen account's project, as in #508.
- **Quota call:** `POST /v1internal:retrieveUserQuotaSummary` body `{"project": id}` (backs the runtime's `/usage` command). Response has `buckets[]` with `bucketId`, `displayName`, `remainingFraction`, `remainingAmount`, `resetTime`, `disabled`. Different method name from gemini-cli's `retrieveUserQuota`.
- **Out-of-quota signal:** a 429 whose error text carries `ErrorInfo` `reason: QUOTA_EXHAUSTED` plus `quotaResetDelay` (Go duration) and `quotaResetTimeStamp`. The runtime renders "Usage Limit Reached ... You have reached your current quota for this period. Your limit will reset in/on ...". Only the consumer OAuth path meters per-user quota. Same allowlist logic as #508 (QUOTA_EXHAUSTED holds the account) applies.
- **Design consequence:** the redirect branch of root's Step 2 applies. #508's hub, per-account token swap, project rewrite and failover carry over; changes: new routes under the same `/v1internal:*`, quota call name and bucket shape, runtime launch via `launchEnv` (`GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_ACP_CCPA_BASE_URL`), and a sign-in flow through an ACP client.
- Disclosure: reading the strings printed the runtime's built-in public installed-app OAuth client secret into tool output; it is not written into this file or the repo.

## Earlier verdict (superseded by the owner's decision of 2026-11-17 18:15)

The notes below were my first conclusion that pooling should stop. The owner has since decided to proceed after being told of the terms and suspension risk. They stay for the record. Correction: the forum reply is from a member marked `staff: false` (title "Regular"), not Google staff, so it is COMMUNITY, not OFFICIAL.

### 1. Terms forbid pooling (COMMUNITY forum reply, not Google staff)
Google AI Developers Forum reply (Ambati_Rajendra, 2026-09-28) to a user asking whether an orchestrator may rotate several paid AI Pro accounts through the official `agy` binary:
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
