# Grok CLI × ccxray wire experiment + integration

**Date**: 2026-07-09  
**Branch / worktree**: `experiment/grok-wire-capture` · `.claude/worktrees/grok-wire-experiment`  
**Baseline**: Grok CLI `0.2.93` · ccxray `main@7e1ac62` + this branch

---

## Status

| Phase | Result |
|-------|--------|
| Env-only intercept (OPENAI_BASE_URL override) | ✅ PASS |
| Productization (`ccxray grok` + header routing) | ✅ implemented in this worktree |
| Live re-verify (no OPENAI_BASE_URL) | ✅ PASS — `agent=grok`, real session UUID, `sysHash` set, `maxContext=500000` |
| Cost pricing for `grok-4.5` | ⚠️ still `Unknown model` (LiteLLM alias follow-up) |

### One-command usage (this branch)

```bash
ccxray grok
# or headless:
ccxray --port 5603 --no-browser   # then:
GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:5603/v1 grok -p "hi"
```

Shared hub works: Claude/Codex keep their hosts; Grok clients (`x-grok-*` / `User-Agent: grok-shell`) route to `cli-chat-proxy.grok.com` via `UPSTREAMS.xai` (override with `XAI_BASE_URL` / `GROK_BASE_URL`).

---

## Wire observations (obs-stable · Grok 0.2.93)

| Aspect | Observed |
|--------|----------|
| Transport | `POST /v1/responses` + SSE (`stream: true`); **no** WS on normal turns |
| Default host | `https://cli-chat-proxy.grok.com/v1` |
| Client redirect | `GROK_CLI_CHAT_PROXY_BASE_URL` |
| Auth | Bearer session JWT (browser/OIDC) or `XAI_API_KEY` |
| System prompt | **`input[role=system]` string**, not top-level `instructions` |
| Message content | plain **string** (not parts array) on request input |
| Session headers | `x-grok-session-id`, `x-grok-conv-id`, `x-grok-req-id`, `x-grok-turn-idx`, `x-grok-agent-id` |
| Routing header | `x-grok-model-override` |
| Client id | `x-grok-client-identifier: grok-shell`, `user-agent: grok-shell/<ver>` |
| Parallel title gen | second `POST` with `model=grok-build` + forced `session_title` tool |
| Tools | mostly `type:function`; also `type:x_search` |
| Usage | OpenAI-shaped; `input_tokens` includes `cached_tokens` (normalize like Codex) |
| Context | `grok-4.5` → 500k (models_cache + local fallback) |

### SSE event types (main turn)

`response.created` → `in_progress` → reasoning summary deltas → `output_text` → `response.completed`

---

## What this branch changes

| Area | Change |
|------|--------|
| `server/providers.js` | `AGENT_PROVIDERS.grok` launcher; `UPSTREAM_PROFILES.xai` |
| `server/config.js` | `UPSTREAMS.xai`, `isGrokClient()`, `/v1/chat/completions` → openai, header-based xAI routing, Grok context fallbacks |
| `server/wire-parsers/openai.js` | session headers, agent=`grok`, system-from-input, Grok control-plane noise |
| `server/index.js` | hash/write Grok system prompt; sessionMeta.agent; banner xAI line |
| `server/system-prompt.js` | Grok agent labels |
| `server/store.js` / `sse-broadcast.js` | resume command for grok |
| tests | providers / openai parser / config |

---

## Live verify evidence (post-impl)

```
ccxray (no OPENAI_BASE_URL) :5612
  OpenAI Upstream → api.openai.com
  xAI Upstream    → cli-chat-proxy.grok.com

grok -p "Reply with exactly one word: pong"
  → stdout: pong

index entry:
  provider: openai
  agent: grok
  agentLabel: Grok
  model: grok-4.5
  sessionId: 019f45ce-…          # NOT codex-raw
  sessionInferred: false
  sysHash: 03c6d9e9be5a
  maxContext: 500000
  usage: normalized (cache subtracted)
```

Control-plane settings/feedback no longer create anthropic 404 entries (noise + xAI route).

---

## Remaining follow-ups

1. **Pricing**: map `grok-4.5` / `grok-build` to LiteLLM rates (or local rates table)
2. **Title-gen session**: title turn often has empty `x-grok-session-id` — may still land as separate/orphan; consider correlating via timing or shared `x-grok-req-id`
3. **Multi-turn TUI** capture (tool loop, compaction, `x-compaction-at`)
4. **BYOK** path via `XAI_BASE_URL=https://api.x.ai/v1`
5. Promote durable rows into `docs/wire-protocol-reference.md` third column
6. `printSessionBanner` uses sessionMeta.agent — confirm title-gen-first race doesn’t flash wrong CLI name

---

## Confidence tags

| Claim | Tag |
|-------|-----|
| Default models use Responses API on cli-chat-proxy | `obs-stable` |
| `GROK_CLI_CHAT_PROXY_BASE_URL` works through ccxray | `contractual` + live |
| Header routing without OPENAI_BASE_URL works | `obs-stable` (this verify) |
| System in `input[role=system]` | `obs-stable` |
| No WS on headless single-turn | `obs-fragile` (need multi-turn TUI) |
