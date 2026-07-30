# Provider module acceptance — Grok CLI

Grok is one **agent module** in `server/providers.js` + `OPENAI_WIRE_CLIENTS`
(not a separate product). This file is the acceptance checklist for that module.

## Quick matrix

| Layer | Command | What it proves |
|-------|---------|----------------|
| Unit (wire + pricing + launcher) | see below | session/agent/cwd/noise/cost without network |
| E2E (real proxy + mock xAI) | see below | end-to-end entry recording |
| Live (real Grok CLI) | optional | real auth + cli-chat-proxy |

Always isolate storage:

```bash
export CCXRAY_HOME=$(mktemp -d)
```

## 1. Automated suite (CI-safe)

From worktree:

```bash
# repo root of feat/grok-cli-support (or worktree)

CCXRAY_HOME=$(mktemp -d) node --test \
  test/grok-wire.test.js \
  test/grok-proxy.e2e.test.js \
  test/providers.test.js \
  test/wire-parsers-openai.test.js \
  test/config.test.js \
  test/pricing.test.js
```

Full suite:

```bash
CCXRAY_HOME=$(mktemp -d) npm test
```

### Fixtures

Synthetic only (no real usernames/paths from `~/.grok`):

```
test/fixtures/wire-parsers/grok/
  main_req.json          # POST /v1/responses body (system in input)
  title_req.json         # parallel title-gen (forced session_title tool)
  main_sse_events.json   # parsed SSE events with usage
  headers_main.json      # x-grok-session-id populated
  headers_title.json     # empty session headers (grok-raw path)
```

### What `grok-wire.test.js` covers

- Client detect + xAI vs OpenAI upstream routing
- Session: real UUID from headers; empty headers → `grok-raw` (not `codex-raw`)
- Agent = `grok` from headers / model
- System prompt from `input[role=system]`
- Cwd from `Workspace Path:` in user_info
- Control-plane noise
- `buildEntryFields` cost (~$0.05 style) + 500k context + usage normalize
- Launcher env `GROK_CLI_CHAT_PROXY_BASE_URL`

### What `grok-proxy.e2e.test.js` covers

Spawns real `server/index.js` with `XAI_BASE_URL` → mock HTTP server:

1. Grok-header GET `/v1/settings|feedback|models` → **0** dashboard entries
2. Title-gen POST → entry `agent=grok`, `sessionId=grok-raw`
3. Main POST → entry `agent=grok`, real session UUID, cwd, cost, maxContext 500k
4. No `codex-raw` in index

## 2. Live smoke (optional, needs `grok login`)

```bash
cd .claude/worktrees/grok-wire-experiment
export CCXRAY_HOME=$(mktemp -d)
PORT=5612

node server/index.js --port $PORT --no-browser &
# wait for listen…

mkdir -p /tmp/grok-ccxray-smoke && cd /tmp/grok-ccxray-smoke
GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:$PORT/v1 \
  grok -p "Reply with exactly one word: pong" \
  --always-approve --max-turns 1 --no-subagents --disable-web-search

open "http://127.0.0.1:$PORT"
```

### Dashboard checklist

| Check | Expect |
|-------|--------|
| Project | path under `/tmp/...` (not `(unknown)`) when user_info has Workspace Path |
| Main session | UUID short id, not Codex Raw |
| Title-gen session | **Grok Raw** (if present), not Codex Raw |
| Model | `grok-4.5` · 500K |
| Cost | ~$0.05 range, not Unknown model |
| Timeline | `pong` (+ reasoning) |
| **Usage tab** | filter **Grok** present; daily/monthly `byAccount['grok-default']` includes proxy cost (from `index.ndjson`, not `~/.grok` — Grok sessions do not store token usage) |
| **Usage Accounts** | Grok card mirrors CLI `/usage`: **Weekly SuperGrok Limit** from `GET /v1/billing?format=credits` (`creditUsagePercent`, `currentPeriod.end`). No 5h window; no Today/Month $ on the Grok rate card. Soft-refresh while Usage tab is open. |

### One-shot launcher

```bash
CCXRAY_HOME=$(mktemp -d) node server/index.js --port 5613 grok
```

## 3. Acceptance criteria (product)

- [x] Automated unit + e2e green under empty `CCXRAY_HOME`
- [x] Live main turn: `agent=grok`, UUID session, cost non-null
- [x] Title-gen never creates `codex-raw` / "Codex Raw" (uses `grok-raw`)
- [x] Control-plane settings/feedback do not flood index
- [x] Title-gen stamps parent session card title via `session_title` tool
- [x] `LITELLM_LAG_OVERRIDES` only for models still missing from LiteLLM (`grok-build`; see issue #202)

## 4. Related

- Wire notes: `docs/grok-wire-experiment-2026-07-09.md`
- Cleanup issue: https://github.com/lis186/ccxray/issues/202
- Hygiene: `docs/testing.md`
