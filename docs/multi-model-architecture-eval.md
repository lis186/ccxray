# Multi-Model Architecture Evaluation

> Evaluating what changes ccxray needs to support Claude Code, Open Code, Codex CLI, and Gemini CLI.

## Current State: Anthropic/Claude Code Coupling Points

### Deep Coupling (Major Rewrite Required)

| Module | Coupling Points |
|--------|----------------|
| `server/forward.js` | Hardcoded Anthropic SSE event types (`message_delta`, `content_block_start/delta/stop`), `anthropic-ratelimit-*` headers, cache metrics fields |
| `server/helpers.js` | Uses `@anthropic-ai/tokenizer`, hardcoded Anthropic usage structure (`message_start`, `message_delta`), Claude Code system prompt parsing |
| `server/config.js` | `ANTHROPIC_HOST/PORT/PROTOCOL` env vars, hardcoded Claude model context windows, Claude model ID extraction from system prompt |
| `server/store.js` | Session ID parsed from `metadata.user_id` (Claude Code-specific format), quota check detection, CWD parsed from system prompt |
| `server/pricing.js` | Hardcoded Claude model prices, Anthropic cache cost structure |
| `server/system-prompt.js` | Claude Code system prompt block identification (billing header, core identity, etc.), agent type detection |

### Moderate Coupling (Needs Adapter Layer)

| Module | Coupling Points |
|--------|----------------|
| `public/entry-rendering.js` | Assumes Anthropic message format (`role`, content blocks with `type: 'thinking'`, `tool_use`, `tool_result`) |
| `public/messages.js` | Claude Code-specific tag detection (`<system-reminder>`, `<context>`) |
| `server/sse-broadcast.js` | Broadcast structure bound to Anthropic message fields |

---

## API Differences Across AI Coding Tools

| Dimension | Claude Code (Anthropic) | Codex CLI (OpenAI) | Gemini CLI (Google) | OpenCode |
|-----------|------------------------|--------------------|--------------------|----------|
| **API Endpoint** | `POST /v1/messages` | `POST /v1/responses` (Responses API) | `POST /v1beta/models/{model}:streamGenerateContent` | Per-provider |
| **Streaming Format** | SSE with `event:` + `data:` lines | SSE (Responses API format) | SSE with `alt=sse`, data-only | Per-provider |
| **Message Structure** | `system` as top-level param, `messages[]` with content blocks | Responses API item-based structure | `contents[]` with `parts[]` | OpenAI-compatible |
| **Tool Use** | `tool_use` / `tool_result` content blocks | Function calling in Responses API | `functionCall` / `functionResponse` in parts | Per-provider |
| **Special Features** | Extended thinking (`type: 'thinking'`), prompt caching | Server-side tool execution, code interpreter | Google Search grounding, 1M context | Multi-provider routing |
| **Authentication** | `x-api-key` header | `Authorization: Bearer` | `key=` query param or OAuth | Per-provider |
| **Usage Reporting** | Split across `message_start` + `message_delta` | In last chunk | In each chunk's `usageMetadata` | Per-provider |

---

## Proposed Architecture: Provider Adapter Pattern

```
                     +-----------------------------+
                     |        ccxray core           |
                     |  (unified internal format)   |
                     +-------------+---------------+
                                   |
              +--------------------+--------------------+
              |                    |                     |
    +---------v--------+ +--------v---------+ +---------v-----------+
    | AnthropicAdapter | | OpenAIAdapter    | | GeminiAdapter       |
    |                  | |                  | |                     |
    | - SSE parsing    | | - SSE parsing    | | - SSE parsing       |
    | - Token count    | | - Token count    | | - Token count       |
    | - Cost calc      | | - Cost calc      | | - Cost calc         |
    | - Session detect | | - Session detect | | - Session detect    |
    | - Sys prompt     | | - Sys prompt     | | - Sys prompt        |
    +------------------+ +------------------+ +---------------------+
```

### Modules to Add/Modify

1. **`server/adapters/` directory** (new)
   - `base-adapter.js` — Define adapter interface
   - `anthropic.js` — Move existing logic in
   - `openai.js` — OpenAI Responses API format conversion
   - `gemini.js` — Gemini generateContent format conversion
   - `auto-detect.js` — Auto-detect provider from request headers/path

2. **`server/forward.js`** — Refactor to provider-agnostic proxy, delegate SSE parsing to adapters

3. **`server/config.js`** — Generalize to `UPSTREAM_HOST/PORT/PROTOCOL`, support multi-provider config

4. **`server/helpers.js`** — Make tokenizer provider-aware (Anthropic tokenizer / tiktoken / Gemini tokenizer)

5. **`server/store.js`** — Adapter-ize session detection logic

6. **`server/pricing.js`** — Already uses LiteLLM prices, extend fallback support

7. **`public/entry-rendering.js`** — Unified internal message format, frontend renders only the unified format

---

## Expert Panel

### 1. Simon Willison — LLM CLI Tool Author, API Researcher

**Why:** Released [research-llm-apis](https://simonwillison.net/2026/Apr/5/research-llm-apis/) on April 4, 2026 — researching cross-provider HTTP API unification. His `llm` CLI supports hundreds of models via plugins and he's redesigning the abstraction layer.

**Recent ideas (April 2026):**
- Used Claude Code to read Anthropic, OpenAI, Gemini, Mistral Python SDKs to understand raw JSON format differences
- Found existing abstraction layers can't handle new features: server-side tool execution, extended thinking
- Advocates "record raw API behavior first, then design abstractions"

### 2. Ishaan Jaffer & Krrish Dholakia — LiteLLM Co-founders

**Why:** [LiteLLM](https://github.com/BerriAI/litellm) is the most widely adopted open-source multi-model proxy (100+ providers, OpenAI-compatible interface). ccxray already uses LiteLLM pricing data.

**Recent developments (2026):**
- Expanded support to GPT-5.3, Claude Opus 4.6, Gemini 3
- Experienced [security incident](https://letsdatascience.com/blog/the-litellm-backdoor-how-a-security-scanner-handed-attackers-95-million-monthly-downloads) in March 2026 (supply chain attack), highlighting proxy-layer security importance

### 3. Paul Gauthier — Aider Creator

**Why:** [Aider](https://github.com/Aider-AI/aider) supports Claude, GPT, Gemini and local models with battle-tested cross-model handling.

**Recent ideas (2026):**
- [Architect/Editor pattern](https://x.com/paulgauthier/status/1912892114310160392): o3-high as architect + gpt-4.1 as editor = 83% SOTA on polyglot benchmark
- Multi-model isn't just "switching" — it's **specialization by role**

### 4. Portkey AI Team (Rohit Agarwal)

**Why:** [Portkey](https://portkey.ai/) is an enterprise AI Gateway supporting 1,600+ LLMs, [recently open-sourced Gateway 2.0](https://thenewstack.io/portkey-gateway-open-source/).

**Recent developments (2026):**
- Open-sourced unified Gateway + MCP Gateway
- Proposed "AI Gateway" as a distinct infrastructure category
- Processing 2 trillion tokens daily

### 5. Continue.dev Team (Nate Lampton & Ty Dunn)

**Why:** [Continue.dev](https://docs.continue.dev/) uses an adapter-based architecture (`BaseLLM` + `useOpenAIAdapterFor`) closest to what ccxray needs.

---

## Scoring Rubric (10-point scale, deduction method)

### By Expert Perspective

#### Simon Willison — "API Raw Behavior Fidelity"

| Deduction | Points | Reason |
|-----------|--------|--------|
| Cannot record each provider's raw SSE format (loses info) | -2 | Willison insists on "record raw behavior first" |
| Doesn't support provider-specific features (thinking blocks, search grounding) | -2 | New features are why he's rebuilding his abstraction layer |
| Requires modifying the proxied tool's config to work | -1 | He advocates "change one base URL" transparent proxy |
| No plugin/adapter extension mechanism | -1 | His `llm` tool supports hundreds of models via plugins |

#### Ishaan Jaffer (LiteLLM) — "Unification & Compatibility"

| Deduction | Points | Reason |
|-----------|--------|--------|
| No unified internal format; each provider takes different code path to UI | -2 | LiteLLM's core philosophy: unify to OpenAI-compatible |
| No provider fallback/routing | -1 | Basic multi-model gateway feature |
| Token counting doesn't support each provider's tokenizer | -1.5 | Cost tracking is proxy's core value |
| Pricing data not auto-updated | -0.5 | LiteLLM maintains dynamic price tables |

#### Paul Gauthier (Aider) — "Practical Multi-Model Experience"

| Deduction | Points | Reason |
|-----------|--------|--------|
| Can't switch/mix models within same session | -2 | Architect/Editor mode needs multi-model collaboration |
| Can't correctly display each model's tool use format differences | -2 | Different models have different tool calling formats |
| Can't compare cost efficiency across models | -1 | Aider emphasizes benchmark + cost analysis |

#### Portkey Team — "Production-Grade Reliability"

| Deduction | Points | Reason |
|-----------|--------|--------|
| No provider health check / auto-failover | -1.5 | Enterprise gateway essential |
| No unified telemetry/observability standard | -1.5 | Portkey's core selling point |
| No unified rate limiting abstraction | -1 | Each provider's rate limit headers differ |
| Insufficient security (API key management, audit) | -1 | Reference: LiteLLM security incident |

#### Continue.dev Team — "Adapter Architecture Quality"

| Deduction | Points | Reason |
|-----------|--------|--------|
| Adding provider requires modifying core code (not adapter-ized) | -3 | Continue uses `BaseLLM` + provider subclasses, new providers don't touch core |
| Adapter interface not clearly defined (no explicit contract) | -2 | `ILLM` interface is Continue's architecture cornerstone |
| No capability negotiation (each model supports different features) | -1 | Continue's `model-capabilities` config mechanism |

### Unified Scoring Framework

| # | Dimension | Max Score | Architecture Requirement |
|---|-----------|-----------|-------------------------|
| 1 | **Provider Decoupling** | 2 | New providers don't modify core, only write adapters |
| 2 | **SSE/Streaming Fidelity** | 1.5 | Fully record each provider's raw format, no info loss |
| 3 | **Unified Internal Representation** | 1.5 | Dashboard renders only one format |
| 4 | **Token/Cost Calculation Accuracy** | 1.5 | Each provider uses correct tokenizer and pricing |
| 5 | **Provider-Specific Feature Support** | 1 | Thinking blocks, search grounding, prompt caching, etc. |
| 6 | **Session Detection Generalization** | 0.5 | Can detect sessions from different coding tools |
| 7 | **Zero-Config Transparent Proxy** | 0.5 | Change base URL to use, no tool config changes needed |
| 8 | **Auto Provider Detection** | 0.5 | Auto-determine provider from request |
| 9 | **Adapter Extensibility** | 0.5 | Documented adapter interface, community can contribute |
| 10 | **Security** | 0.5 | Multi API key management, audit logs |

### Current ccxray Score

| Dimension | Score | Status |
|-----------|-------|--------|
| Provider Decoupling | 0/2 | Fully coupled to Anthropic |
| SSE Streaming Fidelity | 1.5/1.5 | Full recording for Anthropic format |
| Unified Internal Representation | 0.5/1.5 | Has unified structure but hardcoded Anthropic format |
| Token/Cost Calculation | 0.5/1.5 | Uses Anthropic tokenizer + LiteLLM prices |
| Provider-Specific Features | 0.5/1 | Supports thinking blocks, caching (Claude only) |
| Session Detection | 0/0.5 | Only detects Claude Code sessions |
| Zero-Config Transparent Proxy | 0.5/0.5 | Change base URL works (Anthropic only) |
| Auto Provider Detection | 0/0.5 | Does not exist |
| Adapter Extensibility | 0/0.5 | No adapter architecture |
| Security | 0.25/0.5 | Basic AUTH_TOKEN support |
| **Total** | **3.75/10** | |

---

## Recommended Implementation Phases

1. **Phase 1 — Adapter Skeleton**: Create `server/adapters/` + base interface + move Anthropic logic
2. **Phase 2 — OpenAI Adapter**: Support Codex CLI (Responses API)
3. **Phase 3 — Gemini Adapter**: Support Gemini CLI (generateContent)
4. **Phase 4 — Auto-detect**: Auto-select adapter based on request path/headers
5. **Phase 5 — Frontend Unification**: Dashboard renders unified internal format

Each phase delivers independent value without requiring a full rewrite.

---

## Sources

- [Simon Willison: research-llm-apis (April 2026)](https://simonwillison.net/2026/Apr/5/research-llm-apis/)
- [Simon Willison: How streaming LLM APIs work](https://til.simonwillison.net/llms/streaming-llm-apis)
- [LiteLLM GitHub](https://github.com/BerriAI/litellm)
- [Paul Gauthier: Architect/Editor SOTA](https://x.com/paulgauthier/status/1912892114310160392)
- [Portkey AI Gateway](https://portkey.ai/)
- [Portkey open-sources its AI gateway](https://thenewstack.io/portkey-gateway-open-source/)
- [Continue.dev LLM Abstraction Layer](https://deepwiki.com/continuedev/continue/4.1-extension-architecture)
- [OpenAI Codex CLI Architecture](https://developers.openai.com/codex/cli)
- [OpenAI Codex App Server Architecture](https://openai.com/index/unlocking-the-codex-harness/)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [OpenCode GitHub](https://github.com/opencode-ai/opencode)
- [Comparing streaming response structures for LLM APIs](https://medium.com/percolation-labs/comparing-the-streaming-response-structure-for-different-llm-apis-2b8645028b41)
- [OpenAI Responses API vs Anthropic Messages API](https://portkey.ai/blog/open-ai-responses-api-vs-chat-completions-vs-anthropic-anthropic-messages-api/)
