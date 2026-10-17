# Codex workspace-routing bootstrap (#671)

**Status: resolved.** ChatGPT-login sessions in Codex 0.159.2 and 0.163.0
failed to bootstrap through ccxray 2.5.0-rc.3 with JSON-RPC `-32603`,
`workspace routing discovery failed`. The launcher no longer overrides
`chatgpt_base_url`; in ChatGPT-OAuth mode it sets only
`openai_base_url="http://localhost:<port>[<route>]/v1"`. API-key sessions are
unchanged (they use a `model_providers.ccxray` entry and never run ChatGPT
workspace discovery).

## What the launcher does now

`server/providers.js` (`codex.createLaunch`) and the Herdr plugin
(`plugins/herdr/bin/lib/ccxray.js` `codexAgentArgs`) emit, in ChatGPT-OAuth
mode:

```
-c openai_base_url="http://localhost:<port>[/_ccxray/client/<pid>|/_ccxray/agent/<herdr id>]/v1"
```

Codex keeps its built-in `openai` provider and its default
`chatgpt_base_url` (`https://chatgpt.com/backend-api/`). As a result:

- **Account, workspace-discovery, plugin and connector calls go directly to
  chatgpt.com over HTTPS.** They used to come through ccxray, where they were
  already classified as noise (`skipEntry: true`), so no recorded turn is lost.
  The bearer now travels over TLS to chatgpt.com instead of over plaintext
  loopback; ccxray never persisted `authorization` either way.
- **Model traffic (HTTP and WebSocket `/v1/responses`) still comes to ccxray.**
  The built-in provider still attaches the ChatGPT bearer and
  `ChatGPT-Account-ID`, and `server/config.js` routes requests carrying
  `chatgpt-account-id` to `CHATGPT_BASE_URL` (default
  `https://chatgpt.com/backend-api/codex`), so `/v1/responses` becomes
  `/backend-api/codex/responses` exactly as before. Attribution (client PID
  route, Herdr agent route, cwd fallback) is unchanged.

### Invariant: the proxy URL must end in `/v1`, never `/backend-api/codex`

This is why the fix is safe, not an incidental detail. Codex applies a
discovered workspace origin to the `openai` provider only when
`supports_codex_backend_routes()` is true — `is_openai()` and a `base_url` that
is unset or ends in `/backend-api/codex`
([`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/lib.rs)).
`responses_api_provider` in `model-provider/src/provider.rs` calls
`apply_workspace_routing` only inside that gate, and the `ClientRouting::Workspace`
funnel used by prewarm, WebSocket preconnect, HTTP `/responses`, WebSocket
streaming and compaction all pass through it. With a `…/v1` loopback URL the gate
is closed, so no discovery outcome (`NO_CONSTRAINT`, a specified origin, or
`us`/`us_cr`) can redirect model traffic away from ccxray. A proxy URL ending in
`/backend-api/codex` would open the gate: `apply_workspace_routing` would
replace scheme, host and port with the discovered origin and model traffic
would bypass ccxray, unrecorded. `test/providers.test.js` and
`test/herdr-plugin.test.js` pin this. The same gate exists in 0.159.2.

The same `supports_codex_backend_routes()` gate also controls the
codex-backend request headers in `core/src/client.rs`, so those headers were
already absent with the old `/v1` override; dropping `chatgpt_base_url` does
not change them.

## Which entry points were broken

Discovery is triggered at bootstrap by the app-server account processor
(`account/read`) against the configured `chatgpt_base_url`; the TUI reaches it
through the app-server (possibly a managed daemon). The core model path
(`codex exec`, and the TUI's model calls) reaches workspace routing only through
the gated `responses_api_provider`, which the `/v1` URL keeps closed. That
matches earlier evidence: a 0.159.3 `codex exec --ephemeral` run with both
overrides in `~/.codex/config.toml` reached the proxy normally
([agentflow notes](agentflow-integration.md)). So the observed failure was the
app-server/TUI bootstrap; `exec` likely never hit it.

Live verification of the fix (2026-10-17, Codex 0.163.0, bootstrap only):
with `openai_base_url` alone, `account/read` succeeded with
`account.type=chatgpt` and `workspaceRouting` present, override
`NO_CONSTRAINT`. Adding the old `chatgpt_base_url=http://127.0.0.1:<port>/v1`
reproduced `-32603`. The interactive TUI and the Herdr launch path were not
live-tested here.

## Remaining limitations

- **User config still pointing `chatgpt_base_url` at the proxy fails.** A
  `chatgpt_base_url` in `$CODEX_HOME/config.toml` (default `~/.codex`) that
  points at a loopback proxy — the older way to route Codex through ccxray, and
  the issue reporter's environment — still sends discovery to plaintext
  loopback and fails the same way. `ccxray codex` prints a one-line warning when
  it finds one (it reads the file and never edits it). The launcher does not
  force `chatgpt_base_url` back to the default, because enterprise
  configurations (including `requirements.toml`) can set it legitimately.
  Remove the loopback value.
- **Residency and enterprise workspaces.** When discovery returns a workspace
  origin other than chatgpt.com, or an `us`/`us_cr` routing override, Codex
  does not apply it to the loopback provider: it sends neither the discovered
  origin nor the `x-openai-account-routing-override` header (that header is set
  only by `apply_workspace_routing`). ccxray forwards to `CHATGPT_BASE_URL`, as
  it did before 0.159. Setting `CHATGPT_BASE_URL` to the workspace origin covers
  the origin only; `us`/`us_cr` workspaces may still be rejected upstream. Such a
  rejection is observable — the model request fails through ccxray and is
  recorded — but discovery itself no longer passes through ccxray. The managed
  residency header `x-openai-internal-codex-residency` is attached regardless
  and forwarded unchanged. Only the `NO_CONSTRAINT` branch was live-tested.
- **Upstream gate changes.** A future Codex could widen
  `supports_codex_backend_routes()` or route custom ChatGPT-auth providers.
  Re-check the gate on each Codex bump (the wire-protocol row is `obs-fragile`).

## Original failure analysis (kept for reference)

The 2.5.0-rc.3 launcher set both `openai_base_url` and `chatgpt_base_url` to
`http://localhost:<port>/v1` for ChatGPT login. Codex's
[backend client](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/backend-client/src/client.rs)
selects its path style from the base URL: a URL containing `/backend-api` uses
`/wham/accounts/check`; other URLs use `/api/codex/accounts/check`.
`get_accounts_check()` sends an authenticated GET, with the selected account
header when available. Thus the local override produced
`GET /v1/api/codex/accounts/check`.

`server/config.js` recognizes `/v1/api/codex/*` as OpenAI traffic and selects
`openaiChatGPT`, independently of the account header. `joinUpstreamPath()`
strips `/v1` and prepends `/backend-api/codex`. `server/forward.js` sends the
request to `chatgpt.com`, preserving the OAuth and account headers through
`buildForwardHeaders()` in `server/index.js`. The resulting upstream path is
`/backend-api/codex/api/codex/accounts/check`, whereas native ChatGPT discovery
uses `/backend-api/wham/accounts/check`. The existing Apps MCP exception only
covers `/v1/api/codex/ps/mcp` and does not apply here. This handling is kept
for users who configure `chatgpt_base_url` by hand.

A bootstrap-only reproduction on 2026-10-17 used the installed Codex 0.163.0
app-server, initialized it, then issued `account/read` without a model prompt.
The worktree proxy ran on a dynamically allocated non-default loopback port
with an isolated `CCXRAY_HOME` and import/export disabled. Only the outgoing
discovery host/path and response status were observed; response bodies and
credentials were not captured. The upstream returned HTTP 404 on three
attempts, and Codex returned `-32603`. ccxray forwards that response unchanged
on its noise-request path (`skipEntry: true`), so the request created no
recorded turn. No user config was edited.

### Why a path-only fix was insufficient

The release's [account routing resolver](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
requires discovery for the selected ChatGPT account before it can determine
whether a custom destination is independent. It then validates the returned
`workspace_backend_origin` and `account_routing_override`:

- If the backend is `NO_CONSTRAINT` and no backend is required by policy,
  `resolve_routing()` validates the configured `chatgpt_base_url` itself.
  `parse_backend_url()` requires HTTPS, rejecting ccxray's local HTTP URL.
- If discovery specifies an HTTPS backend origin and `chatgpt_base_url` equals
  the loopback provider origin, the session is treated as workspace-bound and
  [model-provider routing](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/workspace_routing.rs)
  replaces the provider URL's scheme, host and port with the discovered origin,
  bypassing the proxy while keeping the `/v1` path.

The same HTTPS validation exists in
[0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs).
Mapping the discovery path to `/backend-api/wham/accounts/check` would only
have reached the HTTPS check. Rewriting discovery bodies or fabricating routing
constraints was rejected. A custom `model_providers` entry with
`requires_openai_auth=true` would also avoid routing, but it gives up the
built-in provider's `supports_websockets` and `include_internal_metadata`, and
is not needed.
