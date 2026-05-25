# Task Brief — ccxray auth scheme design

**Domain:** security (with software overlap)
**Mode:** convergent
**Judges:** 3 (security-leaning)
**Convergence:** 3 consecutive wins
**Iterations cap:** 3 (initial; may extend on user approval)

---

## Task

**Design an authentication scheme for `ccxray` that balances security, convenience, and maintainability — given that it is a local-first developer tool with optional remote deployment.**

### Target system (concrete context)

`ccxray` is a single-process Node.js HTTP proxy + dashboard:

- Sits between Claude Code / Codex and the Anthropic / OpenAI APIs, records every request, serves a Miller-column dashboard at the **same port** (default 5577).
- One process serves **three classes of clients** on the same port:
  1. **The LLM client** (Claude Code / Codex CLI) — programmatic, sets `ANTHROPIC_BASE_URL=http://localhost:5577`, sends real upstream API requests with its own `x-api-key` for the upstream service.
  2. **The dashboard browser** — loads `index.html` + static assets (`/style.css`, `/app.js`, `/miller-columns.js`, …), then opens an `EventSource('/_events')` SSE stream and issues many `fetch('/_api/*')` calls.
  3. **CLI / scripts / curl** — humans and CI poking at `/_api/entries?limit=10` etc.
- Optional **hub mode**: multiple `ccxray` clients on the same machine share one hub process via lockfile; cross-process within the same user.
- Run modes:
  - **Default:** purely local — bound to localhost, single user, single machine.
  - **Optional remote:** some users run it on a shared dev box or in a container reachable over a corporate LAN / Tailscale.
- Current auth model (`server/auth.js`):
  - Off by default (`AUTH_TOKEN` env unset → allow all).
  - When `AUTH_TOKEN=<secret>` is set, every request must carry it via either `Authorization: Bearer <token>` header or `?token=<token>` query param.
  - The same middleware gates dashboard HTML, static assets, SSE, API, AND the upstream proxy path.
  - WebSocket upgrades (`/v1/responses` and `/v1/realtime` from Codex) also flow through the same server.

### Known problems in the current scheme

1. **Query-string mode loses auth on browser subrequests.** `/index.html?token=X` authenticates, but the browser then issues `GET /style.css`, `GET /app.js`, `fetch('/_api/entries')`, and `new EventSource('/_events')` with **no token attached** — they 401. Browser-based AUTH_TOKEN mode is effectively broken. (`?token=` works fine for curl/scripts because they carry it explicitly per request.)
2. **Token in URL leaks.** Browser history, Referer header (if the dashboard ever loads external assets), HTTP access logs, shoulder surfing, copy-paste-to-Slack.
3. **No CSRF protection** if a future fix uses ambient credentials (cookies). The dashboard has state-changing endpoints: `POST /_api/intercept/<id>/approve`, `POST /_api/intercept/<id>/reject`, `POST /_api/intercept/toggle`, `POST /_api/settings`, `POST /_api/stars`, `POST /_api/intercept/timeout`.
4. **No `Host` header validation** — vulnerable to DNS rebinding attacks against the localhost service.
5. **No graceful auth for WebSocket upgrades** — query-string `?token=` on the WS URL works but inherits all the leakage problems above; header-based auth on the WS upgrade can be hard from browsers.

### Constraints / non-goals

- **Zero new runtime deps.** `ccxray` advertises "zero dependencies beyond Node.js". The design must respect that.
- **Single coherent codepath.** No 5-mode swamp of "old `?token=` + new cookie + bearer + …" that future maintainers have to keep all aligned.
- **CLI/scripts MUST still work.** `curl -H 'Authorization: Bearer X' http://localhost:5577/_api/entries` is a primary usage.
- **Hub mode must keep working** — the lockfile/registry endpoints are part of the same auth surface.
- **No external IdP / SSO / OAuth.** Single shared secret model is acceptable; the secret comes from `AUTH_TOKEN` env or equivalent.
- **No persistent user store / accounts / roles.** Auth is binary: have-secret or not.
- **Out of scope:** multi-user RBAC, encryption-at-rest of logs, audit log of access, enterprise IT integration.

### Threat model to cover explicitly

The design MUST explicitly address (state how each is mitigated, or justify why it is acceptable to leave unmitigated):

1. **Malicious website CSRF.** User is logged into `ccxray` at `http://localhost:5577` and visits `evil.com` in another tab. `evil.com` issues `<form action="http://localhost:5577/_api/intercept/<id>/reject" method="POST">` or `<img src="http://localhost:5577/_api/...">` or `fetch('http://localhost:5577/_api/entries', {credentials: 'include'})`. Does the design prevent state changes? Data exfiltration?
2. **DNS rebinding.** `evil.com` resolves first to attacker IP, serves a page, then re-resolves to `127.0.0.1`. The browser thinks it is same-origin with `evil.com` and the localhost service.
3. **Token exfiltration via URL surface.** History, Referer header, server access logs, paste-into-Slack, browser sync to other devices.
4. **XSS-in-conversation-content.** The dashboard renders LLM output and tool-call content, which is high-risk surface. If a model response triggers XSS, can the attacker steal the auth credential?
5. **Plain-HTTP eavesdropping** when deployed non-locally. ccxray has no HTTPS — what is the design's stance for remote deployments?
6. **Token leak via WebSocket upgrade URL.** Codex WS uses long-lived connections; if the URL carries `?token=`, the token sits in connection logs and any debugging dump.

### What "balance" means here (rubric)

- **Security:** All 6 threats above either mitigated or explicitly accepted with rationale.
- **Convenience:** First-time setup ≤ 1 step beyond setting `AUTH_TOKEN`. Browser dashboard works without manual token re-entry across reloads. CLI/curl/CI usage trivial.
- **Maintainability:** Auth logic lives in ≤ 2 files, no per-route bespoke handling, no client-side monkey-patching of `fetch`/`EventSource`/`WebSocket`. Composes with future features (auth method swap, multi-tenant in the distant future) without rewrite.

### Required deliverable shape (design-doc level)

Each candidate must include:

1. **Stance / one-sentence summary** of the chosen approach.
2. **Component-level architecture**: which modules change, what the request flow looks like for each of the 3 client classes (LLM client, browser, CLI).
3. **Concrete protocol details**: header / cookie names, attributes (`HttpOnly`, `SameSite`, `Secure`, `Max-Age`, `Path`, `Domain`), endpoints added or changed, exact wire-format examples.
4. **Threat-by-threat mitigation table** covering the 6 threats above with the specific mechanism that defends against each.
5. **Migration path** from the current `AUTH_TOKEN` + header/query model.
6. **Explicitly rejected alternatives** with reasons (at minimum: pure cookie, pure bootstrap-injection, OAuth, mTLS).
7. **Failure modes & operational notes**: what happens if the token is rotated, if the user clears cookies, if multiple browser tabs are open, if the server restarts mid-session, if hub mode is active, if deployed non-locally over HTTP.

Length: appropriate for design-doc completeness — concise where possible, but not so terse that protocol details or threat mitigations are hand-waved.
