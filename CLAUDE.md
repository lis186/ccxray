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

These constraints are enforced by structural encapsulation where possible, and guard comments elsewhere. Read the linked ADR before modifying the affected code.

- **entryIndex must mirror entries[]** — all push sites use `store.registerEntry()` (push + index + aliases atomically); `trimEntries` is the caller's responsibility. `test/invariant-encapsulation.test.js` blocks raw `entries.push`/`entryIndex.set` outside `store.js` — @docs/decisions/0003-entry-index-map.md
- **responseId merge: every store-push site dedups through the shared helper and keeps `responseIndex` + entryIndex aliases in sync** — cold-load/restore use `store.mergeByResponseId`, the live forward.js sites use `store.registerOrMerge`, and `trimEntries` must delete a canonical's `_mergedIds` aliases + its responseIndex slot. A push site that updates entryIndex but not responseIndex (or forgets alias handling) silently reintroduces duplicates or breaks a delta chain (entryIndex + alias sync is structurally prevented by `registerEntry`; responseIndex sync remains manual via `registerOrMerge`). OpenAI/WS entries carry no responseId (exempt) — @docs/decisions/0012-response-id-read-time-merge.md
- **renderProjectsCol signature must include every field that affects rendered output** — adding a rendered field without updating `sigParts` = silent stale render — @docs/decisions/0002-dirty-check-signature.md
- **Skeleton early-return must clear innerHTML** before returning; skeleton containers must have the same `id` as the render function's `getElementById` target — @docs/decisions/0004-skeleton-lifecycle.md
- **agentKey main/subagent classification must use `isMainTurnByAgentKey` from `agent-classification.js`** in `entry-rendering.js`, `workflow-timeline.js`, and `server/session-index.js` `_upsert()` (window fold only — weather filters keep raw `isSubagent` because L1 alone over-includes without L2-L5). The Herdr plugin is a documented EXCEPTION — `mainDisplayTurns` must not use that predicate (it returns true for the `agentKey:'agent'` shape the badge exists to exclude) — but the plugin's two surfaces must then agree on every figure that CAN agree. ANCHORED on `mainDisplayTurns` in both `summarizeTurnGroup` and `missionControlRow`, and must match: model label, context window + ctx% (read the latest anchored turn directly — `contextPercents` drops turns with no usage, so its last element can be an older turn), cache%, tool failures, prompt-change. WHOLE-SESSION in both, and must match for a same-session subagent: evidence freshness ("seen" — the row reads `observedLatestAt`, not main-only `latestAt`; the two sets still differ for a child-session subagent, a recorded residual). NOT comparable by design: cost, turn count, and the two time figures (with a hub aggregate the badge's `ageText` is a DURATION while the row's `sessionAge` is elapsed-since-start; without one they coincide) — the badge reports the hub's per-session aggregate (the plugin's 4 MiB tail is a sample), the row reports the main-agent tail sum plus a separately labelled subagent rollup — @docs/decisions/0005-agent-key-unreliable-shared-contract.md
- **Lane-focus geometry must match what `_wfRenderSvgContent` actually draws** — `_wfTotalLanesHeight`, `_wfLaneIdxAtY`, and the label-click hit-test in `workflow-timeline.js` must all agree with it under `laneFocusMode` — @docs/decisions/0006-lane-focus-geometry-consistency.md
- **Use `_wfIsMainLane(lane)` for main/orchestrator detection, never `!lane.spawnParent`** (`spawnParent` is always `null`, in every lane object, everywhere) — @docs/decisions/0007-wf-is-main-lane-not-spawn-parent.md
- **Temporal overlap overrides agentKey for lane placement** — the main lane is strictly serial (no temporally-overlapping turns); same-convId overlap turns (jitter/re-send/rewind) ride main's `overlapEntries` as event markers, never a separate lane (#364); different-convId overlaps still create `parallel-*`/`agent-*` lanes; null-convId non-main lanes retain strict no-overlap split. `_wfSeqRetroMove` must rebuild `mainConvIds` and migrate stale markers after every retro-move — @docs/decisions/0008-temporal-overlap-overrides-agent-key.md
- **Sequential-interleave classification goes through the shared seq tracker in both files** (`wfCreateSeqTracker` in `workflow-timeline.js`; instances in `wfInferLanes`, `wfAddEntry`, and `entry-rendering.js` `addEntry`), and the tracker never consults `isCompacted` (fan-out first-turns carry a false flag) — @docs/decisions/0009-sequential-interleave-conv-bracketing.md
- **coreHash lane ownership is per-CONVERSATION, never per-turn** — in `wfInferLanes` a main-agentKey turn is a subagent iff NONE of its conversation's *plurality-tied* coreHashes (`_wfComputeConvIdentity`, `convMaxHashes` = the hashes sharing the max count) is in `mainCoreHashSet` (the seed conversation's dominant only — routing is per-conversation, so a mixed `/model` conversation already rides main as a unit; adding a main conversation's *secondary* coreHashes over-merges a separate subagent sharing that hash — real c6e1ddaa). A lone seed/blip turn carrying main's coreHash is a minority so it cannot flip its conversation into main (add88512); a genuine plurality tie resolves toward main-membership so a `/model`-switching compaction successor is not ejected. Seed = the earliest-starting main-agentKey CONVERSATION that has a coreHash (not the earliest coreHash-bearing turn — else a subagent could seize the seed when main opens coreHash-less). This REWRITES ADR 0010's per-turn early-exit for the batch path; the live `wfAddEntry` + turn-list still use the per-turn form pending A2 (#350) — @docs/decisions/0010-corehash-identity-routing.md
- **context% denominator: display folds a per-session window, classification never does** — display sites (session card, its window label, timeline minimap, swimlane) divide by `sessionCtxWindow(sid)` (or the `_wfWinByTurn` lane fold): 1M if any main turn has `beta1m===true` (authoritative, `SUPPORTS_1M`-gated at write time), else the largest `maxContext` fossil (heals legacy), else 200K. Classification (`isCompacted`, per-turn `severity`, lane placement) keeps dividing by raw per-turn `maxContext` — never the fold (feeding a future-dependent latch into a prefix-local classifier reintroduces the reverted live≠batch divergence). The fold is stateless-at-render (never a stored `sess.maxWindow` → can't go stale); `beta1m` is persisted add-only so it's rebuildable. Never cross the two — @docs/decisions/0013-beta1m-persist-session-window-derive.md
- **persisted weather carries a derivation revision; all three writers stamp it through `_assignWeather`** — the load-time probe tests field EXISTENCE and `reconcile` compares COUNTS, so neither notices a change in HOW weather is derived; a semantics change without a `WEATHER_REV` bump leaves every cold session card rendering the deleted rule with all checks green. An unstamped writer (restore's step-6 `setWeather` overwrites the rebuild's output) turns the probe into a permanent rebuild loop — @docs/decisions/0013-beta1m-persist-session-window-derive.md
- **cost-worker lifecycle: imported mode is side-effect free, executed mode exits by drain** — R1 no handle may ref the loop past the final stdout write; R2 no `process.exit()` on success; R3 one result protocol (stdout JSON); R4 adding an env-derived root obliges updating `isolatedEnv()` in every test that forks the worker — @docs/decisions/0015-cost-worker-lifecycle-drain-exit.md
- **All restoreFromLogs streaming passes bind to `snapshotBytes`** + id guard (`store.entryIndex.has`) + buffer bridge (`beginRestoreBuffer`/`endRestoreBuffer`); adding a new index-streaming pass without binding to the snapshot byte bound silently re-opens the live-append race — @docs/decisions/0016-restore-stream-snapshot-byte-bound.md
- **Aggregate cost display goes through `formatAggCost`/`formatAggCostText` with a complete confidence fold** (`fallbackCost`/`fallbackCount`/`unknownCount`/`count`); a site that renders `'$'+total.toFixed()` directly, or omits a component stream from the fold, silently reverts to unmarked fabrication. Per-turn sites keep `formatCost`/`formatCostText` (#422). This holds ACROSS PROCESSES: `public/format.js` is isomorphic so the Herdr plugin requires the real helper (defensively) instead of re-deriving thresholds; its degraded mode renders unmarked plus `—`/`+`, never worst-of `~` — @docs/decisions/0017-aggregate-cost-confidence.md
- **`turnToolCalls` null-vs-empty contract (Anthropic entries): `null`/`undefined` means legacy or missing response data and permits fallback to cumulative `toolCalls` using per-tool max; `{}` means a parsed response with zero tool calls and must suppress fallback because it is truthy; OpenAI/Codex entries are exempt — their `toolCalls` is already per-turn and should be summed directly** — @docs/decisions/0018-turn-tool-calls-null-vs-empty.md
- **The `x-ccxray-*` request-header namespace is default-deny BY PREFIX, from one shared module** — `server/internal-headers.js` `isInternalHeader()` is used by both forward paths (`server/index.js` `buildForwardHeaders`, `server/ws-proxy.js` `buildWebSocketHeaders`). It replaced a two-member allowlist that was duplicated in those two files, which shipped `x-ccxray-agent-id` to Anthropic: the header was added at the injection site only, and the one e2e strip test named members rather than the rule, so nothing went red. `FORWARD_ALLOWED` is empty by design — ADR 0012 Layer B's `x-ccxray-relay` becomes an explicit exception (and reading an INBOUND relay never needs one: stripping builds the outbound set)
- **A process other than the hub may append `index.ndjson`, but must never write a derived view** — `session-index.js` `tmpPath()` is a FIXED name, so tmp+rename protects against a crash, not a second writer; two flushers can rename each other's half-written `sessions.json`. `ccxray import --once` sets `CCXRAY_SESSION_INDEX_NO_FLUSH=1` and appends only; the hub re-derives via the existing "index.ndjson newer than sessions.json" rebuild. A new second writer must declare which side it is on — @docs/decisions/0019-second-writer-appends-never-derives.md

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
| `server/openai-response.js` | OpenAI Responses API helpers: response-object detection, field extraction |
| `server/ws-proxy.js` | OpenAI WebSocket transport proxy for `/v1/responses` and `/v1/realtime` upgrades. Tracks active sessions + pending `recordWebSocketEntry` promises so `drainWebSocketProxy()` can force-finalize stragglers and await writes on shutdown. Tunables: `CCXRAY_WS_IDLE_TIMEOUT_MS` (default 60s), `CCXRAY_WS_MAX_QUEUE_BYTES` (default 4 MiB; caps client→upstream buffer while upstream is connecting) |
| `server/entry.js` | `INDEX_FIELDS`, `buildIndexLine`, `deploymentFields` — the index-line schema definition. Invariants reference this file |
| `server/export-sync.js` | Daily + session summary exporter to GCS (#505). Hourly flush + shutdown hook, cross-process lock via `hub.js:tryAcquireForkLock`, cursor-based incremental scan. Env: `CCXRAY_EXPORT_GCS_BUCKET`, `CCXRAY_EXPORT_CWD_ALLOWLIST`, `CCXRAY_USER_EMAIL`, `CCXRAY_TEAM` |
| `server/importer.js` | Imports Claude/Codex transcripts from `~/.claude*/`/`~/.codex*/` into the index on startup. Does NOT push `store.entries` (only writes index lines) |
| `server/rebuild-index.js` | `ccxray rebuild-index` CLI — rebuilds `index.ndjson` from surviving `_req/_res` log files |
| `server/import-once.js` | `ccxray import --once` CLI — throttled, lock-guarded single-shot transcript scan for a dashboard that has noticed the index fell behind. Appends index lines only and sets `CCXRAY_SESSION_INDEX_NO_FLUSH=1`, so it may run beside a live hub (unlike `rebuild-index --reimport`, which refuses). Env: `CCXRAY_IMPORT_ONCE_MIN_INTERVAL_MS` (default 10min) |
| `server/usage.js` | Per-turn usage extraction and session-level aggregation helpers |
| `server/local-usage-reader.js` | Reads Claude/Codex local transcript files for the cost-worker |
| `server/delta-helpers.js` | Shared helpers for delta log storage (live server + restore) |
| `server/plan-detector.js` | Auto-detect Claude Code subscription plan from response usage data |
| `server/plans.js` | Known plan definitions (token thresholds, names) |
| `server/paths.js` | Path resolution helpers (`CCXRAY_HOME`, log dirs) |
| `server/ratelimit-log.js` | Rate-limit event logging |
| `server/settings.js` | Server-side settings persistence (`~/.ccxray/settings.json`) |
| `server/url-sanitize.js` | URL sanitization for logged entries |
| `server/storage/` | Storage adapters (local filesystem, S3/R2). `statShared()` for file mtime. `supportsDelta` flag gates delta-write eligibility. The factory wraps every adapter with a write-tracker that exposes `drain()` for graceful shutdown |
| `server/adapters/` | Provider-specific transcript adapters (`claude-adapter.js`, `codex-adapter.js`, `grok-adapter.js`) for the importer |

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
| `public/weather.js` | Session weather score — isomorphic pure function (browser `<script>` + Node `require`). Reads entry objects directly |
| `public/format.js` | Shared formatting/color helpers (#156). `formatAggCost`/`formatAggCostText` (ADR 0017), `formatCost`/`formatCostText` (per-turn) |
| `public/session-label.js` | Named session label registry |
| `public/settings.js` | Client-side settings loader (plan config from `/_api/settings`) |
| `public/cache-notify.js` | Cache expiration notification — tab-title flash + countdown |
| `public/countdown-ticker.js` | Cache TTL countdown ticker on session cards |

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
- **Hub mode is narrower than it looks.** `hubMode` is set ONLY by the internal `--hub-mode` flag (`server/index.js:53`), which the detached hub gives itself. These all run as independent servers sharing the same `CCXRAY_HOME`:
  - `ccxray --port N <agent>` — explicit port opts out (`index.js:1185`; no lockfile, `:1116`)
  - `ccxray` with no agent — standalone proxy + dashboard
  - **Windows, always** — hub requires Unix sockets, so `--hub-mode` exits with an error (`index.js:55-57`)

  Only `ccxray <agent>` with no explicit port forks a detached hub. Anything reasoning about "one process per machine" (cross-process locks, cursors, shared-file writers) must use this list, not the `--port` case alone.
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

`server/default-rates.js` has `LITELLM_LAG_OVERRIDES` for models LiteLLM has not listed yet (e.g. new Grok wire ids). These are **temporary**:

1. On every `fetchPricing()`, if LiteLLM already has any watched `litellmKeys`, the override is **not applied** (LiteLLM wins) and startup prints a yellow `pricing lag override obsolete: … Delete the row…` reminder.
2. Search `LITELLM_LAG_OVERRIDES` or `pricing lag override` to find rows to delete.
3. Lifecycle tests live in `test/pricing.test.js` (`LITELLM_LAG_OVERRIDES lifecycle`).

`DEFAULT_PRICING` (in `server/default-rates.js`) is the offline safety net (Claude/OpenAI/Grok bare ids). Temporary rates for models LiteLLM still lacks go in `LITELLM_LAG_OVERRIDES` only (currently `grok-build` / `grok-build-0.1`).

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
