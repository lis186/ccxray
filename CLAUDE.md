# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What is ccxray

A transparent HTTP proxy that sits between Claude Code and the Anthropic API. It records every request/response, serves a real-time Miller-column dashboard at the same port, and supports request interception/editing. Zero config, zero dependencies beyond Node.js.

## Commands

```bash
npx ccxray claude                                # One command: proxy + Claude Code
ccxray claude                                    # Multiple terminals auto-share one hub
ccxray codex                                     # Proxy + Codex CLI
ccxray grok                                      # Proxy + Grok CLI (xAI)
ccxray --port 8080 claude                        # Custom port (opts out of hub, independent server)
ccxray status                                    # Show hub info and connected clients
ccxray                                           # Proxy + dashboard only
npm run dev                                      # Dev mode (auto-restart on server/public changes)
npm test                                         # Run tests
```

No build step. No linting. Restart to apply changes.

## Invariants

These constraints have guard comments at their mutation sites. Read the linked ADR before modifying the affected code.

- **entryIndex must mirror entries[]** at all push/trim sites (forward.js, ws-proxy.js, restore.js, store.js) — @docs/decisions/0003-entry-index-map.md
- **renderProjectsCol signature must include every field that affects rendered output** — adding a rendered field without updating `sigParts` = silent stale render — @docs/decisions/0002-dirty-check-signature.md
- **Skeleton early-return must clear innerHTML** before returning; skeleton containers must have the same `id` as the render function's `getElementById` target — @docs/decisions/0004-skeleton-lifecycle.md
- **agentKey main/subagent classification must gate on AGENT_KEY_UNRELIABLE** in both `entry-rendering.js` and `workflow-timeline.js` (`wfInferLanes`, `wfAddEntry`) — the two files must never disagree on the same turn — @docs/decisions/0005-agent-key-unreliable-shared-contract.md
- **Lane-focus geometry must match what `_wfRenderSvgContent` actually draws** — `_wfTotalLanesHeight`, `_wfLaneIdxAtY`, and the label-click hit-test in `workflow-timeline.js` must all agree with it under `laneFocusMode` — @docs/decisions/0006-lane-focus-geometry-consistency.md
- **Use `_wfIsMainLane(lane)` for main/orchestrator detection, never `!lane.spawnParent`** (`spawnParent` is always `null`, in every lane object, everywhere) — @docs/decisions/0007-wf-is-main-lane-not-spawn-parent.md
- **Temporal overlap overrides agentKey for lane placement** — the main lane is strictly serial (no temporally-overlapping turns); convId-keyed non-main lanes (`parallel-*:convId`, `agent-*:convId`) are resource pools where intra-lane overlap is allowed (#261); null-convId non-main lanes retain strict no-overlap split. Never exempt a main-lane turn from the overlap split because its agentKey looks authoritative (forks carry the parent's `orchestrator` key) — @docs/decisions/0008-temporal-overlap-overrides-agent-key.md
- **Sequential-interleave classification goes through the shared seq tracker in both files** (`wfCreateSeqTracker` in `workflow-timeline.js`; instances in `wfInferLanes`, `wfAddEntry`, and `entry-rendering.js` `addEntry`), and the tracker never consults `isCompacted` (fan-out first-turns carry a false flag) — @docs/decisions/0009-sequential-interleave-conv-bracketing.md

## Smoke Testing

UI or server changes must be verified in a real browser, not just unit tests. Unit tests verify logic; they don't catch lazy-load, SSE, or render pipeline failures.

```bash
CCXRAY_HOME=/tmp/ccxray-smoke-$$ ccxray --port 5602 --no-browser
```

- Loopback is trusted by default (dashboard + upstream + WS) — no env var needed
- Set `CCXRAY_LOOPBACK_REQUIRE_AUTH=1` to re-gate loopback (e.g. behind a reverse proxy)
- `CCXRAY_HOME` — isolates logs/hub/secrets from the user's real data
- Avoid port 5577 (user's hub) and any port already in use
- For browser verification use browser-harness (CDP/Chrome), not cmux-browser (WKWebView has SSE and JS eval issues)
- `BU_CDP_URL=http://127.0.0.1:<port>` — point browser-harness at a self-launched Chrome with `--remote-debugging-port=<port>` to skip the manual "Allow remote debugging" dialog

## Test Hygiene

`docs/testing.md` documents how the suite is run and the isolation rules every test must follow. In short: any test that touches storage or spawns the CLI/server must point `CCXRAY_HOME` at a throwaway temp dir with its own synthetic `index.ndjson` — never read the real `~/.ccxray`, never embed real logs/usernames/paths. `test/usage.test.js` is the canonical pattern.

Before pushing, confirm the suite passes against an empty home: `CCXRAY_HOME=$(mktemp -d) npm test`. CI runs the suite with an empty `CCXRAY_HOME` as a backstop, so a test that reads the real `~/.ccxray` (the PR #94 failure class) fails the build.

**Maintenance rule**: when you add a test that reads `CCXRAY_HOME`, depends on `$HOME`, or introduces a new fixture shape, keep `docs/testing.md` accurate — especially the `$HOME` vs `CCXRAY_HOME` distinction (scrubbing `$HOME` broadly breaks the puppeteer browser e2e tests).

**Verification rule**: 修 bug 類改動宣告完成前，須依 `docs/verification-principles.md` 附差異檢查證據——同一測試在舊碼 FAIL、新碼 PASS（fallback 流程見該文件末段）。純重構若出現 fail-on-old 的測試，視為行為變更警訊而非成就。效能改動附同條件 before/after 中位數，不收體感。

## Wire Protocol Documentation

`docs/wire-protocol-reference.md` documents observable wire-level differences between Claude Code (Anthropic Messages API) and Codex (OpenAI Responses API). Every field is tagged with a confidence level (`contractual`, `obs-stable`, `obs-fragile`) and a version range.

**Maintenance rule**: when you discover or fix a wire protocol behavior (new header, changed event shape, undocumented field), update `docs/wire-protocol-reference.md`:
1. Add/update the relevant row with the correct confidence tag and version range
2. Add a changelog entry at the top of the file (date, agent, version, what changed)
3. If a previously `obs-fragile` behavior is confirmed across a version bump, promote it to `obs-stable`

## Design Principles

`docs/design-principles.md` — UI design decision framework. Read before making visual/interaction design choices. Core hierarchy: Information Colocation (decision) → Channel Discipline + Layout Stability + Rendering Budget (constraints) → Follow Attention (behavior) → Implicit Bridging + Structured Emptiness (techniques).

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
| `public/workflow-timeline.js` | Swimlane workflow view (#91): v8 ctx-split turn bars, cost/event tracks, hover/lock spotlight, lane inference. Encoding spec: `docs/workflow-view-design.md` §v8 |
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

### Agent Launching (provider modules)

Launchers are **modules** in `server/providers.js` — not product forks. Full contract + how-to-add: **`docs/provider-modules.md`**.

1. **`AGENT_PROVIDERS.<id>`** — command name, install hint, `createLaunch({ port, args, env })`, optional `cwdFallback`
2. If it speaks Anthropic Messages → wire family is already `anthropic` via path routing
3. If it speaks OpenAI Responses (`POST /v1/responses`) but is **not** Codex → also add an **`OPENAI_WIRE_CLIENTS`** entry: `matchHeaders`, `upstreamKey` (host profile), `rawSessionId`, optional `sessionHeaderNames` / `controlPlaneIsNoise` / `modelPattern`. Reuse `wire-parsers/openai.js`; do not fork a new parser per agent.

Current modules: `claude` (anthropic), `codex` (openai → api.openai.com / ChatGPT), `grok` (openai client → `UPSTREAMS.xai`). Helpers: `describeAgentModule`, `listRawSessionBuckets`, `agentUsesCwdFallback`. Multi-agent acceptance: `test/multi-agent-proxy.e2e.test.js`. Avoid new `if (provider === …)` branches in `server/index.js`.
- `--no-browser` only suppresses browser auto-open. The dashboard remains available on the proxy port.
- Codex's main session traffic upgrades to a WebSocket on `POST /v1/responses` (with `openai-beta: responses_websockets=*`), not `/v1/realtime`. `/v1/realtime` exists for the older Realtime API but is not what current codex uses for normal `/goal` / chat turns. When ChatGPT auth is active, codex also sends `chatgpt-account-id`, which `getUpstreamForRequestAndHeaders` (see `server/config.js`) uses to route to `CHATGPT_BASE_URL` instead of `OPENAI_BASE_URL`.
- Codex 0.133+ pings platform endpoints on startup. All ChatGPT-platform paths (`/v1/plugins/*`, `/v1/ps/plugins/*`, `/v1/connectors/*`, `/v1/api/codex/*`, `/v1/codex/*`) and `/v1/models` are classified as noise by `isNoiseRequest` in `server/wire-parsers/openai.js`; `server/index.js` forwards them with `skipEntry: true` so they don't pollute the dashboard.
- Graceful shutdown: `spawnStandaloneAgent`, hub idle shutdown, and SIGTERM/SIGINT handlers route through `gracefulExit(code)` in `server/index.js`. It awaits `drainWebSocketProxy()` (force-finalizes any open WS sessions, awaits their `recordWebSocketEntry` promises) then `config.storage.drain()` (awaits pending fs writes) before calling `process.exit`, bounded by a 5s safety timeout. Without this, async storage writes for WS entries lose to `process.exit` and leave 0-byte log files.

### Data Flow

```
Claude Code → proxy receives request → detect session (explicit or inferred)
  → [intercept check] → log {id}_req.json → forward to Anthropic
  → capture SSE response → log {id}_res.json → calculate cost
  → broadcast via SSE (includes sessionInferred flag) → dashboard updates
```

Logs stored in `~/.ccxray/logs/` (not package-relative). Respects `CCXRAY_HOME` env var.

### Pricing lag overrides

`server/pricing.js` has `LITELLM_LAG_OVERRIDES` for models LiteLLM has not listed yet (e.g. new Grok wire ids). These are **temporary**:

1. On every `fetchPricing()`, if LiteLLM already has any watched `litellmKeys`, the override is **not applied** (LiteLLM wins) and startup prints a yellow `pricing lag override obsolete: … Delete the row…` reminder.
2. Search `LITELLM_LAG_OVERRIDES` or `pricing lag override` to find rows to delete.
3. Lifecycle tests live in `test/pricing.test.js` (`LITELLM_LAG_OVERRIDES lifecycle`).

Do not dump temporary rates into permanent `DEFAULT_PRICING` — that table is the offline safety net for Claude/OpenAI only.

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
