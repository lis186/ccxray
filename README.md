# ccxray

**English** | [正體中文](README.zh-TW.md) | [日本語](README.ja.md)

X-ray vision for AI agent sessions. A zero-config HTTP proxy that records every API call between Claude Code and Anthropic, with a real-time dashboard to inspect what's actually happening inside your agent.

![License](https://img.shields.io/badge/license-MIT-blue)

![ccxray dashboard](docs/dashboard.png)

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
ccxray --port 8080 claude        # Custom port
ccxray claude --no-browser       # Skip auto-open browser
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # Manual setup (existing sessions)
```

## Features

### Timeline

Watch your agent think in real-time. Every turn broken down into thinking blocks (with duration), tool calls with inline previews, and assistant responses.

![Timeline view](docs/timeline.png)

### Usage & Cost

Track your real spending. Session heatmap, burn rate, ROI calculator — know exactly where your tokens go.

![Usage analytics](docs/usage.png)

### System Prompt Tracking

Automatic version detection with diff viewer. See exactly what changed between Claude Code updates — never miss a prompt change again.

![System prompt tracking](docs/system-prompt.png)

### More

- **Session Detection** — Automatically groups turns by Claude Code session, with project/cwd extraction
- **Token Accounting** — Per-turn breakdown: input/output/cache-read/cache-create tokens, cost in USD, context window usage bar

## How It Works

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com
                      │
                      ▼
                  logs/ (JSON)
                      │
                      ▼
                  Dashboard (same port)
```

ccxray is a transparent HTTP proxy. It forwards requests to Anthropic unchanged, records both request and response as JSON files, and serves a web dashboard on the same port. No API key needed — it passes through whatever Claude Code sends.

## Configuration

### CLI flags

| Flag | Description |
|---|---|
| `--port <number>` | Port for proxy + dashboard (default: 5577) |
| `--no-browser` | Don't auto-open the dashboard in your browser |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `5577` | Port for proxy + dashboard (overridden by `--port`) |
| `BROWSER` | — | Set to `none` to disable auto-open |
| `STORAGE_BACKEND` | `local` | Storage adapter: `local` or `s3` |
| `LOGS_DIR` | `./logs` | Log directory (local backend) |
| `AUTH_TOKEN` | _(none)_ | API key for access control (disabled when unset) |
| `S3_BUCKET` | — | S3/R2 bucket name (s3 backend) |
| `S3_REGION` | `auto` | AWS region (s3 backend) |
| `S3_ENDPOINT` | — | Custom endpoint for R2/MinIO (s3 backend) |
| `S3_PREFIX` | `logs/` | Key prefix in bucket (s3 backend) |

Logs are stored in `./logs/` as `{timestamp}_req.json` and `{timestamp}_res.json`.

## Docker

```bash
docker build -t ccxray .
docker run -p 5577:5577 ccxray
```

## Requirements

- Node.js 18+
- No other dependencies needed (uses native `http`/`https`)

## License

MIT
