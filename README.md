# ccxray

**English** | [正體中文](README.zh-TW.md) | [日本語](README.ja.md)

X-ray vision for AI agent sessions. A zero-config HTTP proxy that records every API call between Claude Code and Anthropic, with a real-time dashboard to inspect what's actually happening inside your agent.

![License](https://img.shields.io/badge/license-MIT-blue)

![ccxray dashboard](https://raw.githubusercontent.com/lis186/ccxray/main/docs/dashboard.png)

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
```

That's it. Proxy starts, Claude Code launches through it, and the dashboard opens automatically in your browser.

### Other ways to run

```bash
ccxray                           # Proxy + dashboard only
ccxray claude --continue         # All claude args pass through
ccxray --port 8080 claude        # Custom port (independent, no hub sharing)
ccxray claude --no-browser       # Skip auto-open browser
ccxray status                    # Show hub info and connected clients
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # Manual setup (existing sessions)
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

Use `--port` to opt out and run an independent server instead.

## Features

### Timeline

Watch your agent think in real-time. Every turn broken down into thinking blocks (with duration), tool calls with inline previews, and assistant responses.

![Timeline view](https://raw.githubusercontent.com/lis186/ccxray/main/docs/timeline.png)

### Usage & Cost

Track your real spending. Session heatmap, burn rate, ROI calculator — know exactly where your tokens go.

![Usage analytics](https://raw.githubusercontent.com/lis186/ccxray/main/docs/usage.png)

### System Prompt Tracking

Automatic version detection with diff viewer. See exactly what changed between Claude Code updates — never miss a prompt change again.

![System prompt tracking](https://raw.githubusercontent.com/lis186/ccxray/main/docs/system-prompt.png)

### More

- **Session Detection** — Automatically groups turns by Claude Code session, with project/cwd extraction
- **Token Accounting** — Per-turn breakdown: input/output/cache-read/cache-create tokens, cost in USD, context window usage bar

## How It Works

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com
                      │
                      ▼
              ~/.ccxray/logs/ (JSON)
                      │
                      ▼
                  Dashboard (same port)
```

ccxray is a transparent HTTP proxy. It forwards requests to Anthropic unchanged, records both request and response as JSON files, and serves a web dashboard on the same port. No API key needed — it passes through whatever Claude Code sends.

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
| `AUTH_TOKEN` | _(none)_ | API key for access control (disabled when unset) |
| `CCXRAY_HOME` | `~/.ccxray` | Base directory for hub lockfile, logs, and hub.log |

Logs are stored in `~/.ccxray/logs/` as `{timestamp}_req.json` and `{timestamp}_res.json`.

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

MIT
