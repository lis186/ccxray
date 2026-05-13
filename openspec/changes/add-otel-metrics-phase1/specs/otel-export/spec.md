## ADDED Requirements

### Requirement: Client-side OTel SDK initialization

OTel SDK initialization SHALL occur in the client process (the one running `ccxray claude` or similar) and SHALL NOT occur in the hub process. The hub SHALL remain a pure HTTP proxy and SSE broadcaster.

#### Scenario: Client initializes OTel

- **WHEN** a ccxray client process starts with tier ≥ 1
- **THEN** the OTel SDK SHALL initialize within the client process and emit metrics tagged with that client's resource attributes

#### Scenario: Hub does not emit business metrics

- **WHEN** the ccxray hub forwards an HTTP request between a client and an upstream provider
- **THEN** the hub SHALL NOT emit any business metric on behalf of the client, regardless of the client's tier setting

### Requirement: `ccxray.*` namespace for all emitted metrics

Every metric SHALL be named under the `ccxray.<system>.<aspect>` pattern. No metric SHALL be named identically to a Claude Code CLI metric or any other upstream OTel convention that would overlap.

#### Scenario: Metric naming

- **WHEN** an OTel metric is registered
- **THEN** its name SHALL start with the literal prefix `ccxray.`

#### Scenario: Namespace collision prevention

- **WHEN** code attempts to register a metric whose name matches a `claude_code.*` pattern
- **THEN** registration SHALL fail and tests SHALL flag it

### Requirement: Source resource attribute on every emit

Every metric SHALL carry the resource attribute `ccxray.source="ccxray-proxy"` so that backends can filter ccxray-emitted data from data emitted by other OTel sources running on the same host.

#### Scenario: Source attribute present

- **WHEN** any metric is exported by ccxray
- **THEN** its resource attributes SHALL include `ccxray.source="ccxray-proxy"`

### Requirement: Cardinality budget enforcement

Each metric SHALL declare its allowed attribute keys and a numeric cardinality budget per key. Attribute keys not in the allow-list SHALL be dropped via OTel View API. When the count of unique values for an allow-listed key reaches its budget, subsequent unique values SHALL be replaced with the literal string `_overflow_` and the sentinel counter `ccxray.metrics.overflow_total{metric,attribute}` SHALL increment.

#### Scenario: Allowed attribute within budget

- **WHEN** `ccxray.tool.invocations_total` receives an attribute `tool="Read"` and `Read` is the 3rd of 50 budgeted tool names
- **THEN** the metric SHALL emit with `tool="Read"` and `ccxray.metrics.overflow_total` SHALL NOT increment

#### Scenario: Budget exhausted

- **WHEN** the cardinality budget for `tool` is 50 and a 51st unique tool name arrives
- **THEN** the metric SHALL emit with `tool="_overflow_"` and `ccxray.metrics.overflow_total{metric="ccxray.tool.invocations_total",attribute="tool"}` SHALL increment by 1

#### Scenario: Unallowed attribute key

- **WHEN** code attempts to record `ccxray.tool.invocations_total` with attribute `bash_command="rm -rf /tmp/foo"` while `bash_command` is not in the allow-list
- **THEN** the `bash_command` attribute SHALL be dropped before emission

### Requirement: CLI OTel coexistence and complement mode

ccxray SHALL detect the presence of `CLAUDE_CODE_ENABLE_TELEMETRY=1` in the environment and, when detected, SHALL emit all metrics with an additional attribute `ccxray.cli_otel_active=true`. ccxray SHALL print a startup notice explaining how to choose between ccxray and CLI metrics when both are active. ccxray SHALL NOT disable any of its own metrics based on CLI coexistence.

#### Scenario: CLI OTel detected

- **WHEN** ccxray starts with `CLAUDE_CODE_ENABLE_TELEMETRY=1` set
- **THEN** ccxray SHALL print a startup notice indicating complement mode and SHALL add `ccxray.cli_otel_active=true` to all emitted metrics

#### Scenario: CLI OTel not detected

- **WHEN** ccxray starts without `CLAUDE_CODE_ENABLE_TELEMETRY`
- **THEN** ccxray SHALL print a notice indicating standalone mode and the attribute `ccxray.cli_otel_active` SHALL NOT be set

### Requirement: Internal invariant metrics; cross-source reconciliation is a downstream concern

ccxray SHALL emit invariant metrics that describe ccxray-internal consistency only. ccxray SHALL NOT emit a cross-source diff metric (e.g. ccxray vs CLI token counts) as part of Phase 1. Cross-source reconciliation SHALL be performed by downstream consumers (recording rules, Grafana panels, sidecar processes) using `request_id` or `session_id` joins on per-request metrics emitted independently by ccxray and the CLI.

Rationale: A pre-aggregated diff gauge cannot answer "which request diverged" and produces persistent non-zero values for legitimate reasons (SSE chunking boundaries, retries, prompt-caching edge cases), creating alert fatigue. ccxray's correct role is to emit faithful per-request signals; cross-source diff is an analytical task that belongs in the user's observability tier, where it can be expressed as a derived series.

#### Scenario: Parser sum invariant

- **WHEN** ccxray's parser extracts a sum of per-tool token attributions that differs from the upstream `usage` block totals for the same response
- **THEN** `ccxray.invariants.parser_mismatch_total{type="token_sum"}` SHALL increment

#### Scenario: SSE stream completeness invariant

- **WHEN** ccxray observes the upstream SSE stream terminating without a `[DONE]` (Anthropic) or `response.completed` (OpenAI Responses) terminal event
- **THEN** `ccxray.invariants.sse_truncated_total{provider}` SHALL increment

#### Scenario: No cross-source diff gauge is emitted

- **WHEN** OTel is enabled at any tier
- **THEN** no metric whose name matches `ccxray.reconciliation.*` SHALL be registered with the SDK in Phase 1

### Requirement: Required metric families

ccxray SHALL emit the following metric families when OTel is enabled:

- **Cost**: `ccxray.tokens.input_total`, `ccxray.tokens.output_total`, `ccxray.tokens.cache_read_total`, `ccxray.tokens.cache_creation_total`, `ccxray.cost.usd_total`, `ccxray.cache.hit_ratio` (gauge).
- **Usage**: `ccxray.tool.invocations_total{tool,provider}`, `ccxray.mcp.invocations_total{server,tool}`, `ccxray.skill.activations_total{skill,provider}`, `ccxray.sessions_total{provider}`, `ccxray.agent_type.invocations_total{type}`.
- **Quality**: `ccxray.errors_total{type,provider}`, `ccxray.stop_reason_total{reason}`, `ccxray.latency_ms` (histogram, attributes: `model`,`provider`), `ccxray.max_tokens_hit_total{model}`.
- **Patterns**: `ccxray.context.utilization_pct` (histogram), `ccxray.auto_compact.triggered_total`, `ccxray.subagent.invocations_total`, `ccxray.tools_per_turn` (histogram).
- **Governance**: `ccxray.permission_mode.usage_total{mode}`, `ccxray.dangerous_tool.invocations_total{pattern}`, `ccxray.file_writes_total`, `ccxray.provider.distribution_total{provider}`.

Each metric SHALL be registered with its allow-list of attribute keys and cardinality budget at SDK initialization.

#### Scenario: Cost metric emission after a turn

- **WHEN** ccxray completes forwarding a request and receives a usage block from the upstream provider
- **THEN** `ccxray.tokens.input_total`, `ccxray.tokens.output_total`, and `ccxray.cost.usd_total` SHALL each increment by the corresponding value

#### Scenario: Tool invocation metric

- **WHEN** ccxray detects a `tool_use` block named `Bash` in a response
- **THEN** `ccxray.tool.invocations_total` SHALL increment by 1 with attribute `tool="Bash"`

### Requirement: Minimal optional dependencies

The OTel-related Node.js dependencies SHALL be limited to `@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`, and `@opentelemetry/resources`. Auto-instrumentation packages SHALL NOT be included. Dependencies SHALL be resolved lazily so that ccxray remains functional even when OTel packages are absent (tier 0 only).

#### Scenario: OTel packages absent and tier 0

- **WHEN** OTel packages are not installed and effective tier is 0
- **THEN** ccxray SHALL start normally without referencing any OTel package

#### Scenario: OTel packages absent and tier ≥ 1

- **WHEN** OTel packages are not installed and effective tier is ≥ 1
- **THEN** ccxray SHALL emit a clear error explaining which packages to install and SHALL exit non-zero
