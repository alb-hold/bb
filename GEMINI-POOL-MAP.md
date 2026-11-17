# GEMINI-POOL-MAP: where Gemini breaks in the account pool

Base: `origin/ours` 198f84bf. gemini-cli 0.68.0, bundle `chunk-2OHBIZ5H.js` (line numbers below).
Written before code; the build follows this map.

## 1. One Claude/Codex account, end to end, and where Gemini breaks

| Stage | Claude/Codex today | Where Gemini breaks | Change |
|---|---|---|---|
| Add | `operations.ts add()` → `hub.importAccount(provider)` → adapter `importAccount()`; CLI `cli.ts:390-470` | `providerSchema` is `z.enum(["claude","codex"])` (`contracts.ts:77`); no Gemini adapter; no credential importer | new `gemini-adapter.ts`, `gemini-credentials.ts` (reads `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json` + `google_accounts.json`); `add --import --home <dir>` |
| Store | `store.ts` kv key `accounts:v1` = `z.array(accountSchema)` (`store.ts:54,114`); secret file per account id | a Gemini row in `accounts:v1` makes every older build's `accountsSchema.parse` throw, taking Claude and Codex listing down | Gemini rows live under a **separate kv key `accounts:gemini:v1`**, merged in `list()` and split on write. Older builds never read that key. See §3 |
| Balancer pick | `hub.ts select()` `:1640-1700`. Claude uses `chooseBalancedCandidate`; Codex uses priority order | Gemini must take the non-Claude branch. `accept()` calls `putActiveAccount(provider)` → writes `pool_active_account` row with provider `gemini`; older `activeAccountRowSchema` (`store.ts:1201`) throws on it, and so does `loadAutomaticChoices` (`:1276`) | Gemini: priority order (Codex path). `accept()` keeps the active account **in memory only** for Gemini. Affinity rows are safe (key is JSON, `account_id` a uuid) |
| Credential injection | `server.ts:996-1015` `experimental_contributeEnv("codex", …)` adds `CODEX_OPENAI_BASE_URL` and a thread-scoped hub token; routes `server.ts:1048-1074` | no Gemini env contribution, no hub route | contribute env for provider id `acp-gemini` (the ACP registry id, `provider-acp/src/agents.ts:11`): `CODE_ASSIST_ENDPOINT=<hub>/gemini`, `GOOGLE_GENAI_USE_GCA=true`, `GOOGLE_CLOUD_ACCESS_TOKEN=<thread-scoped hub token>`. Hub route `POST /gemini/v1internal:*` |
| Usage read | adapter `refreshUsage` (`codex-adapter.ts:~480`); `usage-source.ts:29,65,212` hardcode `claude-code`/`codex` | no usage reader | `refreshUsage` calls `retrieveUserQuota({project})` (`:313999`) and maps `buckets[].remainingFraction/resetTime` to `limitWindows`; `usage-source.ts` returns `acp-gemini` |
| Failover | `hub.ts:1324` `isQuotaRejection(headers)` on HTTP 429 | Google signals quota in the body (`error.status = "RESOURCE_EXHAUSTED"`), not headers | optional adapter hook `isQuotaRejectionBody(response)`; hub rotates to the next account and refreshes that account's quota |

## 2. Can gemini-cli be pointed at the hub? Yes (stop condition cleared)

- `getBaseUrl()` reads `CODE_ASSIST_ENDPOINT` and `CODE_ASSIST_API_VERSION` (`chunk-2OHBIZ5H.js:314132-314135`). Every Code Assist call (`loadCodeAssist`, `onboardUser`, `streamGenerateContent`, `retrieveUserQuota`) goes through `getMethodUrl` (`:314136`), so one env var redirects all of them to the hub.
- **Catch:** the cached-login path calls `client.getTokenInfo(token)` (`:280109`, `google-auth-library` hits `https://oauth2.googleapis.com/tokeninfo`, defined `:10687`). A pool-issued fake token fails that check and gemini-cli drops to interactive login. So the pool must not hand it a fake `oauth_creds.json`.
- **Way through:** `initOauthClient` (`:280052`) first checks `GOOGLE_GENAI_USE_GCA` and `GOOGLE_CLOUD_ACCESS_TOKEN` (`:280072`). That branch calls `setCredentials({access_token})` and returns without `getTokenInfo`. Its only direct Google call is `fetchAndCacheUserInfo` (`:280588`), which wraps everything in try/catch (`:280612`) and so tolerates a 401. Residual: the thread-scoped hub token is sent once to `www.googleapis.com/oauth2/v2/userinfo`. The token is a thread-scoped hub credential, not a Google credential; the hub routes are `auth: "none"` and reachable by remote hosts over the network, so a leaked token is usable against the hub until it expires with the thread, never against Google. Rated low residual (thread-scoped, short-lived; Google returns 401 and gemini-cli ignores it). Recorded in the security notes.
- No real Google token is ever placed in the agent's environment or home: the agent holds only a hub token; the real access/refresh token stays in the pool's secret store, as for Claude and Codex.
- `GOOGLE_GENAI_USE_GCA=true` also makes `getAuthTypeFromEnv` return `oauth-personal` (`:315358`), so no settings file is needed.
- The public OAuth client id/secret gemini-cli ships (`:280031-280032`) are reused for refresh, not reinvented.

## 3. Rollback safety: what an older build reads

Older builds parse, with Claude|Codex-only enums: `accounts:v1` (`accountsSchema`), `pool_active_account.provider`, `pool_automatic_choice.provider`, `threadSelection`/`draftSelection` inputs, `poolAvailability`, `routedProviderSchema`.

| Gemini data | Where it goes | Older build |
|---|---|---|
| account row | kv `accounts:gemini:v1` | never read |
| secret | `<secretsDir>/<uuid>.json`, same as others | only opened by id from `accounts:v1`; never opened |
| quota row | `account_quota` keyed by account id | only read for ids it lists; unseen |
| active account | memory only | no row written |
| automatic choice | not written for Gemini (Codex path writes none) | no row |
| affinity | `pool_affinity` key `["gemini",…]` → uuid | parsed as plain `{key, uuid, int}`; unknown account is skipped at select |
| thread selection kv `selection:gemini:<thread>` | read by key only | never read |

Test: a store holding a Gemini row is read by the **old** schema functions (`accountsSchema` on the `accounts:v1` value, `activeAccountRowSchema` rows) and still serves Claude and Codex.

Complete rollback inventory (each checked at 198f84bf):

| Reader (older build) | Parse | Gemini handling |
|---|---|---|
| `accounts:v1` `accountsSchema` | hard `parse` | Gemini rows never written here |
| `pool_active_account` / `pool_automatic_choice` | hard `parse` | Gemini never written (memory only) |
| `routed:<thread>` `routedThreadSchema` (`store.ts:78`, hard parse at `:1007`) | no provider field; only Claude is recorded (`server.ts:695`) | no Gemini record |
| `actor-routed:` `actorRoutedSchema` (`store.ts:883`) | `safeParse` (`:945,:956`) | a Gemini row is skipped |
| thread-token route files (`thread-tokens.ts:80-106`, `readRecord` `:2499`) | `safeParse`, returns null | a Gemini route file is skipped, not fatal |
| `poolAvailabilitySchema` (`contracts.ts:57`, `.strict()`) | hard parse by an old nested child | **no `gemini` key added**; Gemini availability is reported separately |

The rollback test freezes a copy of the 198f84bf schemas (not the widened ones) and asserts each still serves Claude and Codex.

## 4. Project id decision: rewrite the project (do not pin per conversation)

gemini-cli resolves the project once per process: `_doSetupUser` calls `loadCodeAssist` (`:314314`) and takes `loadRes.cloudaicompanionProject` (`:314361`) as `projectId`; `CodeAssistServer` holds it (`:313948`) and puts it on `generateContent`/`streamGenerateContent` via `toGenerateContentRequest` → `project` (`:291049-291055`), and on `retrieveUserQuota({project})` (`:389564`).

If the pool swaps the bearer on failover without touching `project`, account B's token travels with account A's project: the API refuses it.

Decision: **the hub rewrites the project per account.**
- Each Gemini account's project is learned by the hub from `loadCodeAssist` (on add, and on every usage refresh), stored in the account's quota-side record (`geminiProject`), not in the agent.
- On every `/gemini/v1internal:*` request the hub sets the JSON body fields `project`, `cloudaicompanionProject`, `metadata.duetProject` to the **selected account's** project. A failover mid-conversation therefore stays coherent. Rejected alternative, pinning an account per conversation: it would defeat failover, the point of the card.
- Responses are passed through unchanged. gemini-cli caches whatever `loadCodeAssist` returned, and the hub overwrites it again on every request.
- If an account has no known project (first request on a brand-new account) the hub calls `loadCodeAssist` itself with that account's token before serving.

## 5. Every file that hardcodes claude|codex (111 literals; grouped)

`plugins/account-pool/src`: `contracts.ts:77,280,285` · `rpc.ts:96,231,237` · `cli.ts:71,390,425,467,1106` · `hub.ts:446-449,537,602-638,891,981-1008,1651-1757,2236-2247` · `operations.ts:41-42,85,120-146,188-230,272,313,387-413,558,628-629` · `display.ts:30,42` · `subscriptions.ts:30,60,81` · `thread-tokens.ts:306,2236` · `usage-source.ts:29,65,212` · `actor-routes.ts:19` · `server.ts:506,558,620-695,862,904-1087` · `store.ts:888,1201,1276` · `claude-adapter.ts:318` · `codex-adapter.ts:410`.
`plugins/account-pool`: `app.tsx:116-122,361,773-803,1145,1442,1485,2006-2139,2188-2465` · `subscription-picker.tsx:25-82,184-193`.
`apps/server`: no change needed (`usage-limits.ts` not referenced by the pool path). `plugins/provider-acp`: no change. `packages/provider-bridge-acp`: one-line auth-method pick (§5b).

## 5b. ACP auth path (the bridge needs one change)

Gemini ACP `newSession` (`gemini-QXW4BNRT.js:17647`) picks `settings.security.auth.selectedType`, else `gateway` / `gemini-api-key`. With only the env token set, session creation would fail as unauthenticated. `authenticate("oauth-personal")` (`:18010`) runs `refreshAuth` (which takes the `GOOGLE_GENAI_USE_GCA` branch) and then writes `selectedType` to user settings. bb's bridge (`packages/provider-bridge-acp/src/bridge/bridge.ts:807`, `resolveAcpAuthMethodId`) only picks `xai.api_key` / `cached_token`. Change: pick `oauth-personal` when the env has `GOOGLE_GENAI_USE_GCA=true` and `GOOGLE_CLOUD_ACCESS_TOKEN` and the agent lists that method. Package-local, no server or daemon protocol change. Side effect to verify: `authenticate` calls `clearCachedCredentialFile` only if a different `selectedType` was already set. No per-thread `GEMINI_CLI_HOME` is set, so the user's MCP and extension config stays visible.

Provider id: env is resolved by `thread.providerId` (`thread-runtime-config.ts:227`), which for the registry agent is `acp-gemini`.

## 6. Out of scope here (reported, not built)

- In-app Google sign-in. The pool imports a login made with `GEMINI_CLI_HOME=<dir> gemini` (isolated per account). The owner's three sign-ins come later under the `verified-qa-e2e` gate.
- Full UI parity for Gemini rows beyond listing, naming and usage windows.

## 7. As built (deviations from the plan above)

- Hook name is `quotaRejectionFromBody(detail, now)`; the hub drains up to 16 KB of a 429 body, rotates to the next account either way, and records a `usageRestriction` only for quota reasons (`MODEL_CAPACITY_EXHAUSTED` only holds by `retry-after`).
- The project is learned on add and on every usage refresh (`loadCodeAssist`), not on demand in the request path. `add` refuses an account with no project or tier, so an account is onboarded before it is pooled. `getOperation` polling is not routed.
- Quota granularity: a pro-class bucket maps to `primary`, all others to `secondary`; an exhausted bucket marks the whole account exhausted (family is always `other`).
- Under a parent pool Gemini is not relayed (`canServe` is false for it).
- CLI: `bb pool account add --provider gemini --import --home <dir>`; `--login` for Gemini explains the `GEMINI_CLI_HOME=<dir> gemini` step. `routing.set`, actor routes and `poolAvailabilitySchema` stay claude/codex (rollback safety, §3).
- Not touched: `app.tsx`, `subscription-picker.tsx` (Gemini rows list via the generic summary).
- Residual risk: hub routes are `auth: "none"`, guarded by a thread-scoped hub token (low).
