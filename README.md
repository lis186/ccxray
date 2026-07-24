# ccxray

**English** | [正體中文](README.zh-TW.md) | [日本語](README.ja.md)

X-ray vision for AI agent sessions. A zero-config HTTP proxy that records every API call between Claude Code, Codex, and their upstream APIs, with a real-time dashboard and workflow timeline to inspect what's actually happening inside your agent.

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

![ccxray dashboard](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/dashboard-v2.png)

## Why

Claude Code is a black box. You can't see:
- What system prompts it sends (and how they change between versions)
- How much each tool call costs
- Why it's thinking for 30 seconds
- What context is eating your 200K token window

ccxray makes it a glass box.

## Quick Start

```bash
npx ccxray claude
# or
npx ccxray codex
# or
npx ccxray grok
```

That's it. Proxy starts, the selected CLI launches through it, and the dashboard opens automatically in your browser. Run it in multiple terminals — they automatically share one dashboard.

The launcher argument is provider-backed. Today `claude`, `codex`, and `grok` are supported; unknown provider commands fail fast instead of silently starting an unconfigured proxy.

### Other ways to run

```bash
ccxray                           # Proxy + dashboard only
ccxray claude --continue         # All claude args pass through
ccxray codex exec "hello"        # All codex args pass through
ccxray grok -p "hello"           # All grok args pass through
ccxray --port 8080 claude        # Custom port (independent, no hub sharing)
ccxray claude --no-browser       # Skip auto-open browser
ccxray status                    # Show hub info and connected clients
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # Point existing claude session at a running ccxray hub
```

### Multi-project

Running `ccxray claude` in multiple terminals automatically shares a single proxy and dashboard — no configuration needed.

```bash
# Terminal 1
cd ~/project-a && ccxray claude     # Starts hub + claude

# Terminal 2
cd ~/project-b && ccxray claude     # Connects to existing hub

# Both projects visible in one dashboard at http://localhost:5577
```

If the hub process crashes, connected clients automatically recover within seconds.

```bash
$ ccxray status
Hub: http://localhost:5577 (pid 12345, uptime 3600s)
Connected clients (2):
  [1] pid 23456 — ~/dev/project-a
  [2] pid 34567 — ~/dev/project-b
```

Use `--port` to opt out and run an independent server instead.

## Supported agent modules

Launchers are registered in `server/providers.js` (same hub + dashboard for all):

| Command | Wire family | Upstream (default) |
|---------|-------------|--------------------|
| `ccxray claude` | Anthropic Messages | `api.anthropic.com` |
| `ccxray codex` | OpenAI Responses | `api.openai.com` / ChatGPT |
| `ccxray grok` | OpenAI Responses (client module) | `cli-chat-proxy.grok.com` (`XAI_BASE_URL` override) |

OpenAI-wire clients that are not Codex (today: Grok) are listed in `OPENAI_WIRE_CLIENTS` — shared parser, distinct host/agent/raw-session bucket. Multi-agent hubs mix them without swapping `OPENAI_BASE_URL`. Acceptance notes: [`docs/grok-testing.md`](docs/grok-testing.md).

## Codex support (Beta)

```bash
npx ccxray codex
```

Works for both API-key and ChatGPT-auth codex sessions. ChatGPT routing to `chatgpt.com/backend-api/codex` triggers automatically on codex's `chatgpt-account-id` header — no extra config. Codex's startup platform polls (plugin lists, connector directory, app metadata) are proxied but hidden from the dashboard so the timeline shows only conversation traffic.

**Beta caveats:**
- WebSocket transport (`/v1/responses`, `/v1/realtime`) captures connection-level metadata only: frame counts, byte counts, close status. Per-frame content is not decoded — codex turns show less detail in the dashboard than Claude turns do.
- Token counts, model, and duration are not yet extracted from codex's telemetry payload; a follow-up will surface these.
- Limited real-world testing compared to the Claude path.

Env vars for tuning: `OPENAI_BASE_URL`, `CHATGPT_BASE_URL`, `CCXRAY_WS_IDLE_TIMEOUT_MS`, `CCXRAY_WS_MAX_QUEUE_BYTES`. Details in [CLAUDE.md](CLAUDE.md).

File issues on [GitHub](https://github.com/lis186/ccxray/issues) — Beta means we want the rough edges reported.

## Features

### Workflow Timeline

Watch your agent think in real-time and see its concurrency structure.

**Turn cards**: Every turn renders as a five-line card — cost, cache warmth (with inter-turn gap timing to catch cache misses), tool-fail risk, `hit:0%` red warnings, and tools surfaced above the title. Scan a whole session's health without expanding a single card.

**Lane visualization**: Multi-agent sessions automatically split into parallel lanes — orchestrator on the main lane, subagents on separate Fork / Teammate lanes. Each lane gets a distinct color from a WCAG ≥3:1 contrast pool, with mixed-model labels. The sequential-interleave tracker marks which turns within a conversation ran sequentially vs concurrently.

**Birdseye mode**: Toggle the birdseye overview to expand the overview strip to ~80% viewport, with a magnified minimap and range summary for navigating long sessions.

**L1/L2 dual-state selection**: Tab / ▲▼ selects lanes (L1), j/k selects turns within a lane (L2), Esc walks back level by level. Replaces the old single-level click model.

![Workflow timeline](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/timeline-v2.png)

### Usage & Cost

Track your real spending. Burn rate, per-account rate-limit cards for Claude and Codex — know exactly where your tokens go.

![Usage analytics](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/usage.png)

### System Prompt Tracking

Automatic version detection with diff viewer. Browse prompts across multiple recognized agent types and see exactly what changed between updates. Uncertain prompts are honestly marked `unknown`.

![System prompt tracking](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/system-prompt-v2.png)

### Keyboard-first Navigation

Drive the whole dashboard with your keyboard. Every screen shows a context-sensitive hint bar at the bottom — the currently valid shortcuts, live-updated as you move. Press `?` for the full cheatsheet. Navigate projects → sessions → timeline → individual diff hunks without touching the mouse.

**Workflow navigation**: Tab / ▲▼ switches between lanes (L1 selection), j/k switches between turns within a lane (L2 selection), Esc walks back one level at a time.

**Step-type jumps**: `e`/`E` jumps to the next/previous error, `s`/`S` to Skill calls, `a`/`A` to subagent (Agent/Task) calls, `m`/`M` to MCP tool calls. Each jump is position-aware — it finds the nearest match forward or backward from wherever you are, and updates the address bar URL.

`n`/`N` jumps to the next/previous starred item anywhere in the dashboard — across projects, sessions, turns, and individual timeline steps. The command bar shows the shortcut only when starred items are reachable from the current view.

![Keyboard navigation](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/keyboard-v2.png)

### Session Titles & Cache Alerts

Session cards show Claude Code's generated titles (e.g. `Fix login button on mobile`) instead of raw hashes, with a live cache TTL countdown (`cache 4m left`) that pulses red under 1 minute. When any session nears expiry, the browser tab alternates between `ccxray` and `⚠ ccxray`. Opt-in browser notification fires at a plan-aware lead time — 5 minutes for Max, 60 seconds for Pro/API key. Titles fall back to the short hash for direct-API traffic or sessions still in flight.

![Session titles and cache expiry alerts](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/cache-expiry.png)

### Plan Detection

ccxray auto-detects your subscription plan (Pro vs Max 5x vs Max 20x) by reading Anthropic's `cache_creation` usage fields — no configuration needed. Cache TTL and quota thresholds use the detected plan. Override with `CCXRAY_PLAN` if auto-detection gets it wrong.

### Per-Account Rate Limits

See 5-hour and weekly quota usage for every Claude and Codex account on one dashboard. Cards auto-discover `~/.codex-*/sessions/` for multi-account Codex setups, and read Claude statusline data via `ccxray setup-statusline`. Business/unlimited Codex plans show `∞ Unlimited`. Data refreshes in the background every 30 seconds without blocking the proxy.

### Intercept & Edit Requests

Pause requests before they reach Anthropic. Toggle intercept on a session and the next request from Claude Code is held in the dashboard — edit the system prompt, messages, tools, or sampling parameters, then approve (forwards your edited copy) or reject (returns an error to Claude Code). Useful for prompt engineering, sandboxing risky tool calls, and running experiments without forking the agent.

### Context HUD

Optional context-stats footer appended to Claude's responses inside Claude Code itself: `📊 Context: 28% (290k/1M) | 1k in + 800 out | Cache 99% hit | $0.15`. Enabled by default; toggle from the dashboard topbar.

**Why a toggle?** When the parent agent calls sub-agents (Agent / Task tool), the appended block can truncate the sub-agent's response before it's returned to the parent — causing silent data loss in multi-agent workflows. Turn the HUD off when running sub-agent-heavy sessions. State persists in `~/.ccxray/settings.json`.

### Star to Keep Forever

Click the star on a turn, session, or project card to mark it for permanent retention. Starred items survive `LOG_RETENTION_DAYS` auto-prune; state lives in `~/.ccxray/settings.json`, server-side and persistent across browsers. A starred turn protects every turn in its session; a starred session protects every turn under it; a starred project protects everything beneath. Catch-all buckets (`direct-api`, `(unknown)`, `(quota-check)`) refuse stars at the bucket level — star individual turns inside instead.

Individual timeline steps can also be starred (`★`/`☆` toggle on each step row). A starred step protects its parent turn and session identically to a direct turn star.

When a parent inherits protection from a starred descendant, the badge becomes `☆ [N]` instead of `★`. Click the chip to open a popover listing exactly which descendants are keeping it retained. Each row's star is its own toggle; clicking the row body navigates straight to that turn / session.

![Star retention and descendant popover](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/stars.png)

### Usage Analytics CLI

```bash
ccxray usage                          # Human-readable summary
ccxray usage --json                   # JSON for agents (< 4KB)
ccxray usage --last 7d                # Last 7 days (supports d/h/m)
ccxray usage --cwd myproject          # Smart match by directory name substring
ccxray usage --cwd ~/code/app         # Absolute or ~ path → exact-subtree prefix match
ccxray usage --cwd proj-a,proj-b      # Multiple projects → comparison table
ccxray usage --session latest         # Most recent session
ccxray usage --session costliest      # Highest-cost session
ccxray usage --session "fix login"    # Search by session title
ccxray usage --session 950432         # UUID prefix match
ccxray usage --session costliest --open  # Jump to that session in the dashboard
ccxray usage --tools                  # Full tool breakdown
```

Automated usage analysis in 0.6 seconds — know where your tokens and dollars go without manual log diving. Reads `index.ndjson` directly, no server needed. Shows model cost breakdown, tool & skill usage, prompt hash stability (how often system/tools/core prompts change between turns), cache hit rates by inter-turn gap, and the 10 costliest sessions with titles.

The `--json` output is an agent-facing contract — see [`docs/usage.md`](https://raw.githubusercontent.com/lis186/ccxray/v2.1.0/docs/usage.md) for the full field-by-field schema, the multi-cwd and error shapes, and filter semantics.

### More

- **Deep Link Navigation** — Every selection (project / session / turn / step) is reflected in the address bar URL. Paste a URL into a new tab and the dashboard navigates directly to the same view.
- **Collapsible sidebar** — The overview panel can be collapsed to give the timeline more room.
- **Cache TTL split** — Turn detail shows whether the cache used a 5-minute or 1-hour TTL.
- **Hidden projects** — Set `hiddenProjects` in `settings.json` to hide specific projects from the dashboard; hidden projects don't leak when sharing.
- **Per-session restore cap** — `CCXRAY_SESSION_ENTRY_CAP` limits entries loaded per session at startup, preventing a single giant session from crowding out others.
- **Session Detection** — Automatically groups turns by Claude Code session, with project/cwd extraction
- **Token Accounting** — Per-turn breakdown: input/output/cache-read/cache-create tokens, cost in USD, context window usage bar

## How It Works

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com (or ANTHROPIC_BASE_URL)
                      │
                      ▼
              ~/.ccxray/logs/ (JSON)
                      │
                      ▼
                  Dashboard (same port)
```

ccxray is a transparent HTTP proxy. It forwards requests to the upstream API (Anthropic or OpenAI), records both request and response as JSON files, and serves a web dashboard on the same port. All endpoints enforce authentication: launcher-started CLIs inject the `X-Ccxray-Auth` header automatically — no friction for users; scripts calling `/v1/*` directly must add the header (see CHANGELOG). Hub IPC uses a Unix domain socket (`~/.ccxray/hub.sock`) rather than HTTP.

## Configuration

### CLI flags

| Flag | Description |
|---|---|
| `--port <number>` | Port for proxy + dashboard (default: 5577). Opts out of hub sharing. |
| `--no-browser` | Don't auto-open the dashboard in your browser |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `5577` | Port for proxy + dashboard (overridden by `--port`) |
| `BROWSER` | — | Set to `none` to disable auto-open |
| `AUTH_TOKEN` | _(auto)_ | Access-control key. Auto-derived from `<CCXRAY_HOME>/local-secret` when unset (default `~/.ccxray/local-secret`). All endpoints enforce auth regardless. |
| `CCXRAY_SESSION_ENTRY_CAP` | `500` | Max entries loaded per session at startup restore. Sessions exceeding this keep only the latest entry (no runtime limit). |
| `CCXRAY_LOOPBACK_REQUIRE_AUTH` | _(unset)_ | Loopback is auth-free by default; set to `1` to enforce auth on loopback too. |
| `CCXRAY_HOME` | `~/.ccxray` | Base directory for hub lockfile, logs, and hub.log |
| `CCXRAY_MAX_ENTRIES` | `5000` | Max in-memory entries (oldest evicted; disk logs unaffected) |
| `LOG_RETENTION_DAYS` | `14` | Auto-prune log files older than N days on startup. Starred turns / sessions / projects (and everything beneath them) are protected, as are files referenced by restored entries. Set to `0` to disable. |
| `RESTORE_DAYS` | `14` | Limit which days of logs to load on startup (`0` = all, subject to `CCXRAY_MAX_ENTRIES`). Useful for very large log directories. |
| `CCXRAY_PLAN` | _(auto)_ | Override plan detection: `pro`, `max5x`, `max20x`, `api-key` |
| `CCXRAY_DISABLE_TITLES` | _(unset)_ | Set to `1` to disable session title extraction (sessions fall back to short hash) |
| `CCXRAY_MODEL_PREFIX` | _(unset)_ | Prepend a string to the model name before forwarding (e.g. `databricks-`). Useful when the upstream requires a vendor-prefixed model name but Claude Code only accepts standard names. |
| `HTTPS_PROXY` / `https_proxy` | _(unset)_ | Route outbound HTTPS traffic through a corporate proxy via HTTP CONNECT tunnel. |
| `ANTHROPIC_BASE_URL` | — | Custom upstream Anthropic endpoint (e.g. a corporate gateway). Supports base paths — `https://host/serving-endpoints/anthropic` works as-is. `ANTHROPIC_TEST_*` take precedence when set. |

Logs are stored in `~/.ccxray/logs/` as `{timestamp}_req.json` and `{timestamp}_res.json`. Upgrading from v1.0? Logs previously in `./logs/` are automatically migrated on first run.

ccxray currently stores logs on the local filesystem only. A remote object-storage backend (S3 / R2) is not supported yet — it needs more work on the storage interface and on the security model for sending request/response logs off-machine.

## Docker

```bash
docker build -t ccxray .
docker run -p 5577:5577 ccxray
```

## Requirements

- Node.js 18+

## Also by the author

- [SourceAtlas](https://sourceatlas.io/) — Your map to any codebase
- [AskRoundtable](https://github.com/AskRoundtable/expert-skills) — Make your AI think like Munger, Feynman, or Paul Graham
- Follow [@lis186](https://x.com/lis186) on X for updates

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE)
