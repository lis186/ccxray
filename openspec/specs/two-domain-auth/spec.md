## ADDED Requirements

### Requirement: Two-domain request classification
ccxray SHALL classify every inbound request into one of two domains: **upstream** (`/v1/*` paths — API traffic from launched agents) or **dashboard** (all other paths — browser UI, SSE, internal APIs).

#### Scenario: Anthropic API request
- **WHEN** a request arrives at `/v1/messages`
- **THEN** it SHALL be classified as `upstream` domain

#### Scenario: Dashboard page load
- **WHEN** a request arrives at `/` or `/_api/entries`
- **THEN** it SHALL be classified as `dashboard` domain

### Requirement: Upstream authentication via X-Ccxray-Auth
Upstream-domain requests SHALL be authenticated by the `X-Ccxray-Auth` header containing `K_upstream` (derived via HKDF from the root secret). Legacy `Authorization: Bearer` and `?token=` are accepted with deprecation headers in Phase 1, rejected in Phase 2.

#### Scenario: Valid X-Ccxray-Auth header
- **WHEN** upstream request carries `X-Ccxray-Auth` matching the derived `K_upstream`
- **THEN** request SHALL be allowed without deprecation headers

#### Scenario: Legacy Bearer on upstream (Phase 1)
- **WHEN** upstream request carries `Authorization: Bearer <AUTH_TOKEN>` but no `X-Ccxray-Auth`
- **THEN** request SHALL be allowed with `X-Ccxray-Deprecation: bearer-on-upstream` response header

#### Scenario: Legacy Bearer on upstream (Phase 2)
- **WHEN** upstream request carries only `Authorization: Bearer <AUTH_TOKEN>`
- **THEN** request SHALL be rejected with 401

#### Scenario: ChatGPT-OAuth Codex (no X-Ccxray-Auth)
- **WHEN** upstream request has `chatgpt-account-id` header + JWT-shaped `Authorization` but no `X-Ccxray-Auth`
- **THEN** request SHALL be allowed (carve-out: cannot carry custom headers without breaking OAuth)

### Requirement: Dashboard authentication via HttpOnly cookie
Dashboard-domain requests SHALL be authenticated by an `HttpOnly; SameSite=Strict` cookie (`ccxray_s`) containing an HMAC-signed stateless payload. Cookie is minted via the bootstrap flow.

#### Scenario: Valid session cookie
- **WHEN** dashboard request carries `ccxray_s` cookie with valid HMAC
- **THEN** request SHALL be allowed

#### Scenario: No cookie, no legacy auth
- **WHEN** dashboard request has no `ccxray_s` cookie and no `Authorization: Bearer`
- **THEN** request SHALL be rejected with 401 (Phase 2); allowed with warn (Phase 1)

### Requirement: Browser bootstrap flow (ccxray open)
Users SHALL authenticate the browser via `ccxray open` which mints a one-time 60s bootstrap token, opens a URL with the token in the fragment (`#k=`), and the browser redeems it at `POST /_auth/redeem` to receive a session cookie.

#### Scenario: Successful bootstrap
- **GIVEN** user runs `ccxray open`
- **WHEN** browser opens `http://localhost:<port>/#k=<token>` and POSTs to `/_auth/redeem`
- **THEN** server SHALL validate the token, set `ccxray_s` cookie, and respond 200

#### Scenario: Expired bootstrap token
- **WHEN** browser POSTs to `/_auth/redeem` with a token older than 60 seconds
- **THEN** server SHALL respond 401

#### Scenario: Replayed bootstrap token
- **WHEN** browser POSTs to `/_auth/redeem` with an already-redeemed token
- **THEN** server SHALL respond 401

### Requirement: Key derivation via HKDF
All authentication keys SHALL be derived from a single root secret via HKDF-SHA256 with label separation: `K_upstream` (label `ccxray/v1/upstream`), `K_session` (label `ccxray/v1/session-hmac`), `K_bootstrap` (label `ccxray/v1/bootstrap`).

#### Scenario: Root from AUTH_TOKEN
- **WHEN** `AUTH_TOKEN` env is set
- **THEN** root secret SHALL be `SHA256(AUTH_TOKEN)`

#### Scenario: Root from ephemeral secret
- **WHEN** `AUTH_TOKEN` is unset
- **THEN** root secret SHALL be read from `~/.ccxray/local-secret` (32 random bytes, mode `0600`); created on first use

### Requirement: Launcher header injection
The launcher (`server/providers.js`) SHALL inject `X-Ccxray-Auth` into spawned agents via provider-specific mechanisms. Injection failure SHALL warn but not abort (Phase 2 enforces).

#### Scenario: Claude Code
- **WHEN** ccxray spawns Claude Code
- **THEN** SHALL set `ANTHROPIC_CUSTOM_HEADERS="X-Ccxray-Auth: <K_upstream_base64url>"` in the child env

#### Scenario: Codex CLI (API-key mode)
- **WHEN** ccxray spawns Codex with `OPENAI_API_KEY` set
- **THEN** SHALL inject `-c 'model_providers.ccxray={...http_headers={"X-Ccxray-Auth"="<K>"}}'` + `-c 'model_provider="ccxray"'`

#### Scenario: Codex CLI (ChatGPT-OAuth mode)
- **WHEN** ccxray spawns Codex without `OPENAI_API_KEY`
- **THEN** SHALL use legacy `-c openai_base_url=... -c chatgpt_base_url=...` (no model_provider override, would break OAuth)

### Requirement: Internal header stripping
ccxray SHALL strip `X-Ccxray-Auth` and `X-Ccxray-Bootstrap` from all requests forwarded to upstream APIs (Anthropic, OpenAI). These are ccxray-internal headers and must not leak.

#### Scenario: HTTP forward
- **WHEN** a request with `X-Ccxray-Auth` is forwarded to Anthropic
- **THEN** the forwarded request SHALL NOT contain `X-Ccxray-Auth` or `X-Ccxray-Bootstrap`

#### Scenario: WebSocket upgrade
- **WHEN** a WS upgrade with `X-Ccxray-Auth` is proxied to OpenAI
- **THEN** the upstream handshake SHALL NOT contain `X-Ccxray-Auth` or `X-Ccxray-Bootstrap`

### Requirement: Hub IPC over Unix socket (Phase 2)
Hub inter-process communication SHALL move from HTTP `/_api/hub/*` to a Unix domain socket (`~/.ccxray/hub.sock`, mode `0600`). Filesystem permissions provide the access control gate (no peer-UID API needed).

#### Scenario: Client registration via socket
- **WHEN** a ccxray client connects to `hub.sock` and sends `{"cmd":"register","pid":123,"cwd":"/path"}`
- **THEN** hub SHALL register the client and respond `{"ok":true}`

#### Scenario: Other-UID process attempts connection
- **WHEN** a process running under a different UID tries to connect to `hub.sock`
- **THEN** the OS SHALL reject the connection with EACCES (socket mode `0600`)

#### Scenario: HTTP hub routes after migration
- **WHEN** a request arrives at `/_api/hub/register` after Phase 2.1
- **THEN** server SHALL respond 410 Gone (except `/_api/health` which stays for dashboard liveness)

### Requirement: Ephemeral mode default (Phase 2)
When `AUTH_TOKEN` is unset, ccxray SHALL default to ephemeral mode (auth enforced via `~/.ccxray/local-secret`). Anonymous loopback access requires explicit `CCXRAY_LOOPBACK_NO_AUTH=1`.

#### Scenario: Default startup without AUTH_TOKEN
- **WHEN** ccxray starts with no `AUTH_TOKEN` and no `CCXRAY_LOOPBACK_NO_AUTH`
- **THEN** all requests SHALL require authentication (cookie or X-Ccxray-Auth)

#### Scenario: Explicit loopback opt-in
- **WHEN** `CCXRAY_LOOPBACK_NO_AUTH=1` is set
- **THEN** loopback requests SHALL be allowed without authentication, with a startup warning banner

#### Scenario: Non-loopback request with the flag set
- **WHEN** `CCXRAY_LOOPBACK_NO_AUTH=1` is set AND a request arrives from a non-loopback `remoteAddress`
- **THEN** authentication SHALL still be required (the bypass is loopback-scoped, checked at the gate via `req.socket.remoteAddress`)
- **NOTE** ccxray binds all interfaces (`0.0.0.0`), so the guard limits a set flag to local-only. A same-host reverse proxy presents `remoteAddress = 127.0.0.1`, which defeats the guard — documented, not closed (design 決策 7).

### Requirement: WebSocket upgrade auth gate
WebSocket upgrades on `/v1/responses` and `/v1/realtime` SHALL be subject to upstream auth. Phase 1: warn-only. Phase 2: reject without valid credential.

#### Scenario: WS upgrade without auth (Phase 1)
- **WHEN** WS upgrade arrives without `X-Ccxray-Auth` and without ChatGPT-OAuth markers
- **THEN** SHALL log warning but allow the upgrade

#### Scenario: WS upgrade without auth (Phase 2)
- **WHEN** WS upgrade arrives without valid credential
- **THEN** SHALL reject with 401

### Requirement: CLI secret retrieval
Users SHALL be able to retrieve `K_upstream` via `ccxray secret upstream` for use in scripts and CI. The command prints the base64url-encoded token to stdout and exits.

#### Scenario: Retrieve upstream token
- **WHEN** user runs `ccxray secret upstream`
- **THEN** stdout SHALL contain the base64url-encoded `K_upstream` derived from the current root secret

### Requirement: Log redaction
Auth-related values SHALL never appear in disk logs (`_req.json`, `_res.json`, index). `?token=` query params SHALL be stripped from URLs before logging. Raw request headers are not logged (only extracted metadata).
