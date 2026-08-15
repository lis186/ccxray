# Provider modules

ccxray is a multi-agent hub. Each coding CLI is a **module**, not a product fork.

## Layers

| Layer | Registry | Responsibility |
|-------|----------|----------------|
| Launcher | `AGENT_PROVIDERS` in `server/providers.js` | How to spawn the CLI pointed at the proxy |
| Wire family | path → `wire-parsers/{anthropic,openai}.js` | Body/SSE shape (Messages vs Responses) |
| OpenAI-wire client | `OPENAI_WIRE_CLIENTS` | Same Responses parser, different host / agent id / raw bucket |
| Upstream host | `UPSTREAMS` in `server/config.js` | Where to forward (api.anthropic.com, api.openai.com, xai, …) |

```
CLI  →  AGENT_PROVIDERS.createLaunch  →  proxy :port
                                           │
                    path + headers ────────┤
                                           ▼
                              getUpstreamForRequestAndHeaders
                                           │
                    wire-parsers.openai  ◄──┤── OPENAI_WIRE_CLIENTS match
                    wire-parsers.anthropic ◄─┘
```

## Current modules

| id | Launcher | Wire | Host profile |
|----|----------|------|--------------|
| `claude` | `ANTHROPIC_BASE_URL` | anthropic | `anthropic` |
| `codex` | `openai_base_url` / model_provider | openai | `openai` / ChatGPT |
| `grok` | `GROK_CLI_CHAT_PROXY_BASE_URL` | openai + client | `xai` (cli-chat-proxy) |

## Shared hub client identity

In hub mode, every launcher base URL includes `/_ccxray/client/<pid>` before the
provider API path. The HTTP and WebSocket entrypoints strip that internal route
before normal dispatch, then resolve deployment identity from the matching hub
client. This is required when two panes run the same provider: agent type alone
is ambiguous and must never fall back to the hub process environment.

Standalone `--port` launches do not use the client route. Any new provider
module must preserve the base URL returned by the shared launcher helper so the
same identity contract covers Anthropic requests, OpenAI HTTP, and OpenAI
WebSocket traffic.

## How to add a module

### A. Anthropic Messages CLI

1. Add `AGENT_PROVIDERS.<id>` with `upstream: 'anthropic'` and `createLaunch` setting the base URL env the CLI reads.
2. No new wire parser if it speaks standard Messages API.

### B. OpenAI Responses CLI (not Codex)

1. Add `AGENT_PROVIDERS.<id>` with `upstream: 'openai'`, `wire: 'openai'`, optional
   `cwdFallback: true`, and `wireDisplayName` — the capitalized name used in prose
   titles (`"Grok WebSocket session"`). It is neither `displayName` (the process
   title, `ccxray`) nor `label` (`"Grok CLI"`); omitting it falls back to `Codex`.
2. Add **one** `OPENAI_WIRE_CLIENTS` entry:

```js
{
  id: 'mycli',
  upstreamKey: 'myhost',       // key under UPSTREAMS
  rawSessionId: 'mycli-raw',   // orphan / title-gen bucket
  modelPattern: /^mycli/i,     // optional
  sessionHeaderNames: ['x-mycli-session-id'],
  controlPlaneIsNoise: true,   // hide /v1/settings-style probes
  titleGenWindowMs: 60_000,    // optional, TRANSITIONAL — opt in to a wider
                               // title-gen attribution window. Omit and the
                               // client keeps the 1s default; never widen it
                               // for everyone. The field only exists because
                               // attribution is a write-time lookup that needs
                               // a recency bound (see server/store.js
                               // attributeTitleGen); a read-time join on the
                               // content anchor removes the need for it.
  matchHeaders(headers) { /* detect this CLI */ },
}
```

Declarative fields describe **capability**, never inferred identity: per
ADR 0014 a client may not declare its session topology or subagent relation.

3. Register the host in `server/config.js` `UPSTREAMS` (and env overrides if needed).
4. Add pricing/context fallbacks for model ids if LiteLLM lags.
5. **Do not** fork `wire-parsers/openai.js`.

### C. Truly new wire (e.g. Gemini)

New `wire-parsers/<name>.js` implementing the WIRE_PARSERS interface (#158) — that is a new wire family, not a client module.

## Contract helpers

```js
const {
  listAgentProviderIds,
  describeAgentModule,
  listRawSessionBuckets,
  matchOpenAIWireClient,
} = require('./server/providers');

describeAgentModule('grok');
// → { id, hasLauncher, wire, openAIWireClient, upstreamKey, rawSessionId, … }
```

## Acceptance (any module)

- [ ] `ccxray <id>` launches without new branches in `server/index.js`
- [ ] Conversation traffic creates dashboard entries with correct `agent`
- [ ] Control-plane noise does not flood the index
- [ ] Shared hub: traffic from other modules keeps their own upstream hosts
- [ ] Shared hub: two clients of the same module retain distinct deployment identity
- [ ] Resume command uses `UPSTREAM_PROFILES` / client `upstreamKey`

Grok-specific checklist: `docs/grok-testing.md`.
