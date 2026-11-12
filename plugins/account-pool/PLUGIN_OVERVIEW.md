Route Claude Code and Codex across local subscriptions.

## What you get

- Choose a subscription in the model menu with per-account usage. **Automatic** enables failover; an explicit choice never silently switches. CLI: `bb pool select <thread-id> <claude|codex> [<account-id>|automatic]`.
- A pool of Claude and Codex accounts, added by importing the login already on the machine, signing in through a clean in-app window (desktop; other clients open the browser), or pasting an Anthropic API key.
- Automatic sends new Claude conversations to the subscription with the most headroom and Codex conversations in priority order. A conversation keeps its account until it becomes unavailable.
- Drag handles, or Space and the arrow keys, set each provider's order; `bb pool account reorder <claude|codex> <id>...` does the same.
- Subscriptions in settings: switch each on or off, rename it in place, see its plan and state, sign an expired one in again, or remove it after confirming. Records of one login count once. On this Mac lists local logins not yet pooled.
- Limit windows per account and model family in Usage details and `bb pool status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.

## How it works

The hub serves Anthropic Messages and OpenAI Responses endpoints. Routed providers report **Proxied** and receive a token scoped to their thread. Accounts in error are skipped. The switch threshold defaults to 98 percent: a window at or above it is exhausted, as is a provider-refused window below it. Claude extra usage and Codex credits are fallbacks: usable subscription accounts take precedence, and conversations return when quota recovers. Exhausted accounts are rechecked before fallback. Codex spending-control and explicit credit-depletion restrictions block routing even below the threshold. The pool does not enable extra usage, purchase credits, or change spending limits. Usage details shows extra usage as available only for reported allowance, never current billing activity. Secrets stay on the server and tokens refresh in the background.

Short rate limits wait once on the same account. Longer holds return Retry-After for pinned conversations while new conversations can advance. A model-family limit detours requests for that family without moving the session’s main pin or the provider cursor. Server, overload and connection errors retry a pinned account twice with backoff before failing over. A successful response commits the new account; failing everywhere keeps the old binding. The current account and pins survive hub restarts; pins expire after 30 idle minutes, and the 4,096 most recent are kept.

The pool uses HTTP/1.1 and honors standard proxy environment variables.

## Nested bb servers

A nested bb server detects the parent pooler. Choose in settings or `bb pool parent`:

- **proxy** (default): keep a local hub with its own machine tokens and forward pooled traffic to the parent, so the parent's token never reaches this server's agents. Routing is contributed only for providers the parent can serve.
- **isolate**: neutralise the inherited routing and use this instance's own accounts, or each provider's own credentials.

Proxied traffic carries a token scoped to the launching thread.

## Requirements

Accounts you own and are permitted to use this way.

Experimental: routing, storage, and CLI may change.

## For agents

`bb pool account add|list|local|sign-in-again|rename|remove|enable|disable|priority|reorder`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config`, `bb pool config set`, `bb pool parent [proxy|isolate]`, `bb pool token rotate`, `bb pool bypass <thread-id> [--off]`, and `bb pool bypass get <thread-id>` (read-only), and `bb pool route issue|revoke|list`. Commands accept `--json`.

## Automatic retries

Provider Retry uses pool recovery times: see `bb provider-retry status` or `bb provider-retry explain <thread-id>`.
