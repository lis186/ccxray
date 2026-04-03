# CLAUDE.md

Guidance for Claude Code when working with this repository.

## What is ccxray

A transparent HTTP proxy that sits between Claude Code and the Anthropic API. It records every request/response, serves a real-time Miller-column dashboard at the same port, and supports request interception/editing. Zero config, zero dependencies beyond Node.js.

## Commands

```bash
npm start                                        # Start proxy + dashboard on :5577
npm run dev                                      # Dev mode (auto-restart on server/public changes)
npm test                                         # Run tests
PROXY_PORT=8080 npm start                        # Custom port
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # Point Claude Code at proxy
```

No build step. No linting. Restart to apply changes.

## Architecture

### Server (`server/`)

| Module | Purpose |
|--------|---------|
| `server/index.js` | Entry point: HTTP server, request routing, startup |
| `server/config.js` | PORT, ANTHROPIC_HOST, LOGS_DIR, model context windows |
| `server/pricing.js` | LiteLLM price fetch, 24h cache, fallback rates, cost calculation |
| `server/cost-budget.js` | Cost data orchestration: cache, warm-up, grouping |
| `server/cost-worker.js` | Child process: scans `~/.claude/` JSONL files without blocking event loop |
| `server/store.js` | In-memory state: entries[], sseClients[], sessions, intercept |
| `server/sse-broadcast.js` | SSE broadcast to dashboard clients, entry summarization |
| `server/helpers.js` | Tokenization, context breakdown, SSE parsing, formatting |
| `server/system-prompt.js` | Version index, B2 block splitting, unified diff |
| `server/restore.js` | Startup log restoration, lazy-load req/res from disk |
| `server/forward.js` | HTTPS proxy to Anthropic, SSE capture, response logging |
| `server/routes/api.js` | REST endpoints for entries, tokens, system prompt |
| `server/routes/sse.js` | SSE endpoint |
| `server/routes/intercept.js` | Intercept toggle/approve/reject/timeout |
| `server/routes/costs.js` | Cost budget endpoints |
| `server/auth.js` | API key auth middleware (enabled via `AUTH_TOKEN` env) |
| `server/storage/` | Storage adapters (local filesystem, S3/R2) |

### Client (`public/`)

| File | Purpose |
|------|---------|
| `public/index.html` | Dashboard shell |
| `public/style.css` | Dark theme, Miller column layout |
| `public/app.js` | App initialization |
| `public/miller-columns.js` | Projects → Sessions → Turns → Sections → Timeline → Detail |
| `public/entry-rendering.js` | Turn rendering, session/project tracking |
| `public/messages.js` | Merged steps: thinking + tool groups, timeline detail |
| `public/cost-budget-ui.js` | Cost analysis page, heatmap, burn rate |
| `public/intercept-ui.js` | Pause/edit/approve/reject requests |
| `public/system-prompt-ui.js` | Version history, unified diffs |
| `public/keyboard-nav.js` | Arrow keys, Enter, Escape |
| `public/quota-ticker.js` | Topbar quota ticker |

### Data Flow

```
Claude Code → proxy receives request → detect session → [intercept check]
  → log {id}_req.json → forward to Anthropic → capture SSE response
  → log {id}_res.json → calculate cost → broadcast via SSE → dashboard updates
```
