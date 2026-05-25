# ccxray auth scheme — reason loop overview

**Status:** Round 1 complete. Synthesis (AB) won unanimously 3–0.

## Files in this directory

| File | What it is |
|---|---|
| `task.md` | Original task brief: system context, 5 known problems, 6 threats, constraints, rubric, deliverable shape |
| `candidate-A.md` | Round 1 Generate-A. Stance: bearer for machines + HttpOnly cookie via one-shot `?token=` redemption + Origin/Host pinning. Single `authGate(kind)` middleware. |
| `critique-A.md` | Adversarial critique of A. Found 4 FATAL, 4 MAJOR, 2 MINOR. |
| `candidate-B.md` | Round 1 Generate-B. Departs structurally from A: path-segregated domains (upstream vs dashboard), stateless HMAC cookies via HKDF(AUTH_TOKEN), fragment bootstrap `#k=…`, Unix-socket hub IPC. |
| `candidate-AB.md` | Round 1 Synthesis. **Winner.** Takes B's structural separation + stateless HMAC + fragment bootstrap, keeps A's permanent `Authorization: Bearer` on the dashboard domain so existing CLI/CI scripts keep working. |
| `judge-transcripts.md` | Three blind judges' verdicts (architect / threat auditor / ops reviewer). 3–0 for AB. |
| `lineage.md` | Phase-by-phase chronicle of the reason loop, convergence status, and what to do next. |

## Winning stance (one paragraph)

> **Note:** This summary reflects the implementation deviations recorded in [`errata.md`](errata.md), not the original `candidate-AB.md` verbatim. Where this summary and `candidate-AB.md` disagree, `errata.md` is authoritative.

Split the auth surface into two domains with one shared root secret. On the **upstream domain** (`/v1/*` plus the WS upgrades to `/v1/responses` and `/v1/realtime`), accept `X-Ccxray-Auth: <K_upstream>` — a custom header that browsers cannot send cross-origin without a CORS preflight, which is never granted, so browser-initiated CSRF on the expensive upstream proxy is structurally impossible. (One carve-out: ChatGPT-OAuth Codex traffic cannot carry the header because builtin Codex providers cannot be overridden; for that path the upstream verifier accepts loopback-origin requests matching the ChatGPT-Codex header signature — see errata §1.3.) On the **dashboard domain** (`/`, `/_api/*`, `/_events`), accept any of three credentials in unified order — (1) `Authorization: Bearer <AUTH_TOKEN>` (preserved permanently for `curl` and CI), (2) stateless HMAC-signed session cookie `ccxray_s=<payload>.<HMAC(K_session, payload)>` derived via labeled HKDF from `AUTH_TOKEN` so sessions survive hub idle-shutdown and crash-recovery without any server-side session set, or (3) `X-Ccxray-Auth: <K_dashboard>` for advanced use. Cookies carry `HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` (no `Domain`); state-changing requests additionally pass a primary `Sec-Fetch-Site` check with `Origin` allowlist fallback, and every request passes a universal `Host` allowlist (no carve-outs). Bootstrap is a **single `ccxray open` command** that prints `http://localhost:5577/#k=<one-time>`; the URL fragment never reaches the server, never enters access logs, never appears in `Referer`, and is scrubbed via `history.replaceState` immediately after `POST /_auth/redeem`. Hub IPC moves off HTTP entirely onto a Unix domain socket (`~/.ccxray/hub.sock` mode `0600`, parent dir mode `0700`); the access gate is filesystem permissions (kernel returns `EACCES` to other UIDs at `connect(2)`) rather than `SO_PEERCRED`, which is not exposed by Node's public API — see errata §1.2. When `AUTH_TOKEN` is unset, ephemeral mode auto-generates a per-process secret stored at mode `0600` and refuses all non-loopback requests by default; "anonymous OK on 127.0.0.1" is removed because same machine ≠ same user.

## Threat coverage (winning design)

| # | Threat | Mitigation |
|---|---|---|
| 1 | Malicious-site CSRF | Upstream domain: CORS preflight never granted (custom header is non-simple); ChatGPT-Codex loopback-unauth carve-out (errata §1.3) is still safe because browsers cannot forge the `chatgpt-account-id` + JWT-shaped `Authorization` signature without same-UID compromise. Dashboard: `SameSite=Strict` cookie + primary `Sec-Fetch-Site` check + `Origin` allowlist fallback. |
| 2 | DNS rebinding | Universal `Host` allowlist on both domains (no exemption). Cookie has no `Domain` attribute (bound to exact host). |
| 3 | Token URL exfil | Bootstrap token lives only in the URL fragment — never reaches the server. One-time use, 60s TTL, single-redemption via POST. Permanent CLI bearer was never in a URL to begin with. |
| 4 | XSS-in-conversation | Session cookie `HttpOnly` — JS cannot read it. `K_upstream` never reaches browser context. CSP `default-src 'self'; connect-src 'self'`. Residual: in-page authenticated `fetch` from XSS is accepted as an XSS bug, not an auth bug. |
| 5 | Plain-HTTP eavesdrop | Out of scope by stated constraint. Ops doc: terminate TLS in front (Caddy / Tailscale Serve / SSH `-L`); set `CCXRAY_FORCE_SECURE_COOKIE=1`; add hostname to `CCXRAY_PUBLIC_ORIGINS`; terminator strips `X-Ccxray-Auth` before logging. |
| 6 | WS upgrade URL leak | Upgrade handler accepts `X-Ccxray-Auth` header (and the ChatGPT-Codex loopback-unauth carve-out from row 1 for the WS path); query token rejected with 401 at upgrade. Invariant: dashboard browser never opens a WS to ccxray (all live updates use SSE on `/_events`). |

## What's next

Two paths — your call:

- **Implement now.** AB swept 3–0 with non-correlated rationales from three different personas. Round 2 is unlikely to dethrone it; the design space's two natural extremes (A and B) are already explored.
- **Run Round 2** for full 3-round convergence (iterations cap = 3). Treats AB as incumbent, generates a fresh challenger, synthesizes again.

See `lineage.md` for full reasoning.
