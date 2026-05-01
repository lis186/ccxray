# Changelog

## 1.8.0

### Added

**Delta log storage**

- **`_req.json` files now store only what's new in each turn**, plus a `prevId` / `msgOffset` pointer back to the previous turn in the same session. Long sessions used to re-record the entire conversation history every turn; that's gone. Per-turn compression measured at 95–99% on dogfood data.
- **Read side reconstructs transparently**: `loadEntryReqRes` follows the `prevId` chain on demand, with per-entry promise dedup and graceful degrade when a referenced entry has been pruned. Dashboard rendering and existing API consumers see the full `messages` array exactly as before.
- **Safety rails**: delta only fires for sessions with an explicit `session_id` (main-orchestrator turns); subagents and inferred sessions always write FULL. Compaction (messages shrinking) resets the chain. Storage adapters that don't support delta (e.g. S3 — multi-writer races on prevId chains) opt out via `supportsDelta: false`.
- **`CCXRAY_DELTA_SNAPSHOT_N`** env var: force a FULL snapshot every N delta writes. Defaults to `0` (only the session-start anchor). Recommended `5` for S3-backed setups.

**One-shot migration script**

- `node scripts/migrate-to-delta.js [--write] [--snapshot-n N]` rewrites existing FULL `_req.json` files in place to delta format. Dry-run by default; atomic temp-file + rename per file (crash-safe). On the dogfood instance: ~5.3 GB of disk recovered (9,828 conversions, 95–99% per-turn compression, verified by full reconstruction round-trip).

### Changed

- **`README` refreshed** (en / zh-TW / ja in lockstep): added Features sections for Intercept & Edit Requests and Context HUD, a dedicated S3 / R2 storage backend subsection, and the previously-undocumented `LOG_RETENTION_DAYS` and `RESTORE_DAYS` env vars. Agent type count corrected (12 → 11) and the version-stamped `ccxray status` example replaced with a generic one.

### Internal

- **`server/delta-helpers.js`**: shared module exposing `msgNorm`, `findSharedPrefix`, and `findSharedPrefixFromLast`. Replaces an inline copy that previously lived in both `server/index.js` and `scripts/migrate-to-delta.js` (the migration script's comment explicitly flagged it as drift-prone).
- **+44 tests** covering write decision helpers, restore chain reconstruction (single hop, multi-hop, pruned-prev fallback, concurrent loads, empty-delta full-match), and the migration script (canDelta, safeParseFirst legacy double-JSON, probeChainDepth, plus end-to-end subprocess tests for sub-agent filtering, chain resume across existing deltas, and anchor-by-reason accounting).

## 1.7.0

### Added

**Per-line attribution in `~/.ccxray/hub.log`**

- **REQUEST and RESPONSE lines now self-identify**: every proxy log line carries `[<project>/<session8> · #<sessNum> R<turn>.<step>]` in front, plus a `✓` / `✗` glyph on responses. Hub mode with multiple projects can now be `grep`'d by project (`grep "[ccxray/" hub.log`), and any single line in isolation tells you which conversation, which human input round, and which tool-loop step it came from. Special prefixes for the non-standard cases: `[quota-check]`, `[orphan/<reqId>]`, `direct-api` rendered verbatim, and a trailing `~` when session attribution was inferred from temporal heuristics rather than an explicit session_id.

- **Logical turn / step computation** (`computeTurnStep` in `server/helpers.js`) — pure function deriving turn (count of human-text user messages in `messages[]`) and step (user-message count from the last human-text opener inclusive to end). Treats `<system-reminder>`, `<user-prompt-submit-hook>`, `<context>`, and antml-injected blocks as system noise, not turn openers. The same regex the dashboard uses, now extracted to `shared/injected-tags.js` with a CI drift-guard test that fails if the dashboard's inline copy diverges.

- **Hub-aware cwd fallback**: when a session's first logged request lacks `Primary working directory:` in its system prompt (e.g. immediately after a quota check), the prefix's `<project>` field falls back to the hub's unique registered client cwd instead of `?` — most first-of-session lines now show their project name from line 1.

**Context HUD discoverability**

- **Context HUD toggle in topbar** (originally contributed by @jspelletier as "Inject stats"; renamed and made discoverable in this release), persisted in `~/.ccxray/settings.json`. The 📊 Context stats block appended to Claude responses can now be turned off — important for sub-agent workflows where the injected block was truncating the Agent tool result visible to the parent Claude. Tooltip shows the literal HUD line that gets appended (`📊 Context: 28% (290k/1M) | 1k in + 800 out | Cache 99% hit | $0.15`) so the trade-off is visible before flipping it.

- **Startup + toggle log lines**: server prints `Context HUD: enabled/disabled (settings.json)` on first settings load and `(toggled from dashboard)` on each flip — terminal-side users see the state without having to look at the dashboard.

**Other observability signals**

- **`coreHash` per entry**: MD5 of the system prompt's core-instructions block (distinct from `sysHash` which covers the whole system block). Lets the dashboard distinguish "system prompt changed" from "tools list changed" without diffing — useful when chasing why a session's behaviour shifted mid-conversation.

- **"Thinking stripped" badge** on turn cards: when the previous non-subagent turn in the same session had thinking blocks and the current request has none (and message count didn't drop, ruling out compaction), the card flags it. Catches client-side regressions where thinking content gets dropped before forwarding.

- **Storage-aware log retention**: `pruneLogs` now routes through the storage adapter's new `deleteFile()` method, so S3/R2 backends and `CCXRAY_HOME` overrides get pruned correctly. Pre-1.7.0 the prune was hardcoded to local `fs.unlinkSync`, silently no-op'ing on non-local storage and producing 404s on lazy-load when `RESTORE_DAYS > LOG_RETENTION_DAYS`. Pruning is also now re-ordered to run **after** restore, so payload files for any in-memory entry are protected from deletion.

### Changed

- **REQUEST / RESPONSE log line format**: was `📤 REQUEST [HH:MM:SS]  METHOD URL` followed by a four-line `Model / System / Tools / Messages` summary. Is now a two-line layout — line 1 is `📤 [HH:MM:SS]  [<prefix>]  METHOD URL`, line 2 is the indented `model · sys N · msgs M`. The `Messages: 42 (21 user, 21 assistant)` line is gone (turn / step in the prefix conveys the same shape more directly). The `Tools: …` list is also gone — tool changes are tracked by hash and visible in the dashboard. **If you script against `hub.log`, your parsers will need updating.**

- **Session banner fires once per session, not per switch**: the `★★★ NEW SESSION ★★★` line previously printed every time the active session id differed from the last one seen (`realId !== currentSessionId`). In hub mode running two projects, switching A → B → A printed three banners — visually implying three new sessions when there were only two. The trigger is now "first sighting of this sid" via per-sid `bannerPrinted` flag; switching back to a known session no longer banners. `direct-api` keeps the existing reset-on-msgcount-drop behaviour (a fresh direct-api conversation is treated as a new session).

- **`⚡ cc version` moved from a framed badge to a muted subline** under the System row. The framed badge crowded the row and forced the `6,xxx tok` chip onto a wrapped second line. Subline is small, dim, no icon, right-aligned to the badge's right edge.

- **Settings reads now O(1)** from an in-memory cache after first startup load. Pre-1.7.0 every `GET` / `POST` `_api/settings` did a synchronous disk read, blocking the event loop on hub-shared workspaces with frequent toggles.

### Fixed

- **Sub-agent tool-result truncation**: the injected 📊 Context stats block was being clipped from the Agent tool result visible to the parent Claude in sub-agent workflows. Toggling the Context HUD off (now persisted across restarts) avoids it. — thanks @jspelletier!

- **`POST /_api/settings` falling through to the GET handler**: the settings POST endpoint was missing a method check, so writes from the dashboard occasionally landed in the wrong handler and silently no-op'd. Now correctly routed.

- **Settings write errors silently ignored**: write failures (disk full, permissions) used to be swallowed. They now log to stderr and the dashboard reverts the toggle UI to the persisted state on failure.

- **`cc_version` regex bug** in `miller-columns.js` (`(S+?)` → `(\S+?)`): the version capture group was unanchored and matched stray characters under some prompt shapes.

- **Session filter flash on new card insert**: the filter would briefly show the new card before re-applying, producing a visible flash. The filter is now applied at insert-time.

- **Clicking an already-selected project no longer deselects it**: was a UX papercut where a stray click cleared the project filter.

- **HTML `lang` attribute**: was `zh-TW`, corrected to `en`. — thanks @jspelletier!

### Removed

- **`thinkingBudget` from turn cards and SSE broadcast** (briefly added during this cycle): the `budget:high/med/low` indicator on turn-card line 4 was carrying no actionable information — `thinking_budget` is set client-side and doesn't change per-turn in a way that warranted dedicated UI real estate. Both the per-entry field and the line-4 render are gone.

### Thanks

- [@jspelletier](https://github.com/jspelletier) — original "Inject stats" toggle implementation, which this release renamed to "Context HUD" and made discoverable, plus the HTML `lang` fix.
- Claude Sonnet 4.6 — co-author on 6 commits (settings cache, filter flash, project deselect, etc.).
- Claude Opus 4.7 (1M context) — co-author on 6 commits (log attribution prefix, turn card signals, banner once-per-session, etc.).

## 1.6.0

### Breaking

- **Removed `≈N turns left` prediction from session cards.** Empirical backtest against 15 real sessions showed the predictor's median absolute percentage error was 43% (mean 87%), with worst-case 10× overestimate. Root cause was structural: a 5-turn arithmetic mean of `tokens.messages` delta is fundamentally unstable against conversations with phase shifts (heavy file reads → mid-session tool use → light end-of-session wrap-up). No repair path was found — Theil-Sen/robust variants tested worse (MAPE 135%). The UX lie (showing 367 turns remaining when ctx was already at 83%) was the original bug trigger. Replaced with factual signals — see the context-visualization features below. Full decision trail: [`openspec/changes/remove-prediction-add-countdowns/`](openspec/changes/remove-prediction-add-countdowns/) and [`docs/process-study-turns-left-pivot.md`](docs/process-study-turns-left-pivot.md).

### Added

**Context-visualization series — one visual language across three levels**

- **Auto-compact reference line at ~83.5%**: every session card, turn card, and turn-detail usage bar now shows the Claude Code auto-compact threshold as a vertical tick on the context bar, so you can see at a glance how much runway you have before auto-compaction triggers. Tick position driven by a single `--compact-threshold` CSS variable fed from `/_api/settings` — Anthropic moving the threshold is a one-line edit.

- **Cache TTL countdown on session cards**: active session cards show `cache Nm ⏱` with layered throttling — ≥5m updates per 10s (cache-far), 1–5m per second (cache-near), <1m pulses red (cache-close), then switches to static `cache expired`. Historical sessions omit the row entirely to keep the list scannable.

- **Tab-title flash + browser notification on cache expiry**: when any active session has <60s of cache left, the browser tab title alternates between `ccxray` and `⚠ ccxray` (zero permission, works in background tabs). Opt-in browser Notification fires at a plan-aware lead time — 5 minutes for Max, 60 seconds for Pro/API key. Permission prompt deferred until the user clicks the 🔔 toggle (never on page load).

- **Auto-detected subscription plan**: ccxray reads Anthropic response usage (`cache_creation.ephemeral_5m/1h_input_tokens`) to infer Pro vs Max with no configuration needed. Env var `CCXRAY_PLAN=pro|max5x|max20x|api-key` overrides auto-detection. Topbar shows current plan + cache TTL: `Plan: Max 5x · TTL 1h (auto)`. Verified on 464 real response logs: 100% clean signal.

- **Plan-aware quota panel**: the cost-budget panel (ROI badge, token-limit fallback, "plan fit" dropdown) now reads from the detected plan instead of the hardcoded Max 20x values. Max 5x subscribers previously saw ROI exactly half of true value — now correct.

- **Rate-limit header persistence** (`server/ratelimit-log.js`): `anthropic-ratelimit-*` response headers are appended to `~/.ccxray/ratelimit-samples.jsonl` (deduped per model) for future calibration of plan-specific token quotas. Analyse with `node scripts/analyze-ratelimit-samples.mjs`.

**Session identification**

- **Sessions column shows Claude Code's generated title.** Each session card now displays the human-readable title from Claude Code's title-generator subagent (e.g. `Fix login button on mobile`) instead of the 8-character hash. Card wraps to at most two lines; the short hash moves to the hover tooltip and is still accessible via the copy button and URL deep-link (`?s=`). Breadcrumb and intercept overlay follow the same rule. Sessions without a title (direct-api traffic, legacy sessions, title-gen still in flight) fall back to the short hash exactly as before.
- **Title persistence across restart.** Title-gen entries store the extracted clean title in the existing `index.ndjson` per-turn column; `restore.js` replays them onto `sess.title` on startup with zero extra I/O.
- **Kill switch.** Set `CCXRAY_DISABLE_TITLES=1` to disable title extraction entirely.

**Corporate proxy and custom upstream support** (contributed by @jspelletier)

- **HTTPS CONNECT tunnel**: Set `HTTPS_PROXY` or `https_proxy` to route outbound traffic through a corporate proxy. Node.js ignores these variables natively for `https.request`; ccxray now wires up an HTTP CONNECT tunnel agent automatically.
- **Base path support for `ANTHROPIC_BASE_URL`**: Paths were previously discarded, causing 404s on upstreams with a base path (e.g. Databricks `/serving-endpoints/anthropic`). The full URL path is now preserved and prepended to every forwarded request.
- **Model name prefix rewriting** (`CCXRAY_MODEL_PREFIX`): Some upstreams (e.g. Databricks) require a vendor-prefixed model name (`databricks-claude-sonnet-4-6`), but Claude Code's client-side validation rejects non-standard names. Setting `CCXRAY_MODEL_PREFIX=databricks-` lets the proxy transparently rewrite the model field before forwarding.

**Other improvements**

- **Turn Card 5-layer redesign**: Each timeline entry now shows a five-line card with cost on line 1, cache warmth + inter-turn gap timing, tool-fail risk signal, `hit:0%` red warning, and tools surfaced above the title. Scan a whole session's health without expanding detail.
- **Agent classification overhaul**: Plan, codex-rescue, claude-code-guide, summarizer, translator, and sdk-agent are now recognised as distinct agents. Classification precision 97.3% → 100.0% against 12,730 real captured prompts; items that can't be identified with confidence are honestly marked `unknown` instead of being bucketed into `claude-code`.
- **Unknown agent detection**: When Anthropic ships a new sub-agent that ccxray doesn't recognize, the terminal prints a one-time hint showing the prompt's opening so the new agent surfaces immediately instead of silently getting dumped into a catch-all bucket.
- **Keyboard-first navigation with live hint bar**: Every screen now shows a context-sensitive bottom bar listing the currently valid shortcuts — live-updated as you move between columns, sessions, turns, and diff hunks. Press `?` for the full cheatsheet. Also added: cmd-bar navigation, auto-select first project on page load, initial cascade (dashboard opens directly on timeline), unified Agents/Versions focus in System Prompt panel. Full keyboard flow from project list to individual diff hunks.

### Changed

- **Main agent renamed `claude-code` → `orchestrator`**: The interactive agent that dispatches to sub-agents is now labelled **Orchestrator** — separating the agent role from the CLI product name. UI defaults, API defaults (`/_api/sysprompt/diff`), and test assertions updated. `versionIndex` is in-memory only so no migration is needed; new keys take effect on hub restart.

- **Unified dot/star polarity across Projects / Sessions / Turns cards**: status dot always sits on the leftmost position, pin star on the far-right. Eye can scan a single vertical column of dots across all three Miller columns to judge activity, instead of refocusing between columns.

- **L1/L3 context-% thresholds unified** (red ≥83.5%, yellow ≥75%) so the session list and turn-detail big bar read the same. L2 turn card keeps its own per-turn thresholds (`>95 critical, >85 warning`) — per-turn scale reads as anomaly detection, not decision signal (design D11 explains why unifying would produce a wall of red in late-session turns).

- **Historical sessions dim**: L1 session cards older than 1 hour since last turn no longer light up red/yellow regardless of ctx%. Badge renders as dim grey at the same ≥75% threshold so you still see where the session landed without the urgency coloring drowning the live list.

- **Session card layout**: cost bar moved below the context bar, cache countdown and inter-turn timing consolidated onto one row. Short session ID always visible; title renders as an optional second line when available.

### Fixed

- **Sub-agents no longer mis-labelled as Claude Code**: Previously, Plan / Codex Rescue / Summarizer / Claude Code Guide sessions were silently grouped with the main "Claude Code" agent because detection relied on a branding line that every sub-agent shares. They now classify into their own buckets with separate version histories and diffs. Claude Agent SDK callers also surface as a distinct `sdk-agent` class.

- **Phantom sessions in multi-project concurrent use**: When two `ccxray claude` instances started within milliseconds of each other, the second session could inherit the first session's ID before its own metadata arrived. Fixed by tightening the session-assignment window and requiring explicit session confirmation before attribution.

- **Copy-launch button icon was misleading**: the session card's "copy launch command" button was rendered as ⊗ (U+2297 CIRCLED TIMES), which universally reads as delete / close. The button only copied a shell command to clipboard; clicking it never removed anything. Replaced with ⧉ (U+29C9 TWO JOINED SQUARES, the standard copy glyph), and the tooltip now reads "Copy command to resume this session" so the clipboard content's purpose is explicit. Also fixed a long-standing inconsistency where the post-click state used a different icon than the initial render.

## 1.5.0

### Added

- **Taint markers**: Every tool call in the timeline now shows a source badge — `[network]` (blue) for web/HTTP tools, `[local:sensitive]` (orange) for reads from sensitive paths (`~/.ssh/`, `.env`, `/etc/passwd`, etc.), `[local]` (grey) for ordinary file/shell access. Helps identify which turns introduced untrusted external content.

## 1.4.0

### Added

- **Step-level credential badge**: Credential patterns detected in individual tool call results now show an `⚠ cred` badge directly on the timeline step row, in addition to the turn-level badge.

## 1.3.0

### Added

- **Credential scanning**: Detects API keys (`sk-ant-`, `sk-`, `ghp_`, `AKIA`), SSH private keys, and `.env` content appearing in assistant responses or tool results. Flagged turns show an `⚠ cred` badge in the turn list and inline orange highlights in the detail view. Scanning also covers URL-encoded patterns and credentials passed as tool inputs.

## 1.2.0

### Added

- **Multi-agent system prompt browsing**: Three-column Miller layout for the System Prompt page — browse prompts across all agent types (Claude Code, General Purpose, Explore, Web Search, Title Generator, Name Generator) with per-agent version history and diff viewer
- **Content-based version deduplication**: Version index keyed by `coreHash` instead of version string — identical system prompts across cc_version bumps are collapsed into a single entry with hash-based change detection
- **`KNOWN_AGENTS` registry**: Centralized agent type detection table replacing hardcoded if/else chains, with regex fallback for unknown future agent types
- **`sessionInferred` flag**: Entries attributed by inference (not explicit session_id) carry a `sessionInferred` flag through the full pipeline (store → forward → SSE → dashboard). Displayed as a yellow dashed "inferred" badge in the turn list and detail panel header.
- `CCXRAY_MAX_ENTRIES` environment variable to configure in-memory entry limit (default: 5000)
- Hub status endpoint includes `app: 'ccxray'` marker for identity verification
- 70 new tests (98 → 168) covering proxy E2E, SSE streaming, intercept lifecycle, error paths, concurrency, hub crash recovery, subagent session attribution, and agent type detection

### Fixed

- **Subagent session attribution**: Bare subagent requests (no session_id, no tools, no system prompt) were incorrectly assigned to a separate `direct-api` session. Now uses inflight request tracking + 30s temporal window to infer the parent session. Subagent path never pollutes global `currentSessionId`.
- **Minimap proportional accuracy**: `layoutMinimapBlocks` used `Math.max(blockEls.length, ...)` which inflated the blocks region when block count exceeded proportional height (e.g. 300 blocks at 24% usage displayed as 60%). Now uses proportional height as the authoritative ceiling.
- **Orphan hub detection**: When `hub.json` lockfile is missing but a hub is still running, clients now probe the default port and reconnect automatically instead of failing with EADDRINUSE
- **Browser auto-open**: First client connecting to a hub now opens the dashboard, regardless of whether the client forked the hub or discovered an existing one
- **ECONNRESET handling**: Upstream socket destruction mid-response no longer leaves the client hanging; added `proxyRes` error handler for both SSE and non-SSE paths
- **OOM on long-running hub**: In-memory entries capped at 5000 (configurable via `CCXRAY_MAX_ENTRIES`), oldest evicted first; disk logs unaffected
- **Version list accuracy**: Unchanged versions (same coreHash) are dimmed; size delta only shown when content actually changed; `firstSeen` uses file mtime instead of filename parsing

## 1.1.0

### Added

- **Multi-project hub**: Multiple `ccxray claude` instances automatically share a single proxy server and dashboard. No configuration needed — the first instance starts a hub, subsequent ones connect to it.
- **`ccxray status`**: New subcommand showing hub info and connected clients.
- **Hub crash auto-recovery**: If the hub process dies, connected clients detect and restart it within ~5 seconds.
- **Version compatibility check**: Clients with different major versions are rejected with a clear error message.

### Changed

- **Logs location**: Moved from `./logs/` (package-relative) to `~/.ccxray/logs/` (user home). Existing logs are automatically migrated on first run.
- **`--port` behavior**: Explicitly specifying `--port` now opts out of hub mode, running an independent server instead.

### Migration from 1.0.0

- Logs are automatically migrated from the old `logs/` directory to `~/.ccxray/logs/` on first startup. No manual action needed.
- If you use `AUTH_TOKEN`, hub discovery endpoints (`/_api/health`, `/_api/hub/*`) bypass authentication since they are local IPC.

## 1.0.0

Initial release.
