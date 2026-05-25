# Round 1 — Judge Transcripts

Label mapping (revealed post-vote):
- X = candidate-AB.md (synthesis)
- Y = candidate-A.md
- Z = candidate-B.md

Vote tally: **X = 3, Y = 0, Z = 0** (unanimous for synthesis).

---

## Judge 1 — Security architect

WINNER: X

SCORES (Security / Convenience / Maintainability, 1–10):
- X: S=9 C=9 M=9
- Y: S=6 C=6 M=7
- Z: S=8 C=7 M=8

RATIONALE: X wins because it adopts the structural improvements that close the real holes in Y while preserving the back-compat that Z sacrifices. On Security, X gets a universal Host allowlist with no carve-out, an upstream domain that browsers cannot reach by construction (`X-Ccxray-Auth` is non-CORS-simple so preflight is required and never granted), stateless HMAC cookies that survive hub recycle, fragment-based one-time bootstrap that never reaches the server, and peer-UID-gated Unix socket IPC — all six threats are mitigated structurally rather than by policy branches. On Convenience, X is the only candidate that keeps `Authorization: Bearer <AUTH_TOKEN>` permanently valid on the dashboard domain (CI/CLI back-compat is load-bearing here), while still offering `ccxray open` as the one-step browser bootstrap. On Maintainability, X has a clean two-domain dispatcher with no `kind` enum to grow, two verifiers each ~50 LOC, and a crisp three-phase migration with explicit warn-only intermediate.

Y's strongest weakness is its in-memory `Set<sha256>` session store combined with the documented 5s hub idle-shutdown: every hub recycle invalidates every browser session, forcing constant re-redemption — the design's stated convenience claim ("cookie persists 8h") contradicts the system's actual lifetime. Y also routes the upstream policy through a single `authGate(kind)` that must remember to skip Origin for `upstream-proxy`, which is the kind of carve-out that re-breaks on the next refactor, and it puts the bootstrap token in the query string (Referer/log/bookmark leak surface).

Z's strongest weakness is breaking the explicit constraint that `curl -H 'Authorization: Bearer X'` keeps working trivially — Z requires CI scripts to migrate to `X-Ccxray-Auth` with `K_upstream` (an HKDF-derived value users must extract via a new `ccxray secret upstream` subcommand) and only grants `Authorization: Bearer` as a one-deprecation-cycle alias.

---

## Judge 2 — Threat-model auditor

WINNER: X

THREAT WALKTHROUGH:
- T1 CSRF: X passes (structural CORS preflight on upstream + SameSite/Sec-Fetch on dashboard), Y passes-but-fragile (skip-Origin carve-out one refactor away from regression), Z passes (same structural approach as X)
- T2 DNS rebind: X passes (universal Host allowlist, no carve-out), Y passes (Host allowlist + cookie without Domain), Z passes (universal Host allowlist)
- T3 Token-in-URL: X passes (fragment-only, never server-visible, single-use 60s), Y partial (token still hits server on `/` and `/_auth` GETs; bookmark residual acknowledged), Z passes (fragment-only, never server-visible)
- T4 XSS: X passes (HttpOnly + key isolation + CSP), Y passes-with-residual (HttpOnly only; AUTH_TOKEN used directly), Z passes (HttpOnly + key isolation + CSP)
- T5 Plain-HTTP: X / Y / Z all accepted-by-constraint with Secure flag guidance
- T6 WS leak: X passes (custom-header-only upgrade + no-browser-WS invariant), Y passes (bearer-only on upgrade), Z passes (custom-header-only + invariant)

RATIONALE: X and Z share the load-bearing structural choices; Y is materially weaker on three of six threats. On T1, Y's "skip Origin check for upstream-proxy" is functionally correct today but is a single-bug-away regression because policy is multiplexed through one polymorphic `authGate(kind)` — X/Z eliminate the branch by construction via CORS preflight on a non-simple custom header. On T3, Y's "?token= used exactly once at /_auth" still puts the secret in `req.url`, access logs, and the bookmarked address bar; X/Z move it to the fragment, which never reaches the server, plus enforce single-use 60s TTL — the leak channel is closed, not narrowed. Y also under-states its operational cost: A's in-memory `Set<sha256>` session set is wiped on hub idle-shutdown (5s after last client) and crash-recovery, forcing constant browser re-redemption, while X/Z's stateless HMAC cookies validate identically across hub recycles as long as AUTH_TOKEN is unchanged.

Between X and Z, both pass all six threats with equivalent structural rigor, but X keeps `Authorization: Bearer <AUTH_TOKEN>` permanently valid on the dashboard domain — which directly satisfies the "CLI/scripts MUST still work" constraint without forcing users to fetch a derived `K_upstream` via a new subcommand — while still using `X-Ccxray-Auth` exclusively on the upstream domain to preserve CORS-by-construction CSRF prevention.

---

## Judge 3 — Operational reviewer

WINNER: X

OPERATIONAL WALKTHROUGH:
- Hub idle/crash recovery: X=survives, Y=breaks (in-memory session set wiped every 5s idle), Z=survives
- Browser session across reload: X=survives, Y=breaks on server restart (sessions wiped), Z=survives
- Token rotation: X=clean (rotate AUTH_TOKEN, HKDF re-derives), Y=blunt but works (set wipe), Z=clean
- Multi-UID localhost: X=safe (ephemeral 0600 secret + peer-UID socket), Y=footgun (127.0.0.1 anonymous OK by default), Z=safe
- Remote behind TLS: X=works, Y=works, Z=works
- WS auth from browser: X=structurally N/A (invariant: no browser WS), Y=bearer-only but no invariant, Z=structurally N/A
- Files actually touched (auth surface): X≈9, Y≈4–5, Z≈8

RATIONALE: X wins because it survives the two operational realities that define ccxray's runtime — the hub's 5-second idle-shutdown and crash-fork recovery — without invalidating browser sessions, while keeping the curl ergonomics every CI script depends on. Y's in-memory `Set<sha256>` is fundamentally incompatible with the hub lifecycle described in the brief: every idle window wipes the set, so the user's browser dashboard 401s constantly during normal use. Y also leaves the "AUTH_TOKEN unset = 127.0.0.1 anonymous" default in place, which is a silent multi-UID localhost disaster on any shared dev host. Z fixes all of Y's operational gaps but pays an ergonomic tax: it drops `Authorization: Bearer <AUTH_TOKEN>` as the CLI credential in favor of `X-Ccxray-Auth: <K_upstream>` that users must retrieve via `ccxray secret upstream`, breaking every existing curl script.

X takes Z's structural wins and explicitly keeps `Authorization: Bearer <AUTH_TOKEN>` permanently valid on the dashboard domain. The convenience claim ("set AUTH_TOKEN + open one URL") is honest in X because the URL is a one-time fragment that auto-converts to a long-lived cookie surviving hub recycle. The footgun in X is the larger implementation surface (~9 files touched) but each piece composes cleanly and the auth-policy core still lives in 2 files. X is the only design where the convenience promise survives contact with the hub's actual idle/crash behavior.
