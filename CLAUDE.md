# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What is ccxray

A transparent HTTP proxy that sits between Claude Code and the Anthropic API. It records every request/response, serves a real-time Miller-column dashboard at the same port, and supports request interception/editing. Zero config, zero dependencies beyond Node.js.

## Commands

```bash
npx ccxray claude                                # One command: proxy + Claude Code
ccxray claude                                    # Multiple terminals auto-share one hub
ccxray --port 8080 claude                        # Custom port (opts out of hub, independent server)
ccxray status                                    # Show hub info and connected clients
ccxray                                           # Proxy + dashboard only
npm run dev                                      # Dev mode (auto-restart on server/public changes)
npm test                                         # Run tests
```

No build step. No linting. Restart to apply changes.

## Smoke Testing

UI or server changes must be verified in a real browser, not just unit tests. Unit tests verify logic; they don't catch lazy-load, SSE, or render pipeline failures.

```bash
CCXRAY_HOME=/tmp/ccxray-smoke-$$ CCXRAY_LOOPBACK_NO_AUTH=1 \
  ccxray --port 5602 --no-browser
```

- `CCXRAY_LOOPBACK_NO_AUTH=1` — dashboard has auth; this bypasses it for local testing
- `CCXRAY_HOME` — isolates logs/hub/secrets from the user's real data
- Avoid port 5577 (user's hub) and any port already in use
- For browser verification use browser-harness (CDP/Chrome), not cmux-browser (WKWebView has SSE and JS eval issues)

## Wire Protocol Documentation

`docs/wire-protocol-reference.md` documents observable wire-level differences between Claude Code (Anthropic Messages API) and Codex (OpenAI Responses API). Every field is tagged with a confidence level (`contractual`, `obs-stable`, `obs-fragile`) and a version range.

**Maintenance rule**: when you discover or fix a wire protocol behavior (new header, changed event shape, undocumented field), update `docs/wire-protocol-reference.md`:
1. Add/update the relevant row with the correct confidence tag and version range
2. Add a changelog entry at the top of the file (date, agent, version, what changed)
3. If a previously `obs-fragile` behavior is confirmed across a version bump, promote it to `obs-stable`

## Architecture

### Server (`server/`)

| Module | Purpose |
|--------|---------|
| `server/index.js` | Entry point: HTTP server, request routing, startup |
| `server/config.js` | PORT, ANTHROPIC_HOST/PORT/PROTOCOL, LOGS_DIR, MAX_ENTRIES, model context windows |
| `server/pricing.js` | LiteLLM price fetch, 24h cache, fallback rates, cost calculation |
| `server/cost-budget.js` | Cost data orchestration: cache, warm-up, grouping |
| `server/cost-worker.js` | Child process: scans `~/.claude/` JSONL files without blocking event loop |
| `server/store.js` | In-memory state: entries[] (capped at MAX_ENTRIES), sseClients[], sessions, intercept, versionIndex (keyed by `agentKey::coreHash`). Session detection with subagent inference (inflight + temporal heuristic) |
| `server/sse-broadcast.js` | SSE broadcast to dashboard clients, entry summarization |
| `server/helpers.js` | Tokenization, context breakdown, SSE parsing, formatting |
| `server/system-prompt.js` | KNOWN_AGENTS registry, agent type detection, B2 block splitting, unified diff |
| `server/restore.js` | Startup log restoration, lazy-load req/res from disk, delta chain reconstruction |
| `server/forward.js` | HTTP/HTTPS proxy to Anthropic, SSE capture, response logging, proxyRes error handling |
| `server/routes/api.js` | REST endpoints for entries, tokens, system prompt |
| `server/routes/sse.js` | SSE endpoint |
| `server/routes/intercept.js` | Intercept toggle/approve/reject/timeout |
| `server/routes/costs.js` | Cost budget endpoints |
| `server/hub.js` | Multi-project hub: lockfile (`~/.ccxray/hub.json`), discovery (with orphan port probe fallback), client registration, idle shutdown (injectable via setOnShutdown), crash auto-recovery |
| `server/auth.js` | API key auth middleware (enabled via `AUTH_TOKEN` env) |
| `server/openai-session.js` | Shared OpenAI/Codex header + session helpers (session id extraction, agent type, turn-metadata sidecar) |
| `server/ws-proxy.js` | OpenAI WebSocket transport proxy for `/v1/responses` and `/v1/realtime` upgrades. Tracks active sessions + pending `recordWebSocketEntry` promises so `drainWebSocketProxy()` can force-finalize stragglers and await writes on shutdown. Tunables: `CCXRAY_WS_IDLE_TIMEOUT_MS` (default 60s), `CCXRAY_WS_MAX_QUEUE_BYTES` (default 4 MiB; caps client→upstream buffer while upstream is connecting) |
| `server/storage/` | Storage adapters (local filesystem, S3/R2). `statShared()` for file mtime. `supportsDelta` flag gates delta-write eligibility. The factory wraps every adapter with a write-tracker that exposes `drain()` for graceful shutdown |

### Client (`public/`)

| File | Purpose |
|------|---------|
| `public/index.html` | Dashboard shell |
| `public/style.css` | Dark theme, Miller column layout |
| `public/app.js` | App initialization |
| `public/miller-columns.js` | Projects → Sessions → Turns → Sections → Timeline → Detail |
| `public/entry-rendering.js` | Turn rendering, session/project tracking |
| `public/messages.js` | Merged steps: thinking + tool groups, timeline detail, minimap rendering + layout |
| `public/cost-budget-ui.js` | Cost analysis page, heatmap, burn rate |
| `public/intercept-ui.js` | Pause/edit/approve/reject requests |
| `public/system-prompt-ui.js` | Multi-agent browsing (3-column Miller), version history, unified diffs |
| `public/keyboard-nav.js` | Arrow keys, Enter, Escape |
| `public/quota-ticker.js` | Topbar quota ticker |

### Hub Mode (multi-project)

```
ccxray claude (1st)  → fork detached hub → connect as client → spawn claude
ccxray claude (2nd)  → discover hub via ~/.ccxray/hub.json → connect as client → spawn claude
                              ↓
                     Hub (detached process)
                       ├── HTTP proxy on :5577
                       ├── Dashboard (same port)
                       ├── Client registry (register/unregister/health)
                       └── Idle shutdown (5s after last client exits)
```

- Hub lockfile: `~/.ccxray/hub.json` (written after `listen()` succeeds = readiness signal)
- Hub log: `~/.ccxray/hub.log` (stdout/stderr of detached process)
- `--port` opts out of hub mode entirely (independent server)
- Crash recovery: clients monitor hub pid every 5s, auto-fork new hub using port as mutex
- Version check: semver major mismatch → reject, minor → warn, patch → silent

### Agent Launching

- Launchers are registered in `server/providers.js`. Add future providers there with one entry for command name, display name, upstream family, launch args/env, and install hint; avoid adding new `if provider` branches in `server/index.js`.
- Claude mode sets `ANTHROPIC_BASE_URL=http://localhost:<port>` in the spawned Claude process.
- Codex mode spawns `codex -c 'openai_base_url="http://localhost:<port>/v1"' -c 'chatgpt_base_url="http://localhost:<port>/v1"' ...args`, covering both API-key and ChatGPT-auth Codex transports.
- Extra user args pass through unchanged after ccxray's injected launcher config.
- `--no-browser` only suppresses browser auto-open. The dashboard remains available on the proxy port.
- Codex's main session traffic upgrades to a WebSocket on `POST /v1/responses` (with `openai-beta: responses_websockets=*`), not `/v1/realtime`. `/v1/realtime` exists for the older Realtime API but is not what current codex uses for normal `/goal` / chat turns. When ChatGPT auth is active, codex also sends `chatgpt-account-id`, which `getUpstreamForRequestAndHeaders` (see `server/config.js`) uses to route to `CHATGPT_BASE_URL` instead of `OPENAI_BASE_URL`.
- Codex 0.133+ pings ~10 platform endpoints on startup (`/v1/plugins/*`, `/v1/ps/plugins/*`, `/v1/connectors/*`, `/v1/api/codex/apps`, `/v1/api/codex/usage`). `isCodexPlatformNoisePath` in `server/config.js` flags them; `server/index.js` forwards them with `skipEntry: true` so they don't pollute the dashboard. `/v1/codex/analytics-events/events` (the telemetry endpoint) is intentionally kept visible — a follow-up will parse turn metadata out of it.
- Graceful shutdown: `spawnStandaloneAgent`, hub idle shutdown, and SIGTERM/SIGINT handlers route through `gracefulExit(code)` in `server/index.js`. It awaits `drainWebSocketProxy()` (force-finalizes any open WS sessions, awaits their `recordWebSocketEntry` promises) then `config.storage.drain()` (awaits pending fs writes) before calling `process.exit`, bounded by a 5s safety timeout. Without this, async storage writes for WS entries lose to `process.exit` and leave 0-byte log files.

### Data Flow

```
Claude Code → proxy receives request → detect session (explicit or inferred)
  → [intercept check] → log {id}_req.json → forward to Anthropic
  → capture SSE response → log {id}_res.json → calculate cost
  → broadcast via SSE (includes sessionInferred flag) → dashboard updates
```

Logs stored in `~/.ccxray/logs/` (not package-relative). Respects `CCXRAY_HOME` env var.

### Codex First-Turn Input Backfill

Codex's first WS turn sends `input=[]` in `response.create` — the user's prompt is handled by the Codex CLI framework and never appears in any WebSocket frame field. Starting from the second turn, `input` includes full conversation history (all prior user/assistant messages).

**Workaround** (`ws-proxy.js:backfillFirstTurnInput`): when a turn arrives with non-empty `input`, we check if the previous turn in the same session has empty `input`. If so, we extract everything before the first assistant response and write it back to the previous turn's `_req.json`. The next lazy-load picks it up and the timeline shows the user's question.

**Limitation**: the backfill only takes effect after the second turn is recorded. If the user only sends one turn, or views Turn 1 before Turn 2 completes, the user's question won't appear in Turn 1's timeline. A page refresh after Turn 2 completes resolves this.

### Delta Log Storage

Each `_req.json` normally stores the full `messages` array. For long sessions this wastes 85–90% of disk space (each turn re-stores the entire conversation history). Delta storage writes only new messages and a pointer to the previous turn.

**Format** (delta turn):
```json
{ "model": "...", "max_tokens": 8096, "prevId": "2026-05-01T11-47-17-808", "msgOffset": 18,
  "messages": [ /* only messages[18..] */ ], "sysHash": "...", "toolsHash": "..." }
```

**Format** (full / anchor turn):
```json
{ "model": "...", "max_tokens": 8096, "messages": [ /* all */ ], "sysHash": "...", "toolsHash": "..." }
```

Rules:
- Delta only applies to sessions with an explicit `session_id` (main orchestrator turns). Subagents and inferred sessions always write full format.
- First turn of a session = always full (chain anchor).
- Compaction (messages shrinks) = always full (resets chain).
- `supportsDelta: false` on the storage adapter (e.g. S3) disables delta entirely.
- `CCXRAY_DELTA_SNAPSHOT_N=N` forces a full snapshot every N delta writes (default `0` = only session-start anchor). Use `5` for S3-backed setups.

**Read side**: `loadEntryReqRes` detects `prevId`, recursively loads the chain, and splices `prevMessages[0..msgOffset]` + delta messages. Results are cached in memory (per entry). If `prevId` entry has been pruned, gracefully degrades to showing only the delta portion.
