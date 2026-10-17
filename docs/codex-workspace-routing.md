# Codex workspace-routing bootstrap (#671)

ChatGPT-login sessions in Codex 0.159.2 and 0.163.0 are known unsupported
through ccxray 2.5.0-rc.3's local HTTP base-URL overrides. API-key sessions do
not use this ChatGPT workspace-discovery flow. Track resolution in
[#671](https://github.com/lis186/ccxray/issues/671).

## Discovery request and observed failure

The launcher in `server/providers.js` sets both `openai_base_url` and
`chatgpt_base_url` to `http://localhost:<port>/v1` for ChatGPT login.
Codex's [backend client](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/backend-client/src/client.rs)
selects its path style from the base URL: a URL containing `/backend-api` uses
`/wham/accounts/check`; other URLs use `/api/codex/accounts/check`.
`get_accounts_check()` sends an authenticated GET, with the selected account
header when available. Thus the local override produces
`GET /v1/api/codex/accounts/check`.

`server/config.js` recognizes `/v1/api/codex/*` as OpenAI traffic and selects
`openaiChatGPT`, independently of the account header. `joinUpstreamPath()`
strips `/v1` and prepends `/backend-api/codex`. `server/forward.js` sends the
request to `chatgpt.com`, preserving the OAuth and account headers through
`buildForwardHeaders()` in `server/index.js`. The resulting upstream path is
`/backend-api/codex/api/codex/accounts/check`, whereas native ChatGPT discovery
uses `/backend-api/wham/accounts/check`. The existing Apps MCP exception only
covers `/v1/api/codex/ps/mcp` and does not apply here.

A bootstrap-only reproduction on 2026-10-17 used the installed Codex 0.163.0
app-server, initialized it, then issued `account/read` without a model prompt.
The worktree proxy ran on a dynamically allocated non-default loopback port
with an isolated `CCXRAY_HOME` and import/export disabled. Only the outgoing
discovery host/path and response status were observed; response bodies and
credentials were not captured. The upstream returned HTTP 404 on three
attempts. Codex returned JSON-RPC error `-32603`, `workspace routing discovery
failed`. ccxray forwards that response unchanged on its noise-request path
(`skipEntry: true`), so this request creates no recorded turn. The 404 body was
not inspected. Both processes were stopped after bootstrap; no user config
was edited.

## Why a path-only fix is insufficient

The release's [account routing resolver](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
requires discovery for the selected ChatGPT account before it can determine
whether a custom destination is independent. It then validates the returned
`workspace_backend_origin` and `account_routing_override`:

- If the backend is `NO_CONSTRAINT` and no backend is required by policy,
  `resolve_routing()` validates the configured `chatgpt_base_url` itself.
  `parse_backend_url()` requires HTTPS, rejecting ccxray's local HTTP URL.
- If discovery specifies an HTTPS backend origin, Codex accepts that origin.
  Its [model-provider routing](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/workspace_routing.rs)
  replaces the provider URL's scheme, host and port with the discovered origin.
  The local proxy and its port are therefore bypassed. The path is retained,
  which also means the proxy-specific `/v1` path is no longer translated.

The same HTTPS validation exists in
[0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs).
These constraints are established from source; a successful real discovery
response was not captured, and neither response branch was live-tested.

Changing only the discovery path cannot make this HTTP reverse-proxy setup
work end to end. Rewriting the discovery body, fabricating routing constraints,
or silently sending model requests directly would not be a transparent fix.
No routing code or response rewriting is changed in this task. A complete
solution needs a supported transport arrangement that preserves workspace
routing, or upstream Codex support for a separate local proxy destination.
Until then, run these ChatGPT-login versions directly without ccxray's
base-URL overrides. This investigation does not establish that other Codex
versions are compatible.
