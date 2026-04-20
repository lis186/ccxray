# Changelog

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

### Fixed

- **Sub-agents no longer mis-labelled as Claude Code**: Previously, Plan / Codex Rescue / Summarizer / Claude Code Guide sessions were silently grouped with the main "Claude Code" agent because detection relied on a branding line that every sub-agent shares. They now classify into their own buckets with separate version histories and diffs. Claude Agent SDK callers also surface as a distinct `sdk-agent` class.

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
