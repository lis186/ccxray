## Why

ccxray captures everything an agent does at the HTTP layer — full request/response, token counts, cost, tool calls, MCP server activity, skill activations — but the data lives only in the local dashboard. Teams that already operate Grafana / Datadog / Honeycomb cannot aggregate ccxray's signals into their existing observability pipeline. Claude Code's CLI has built-in OTel for Anthropic only and does not expose the HTTP-layer truth ccxray sees; Codex, Gemini, and future providers have no OTel at all. The full design rationale, pre-mortem (11 risks scored ≥ 9/10) and alternative options live at `docs/otel-integration.html`.

This change adds Phase 1: emit ccxray's metrics over OTLP, gated behind a default-off tiered opt-in, with a failure model that never degrades the proxy. Phase 2 (metadata-only traces with `entry_id` drill-back) is a follow-up.

## What Changes

- New optional metric export under `ccxray.*` namespace covering cost, usage (tool / MCP / skill / agent_type / provider), quality (errors, stop_reason, latency, max_tokens_hit_rate), patterns (context_utilization, auto_compact_triggered, subagent_ratio, tools_per_turn) and governance (permission_mode, dangerous_tool, file_writes).
- New configuration files: `.ccxray.json` (repo, project-level) and `.ccxray.user.json` (gitignored, personal). `${ENV_VAR}` interpolation. Schema rejects literal-looking secrets. Auto-add `.ccxray.user.json` to `.gitignore` if missing.
- Three-tier opt-in model: **tier 0 disabled (default)** / tier 1 anonymous project-level / tier 2 personal named. Project config is the upper bound; personal config can only equal or downgrade. Engineers can opt out unilaterally.
- Detect `CLAUDE_CODE_ENABLE_TELEMETRY=1` and enter "complement mode" with `ccxray.cli_otel_active=true` attribute; every metric carries `ccxray.source="ccxray-proxy"` resource attribute. ccxray emits ccxray-internal invariant metrics (`ccxray.invariants.*`); cross-source reconciliation against the CLI is documented as a downstream pattern (recording rules / sidecar / wide-event join on `request_id`) in `docs/otel-recon.md`, not as an in-proxy gauge — keeps ccxray as a transparent proxy with bounded blast radius.
- Cardinality budget per (metric, attribute) with `_overflow_` fallback and `ccxray.metrics.overflow_total` sentinel; attribute key allow-list enforced via OTel View API.
- Parser schema-ization: extract tool / MCP / skill detection into `server/parsers/*.schema.json` with snapshot fixtures, sentinel metrics (`ccxray.parser.unknown_*_total`), and reconciliation invariants (tool_use block count must equal extracted count).
- Failure fallback: config errors fail fast at startup; init errors degrade silently (ccxray keeps proxying); runtime errors handled by bounded queue (drop oldest) + circuit breaker (5 failures → open 60s → exponential backoff). OTel failures **never** break the proxy.
- New shared modules: `server/otel-health.js` (state machine, circuit breaker, bounded queue, local log writer) and `server/config-loader.js` (JSON schema validation, env interpolation, secret detection, gitignore check).
- OTel emit lives in the **client** process, not the hub. Each project's tier/endpoint coexists on the same hub. Hub gains its own operational metrics under `ccxray.hub.*` namespace.
- New CLI commands: `ccxray status --otel` (current tier, endpoint, health, cardinality usage), `ccxray otel preview` (dry-run printing the next export's content), `ccxray parser report` (recent unknown events for drift detection).
- Out of scope (Phase 2 follow-up): span emit (traces), `/entry/:id` deep-link route, `ccxray.entry_id` / `dashboard_url` attributes.

## Capabilities

### New Capabilities

- `otel-config`: `.ccxray.json` and `.ccxray.user.json` schema, `${ENV_VAR}` interpolation, literal-secret rejection, `.gitignore` auto-amend, project-upper-bound + personal-lower-bound merging rules.
- `otel-export`: OTel SDK initialization (client-side, not hub), metric definitions under `ccxray.*` namespace, `ccxray.source` resource attribute, cardinality budget enforcement with `_overflow_` fallback, CLI coexistence detection and complement-mode signaling, ccxray-internal invariant metrics, explicit non-emit of cross-source diff gauge (deferred to downstream).
- `otel-tiers`: three-tier opt-in (disabled / project-anonymous / personal-named), tier resolution with project as upper bound and personal as lower bound, `enduser.id` attribute only in tier 2, opt-in acknowledgment timestamp persisted in personal config.
- `otel-health`: failure state machine (`disabled / active / degraded / circuit_open`), bounded export queue with drop-oldest semantics, circuit breaker with exponential backoff, local failure log at `~/.ccxray/otel.log` with rotation, never-block guarantee for the proxy path.
- `parser-schemas`: extract skill / MCP / tool / agent-type detection into versioned JSON schemas, snapshot fixtures per provider (Anthropic + Codex), sentinel metrics for unknown events, reconciliation invariants run per entry, try/catch isolation so parser failure does not affect ccxray core.
- `otel-introspection`: `ccxray status --otel` view (tier, endpoint, health, cardinality, dropped counts), `ccxray otel preview` dry-run, `ccxray parser report` for drift inspection, startup banner declaring active tier and CLI coexistence mode.

### Modified Capabilities

(None — Phase 1 is additive. Existing capabilities are not changed.)

## Impact

- New `server/otel.js`, `server/otel-health.js`, `server/config-loader.js`, `server/parsers/` directory tree (schemas + fixtures + unknown-handler).
- `server/forward.js` — emit metric on request completion (counters + histograms) via the otel-health-guarded queue; no behavior change when OTel is disabled.
- `server/store.js` — session / tool / skill / MCP / agent_type detection becomes a thin shim over `server/parsers/*`; reconciliation invariants run per entry; sentinel counters incremented on unknown.
- `server/system-prompt.js` — agent-type and skill marker detection moves into `parsers/anthropic-skills.schema.json`; existing parsing behavior preserved.
- `server/hub.js` — hub gains optional `ccxray.hub.*` operational metrics (uptime, request rate, connected clients) under its own config in `~/.ccxray/hub-config.json`. Hub does NOT emit business metrics; those stay client-side.
- `server/routes/api.js` — no new HTTP routes in Phase 1 (deep-link route is Phase 2).
- `bin/ccxray.js` or equivalent CLI entry — new subcommands: `status --otel`, `otel preview`, `parser report`. Existing commands unaffected when OTel is disabled.
- `package.json` — add minimal OTel dependencies (`@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/resources`). No auto-instrumentations. Optional dependency pattern so the package still works if OTel is not installed.
- New docs: `docs/otel-integration.html` (already exists, decision record), `docs/otel-ethics.md` (why these metrics are not for individual performance evaluation), `docs/otel-quickstart.md` (90-second Grafana onboarding).
- Tests: parser snapshot fixtures, cardinality budget enforcement tests, tier resolution matrix tests, failure-mode tests (collector down, bad endpoint, bad auth, malformed config).
