## Context

ccxray currently emits no telemetry to external systems. All observation happens via the local dashboard reading from `~/.ccxray/logs/`. Adding OpenTelemetry export changes ccxray's blast radius — data starts leaving the user's machine — and intersects with three sensitive design surfaces:

1. **Privacy.** Engineers run ccxray in their own dev environment. Any telemetry that identifies them by default would break that contract.
2. **Trust with managers.** Aggregated metrics are genuinely useful for engineering leaders, but a feature that lets a manager track individual tool usage will trigger a backlash that kills adoption.
3. **Provider neutrality.** Claude Code's CLI has built-in OTel for Anthropic; Codex/Gemini have none. ccxray must coexist with the CLI without double-counting, and must remain the only telemetry source for non-Anthropic providers.

Before drafting this design, an 11-risk pre-mortem was completed and recorded in `docs/otel-integration.html`. Every accepted solution scored ≥ 9/10 on weighted criteria including verification mechanisms. The design below is the synthesis of those solutions.

## Goals / Non-Goals

**Goals:**

- Provide ccxray-emitted OTel metrics covering cost, usage (tool/MCP/skill), quality (errors/latency/cache), patterns (context/subagent), and governance.
- Default OFF. Zero telemetry until the user explicitly opts in per-project.
- Three-tier opt-in (disabled / project-anonymous / personal-named) where the project sets an upper bound and personal config can only equal-or-downgrade.
- Coexist with Claude Code CLI's built-in OTel without overlap, with a reconciliation metric to surface accounting bugs on either side.
- Never let OTel failure break the proxy. Config errors fail at startup, init errors degrade silently, runtime errors are absorbed by a bounded queue + circuit breaker.
- Make parser drift visible. Unknown tools / skills / MCP markers must increment a sentinel counter rather than silently turn into zero.
- Provide introspection: `ccxray status --otel`, `ccxray otel preview` (dry-run), `ccxray parser report`.

**Non-Goals:**

- **Traces / spans.** Phase 1 emits metrics only. Spans, `entry_id` deep-link attributes, and `/entry/:id` drill-back UI are Phase 2.
- **Full payload export.** Request/response bodies never leave the machine. If a future user wants this, it belongs in a separate "ccxray log → S3 / self-hosted backend" product, not in the OTel pipeline.
- **Synthetic tool span timing.** Tool execution durations inferred from HTTP cadence would be misleading; the CLI emits accurate timing for Anthropic, and we will not compete with inaccurate data.
- **Central ccxray hub for team-wide aggregation.** Each engineer's ccxray remains local. Cross-machine correlation, if needed, is a Phase 2+ discussion.
- **Auto-instrumentation.** We will not pull in `@opentelemetry/auto-instrumentations-node`. ccxray controls every emit point explicitly to keep the dependency footprint and behavior predictable.

## Decisions

### D1. Default OFF with three-tier opt-in

Three tier values:

- **tier 0 (disabled)** — no OTel SDK initialization, no network egress. Default behavior when no config file or env override exists.
- **tier 1 (project anonymous)** — metrics emit with project-level attributes (`project.name`, optional `team`) but no individual identity. Activated by `.ccxray.json` checked into the repo.
- **tier 2 (personal named)** — adds `enduser.id` (a self-chosen string, not necessarily real name) to allow individual ccxray usage analytics. Activated by `.ccxray.user.json` in the working directory, which is gitignored.

Resolution rule: `effective_tier = min(project_tier, personal_tier)`. Project config is the upper bound; personal config can only equal or downgrade. An engineer can always set tier 0 in personal config to opt out of project-level emit on their own machine.

**Alternatives considered:**

- *Always-on anonymous* — rejected. "Anonymous" telemetry has well-documented re-identification risks; defaulting to ON breaks the implicit trust contract.
- *Cookie-style consent prompt at startup* — rejected. Prompt fatigue leads to blanket yes; one-time `opt_in_acknowledged_at` timestamp in personal config achieves the same intent without nagging.
- *k-anonymity at the backend* — rejected. ccxray does not control the backend; small teams (k < 5) cannot rely on this guarantee.

### D2. Client-side emit, not hub-side

OTel SDK initialization and metric emission happen in the client process (the one that ran `ccxray claude`). The hub remains a pure HTTP proxy plus SSE broadcaster. The hub MAY emit its own operational metrics under `ccxray.hub.*` namespace using a separate config (`~/.ccxray/hub-config.json`), but it does NOT emit business metrics on behalf of clients.

This means different projects connecting to the same hub can configure different tiers, endpoints, and `OTEL_RESOURCE_ATTRIBUTES` without interfering with each other.

**Alternatives considered:**

- *Hub-side emit with per-client config fanout* — rejected. Adds a routing/fan-out concern to the hub with no clear value; the hub would need to track which spans belong to which client config.
- *Hub-only emit, ignore per-project differences* — rejected. Conflicts with D1 and forces every project on a host to share one OTel destination.

### D3. `ccxray.*` namespace, never mirror `claude_code.*`

Every metric uses `ccxray.<system>.<aspect>` (`ccxray.tokens.input_total`, `ccxray.tool.invocations_total`, etc.). Every emit carries the resource attribute `ccxray.source="ccxray-proxy"`. When the CLI's `CLAUDE_CODE_ENABLE_TELEMETRY=1` is detected, ccxray enters "complement mode" and adds `ccxray.cli_otel_active=true` to its emits, plus a startup notice explaining how to choose between the two metric families.

A new reconciliation metric `ccxray.reconciliation.token_diff_pct{model}` exposes the percentage difference between ccxray's HTTP-observed token counts and what the CLI reports (when both are running). A persistent non-zero diff indicates a pricing or accounting bug on one side and is itself a high-value signal.

**Alternatives considered:**

- *Auto-disable ccxray emit when CLI is active* — rejected. Loses the reconciliation signal and forfeits ccxray's Codex/Gemini advantage.
- *Same metric names, different resource* — rejected. Backends commonly aggregate by metric name first; using the same names would force users to filter by resource attribute on every panel.

### D4. Cardinality budget with overflow fallback

Every metric declares an allow-list of attribute keys and a per-key cardinality budget (e.g. `tool=50`, `model=10`, `mcp_server=30`). Attribute values are tracked in a `Set` per (metric, attribute); when the Set reaches budget size, subsequent unique values are recorded as the literal string `_overflow_` and a sentinel counter `ccxray.metrics.overflow_total{metric,attribute}` increments.

Attribute keys not in the allow-list are dropped at the View API layer (OTel SDK native enforcement). High-cardinality candidates that look attractive (`bash.command_pattern`, `file_path`) are explicitly NOT emitted as metric labels.

**Alternatives considered:**

- *Trust the backend to handle cardinality* — rejected. Free-tier Grafana Cloud, open-source Prometheus, and many enterprise backends impose hard limits that result in dropped series or account-level throttling.
- *Silent drop on overflow* — rejected. Violates the "no silent failure" principle.

### D5. Failure isolation via state machine + bounded queue + circuit breaker

`server/otel-health.js` owns a state machine with four states:

- `disabled` — OTel never initialized (tier 0 or no config).
- `active` — SDK initialized, exports succeeding.
- `degraded` — SDK init failed; ccxray continues without OTel; status command shows the error.
- `circuit_open` — runtime export failures triggered the circuit breaker; periodic half-open retries.

The export queue is bounded (default 2048 entries, configurable). On overflow, oldest entries are dropped and `ccxray.otel.exports_dropped_total{signal}` increments locally (network is presumed unreachable when the queue overflows).

Circuit breaker: 5 consecutive failures → `circuit_open` for 60s → `half_open` test → success returns to `active`, failure backs off (60 → 120 → 240 → 600s max).

**Alternatives considered:**

- *Unbounded queue with retries* — rejected. OOMs ccxray when the collector is down.
- *Fail-fast on first error* — rejected. Transient errors are common; one timeout should not disable telemetry for the rest of the session.

### D6. Config: `.ccxray.json` + `.ccxray.user.json` with `${ENV_VAR}` interpolation

Two-file config:

- `.ccxray.json` — project root, checked into git, sets tier upper bound and shared settings (endpoint, headers, resource attributes).
- `.ccxray.user.json` — project root or `$HOME`, gitignored, sets personal identity and overrides (only ever equal-or-downgrade vs project config).

Both files support `${ENV_VAR}` interpolation in string values. The schema validator rejects any string that looks like a literal secret (`Bearer [A-Za-z0-9]{20,}`, `sk_live_*`, `ghp_*`, JWT structure) when not wrapped in `${...}`. First-time generation auto-amends `.gitignore` to include `.ccxray.user.json`.

Config errors (syntax, schema, unresolved `${VAR}`) fail at startup with a clear error pointing to the offending line. Init errors (bad endpoint format) transition to `degraded`. Runtime errors (collector down) transition to `circuit_open`.

**Alternatives considered:**

- *Single file with comments marking secrets* — rejected. JSON has no comments and the convention is too fragile.
- *Pure env-var configuration* — rejected. Loses per-project granularity; same shell environment cannot easily switch contexts when working across multiple repos.

### D7. Parser schema-ization with sentinel counters

Tool / MCP / skill / agent-type detection moves from inline strings in `system-prompt.js` / `store.js` / `helpers.js` to versioned JSON schemas under `server/parsers/`. Each schema declares the patterns it recognizes and carries a `last_verified_against` date.

For every entry processed, parsers emit:

- The recognized metrics (tool invocations, skill activations, etc.).
- `ccxray.parser.unknown_*_total{provider}` counters when a token/marker is seen but not recognized.
- `ccxray.parser.reconciliation_mismatch_total{type}` when invariants fail (e.g. count of `tool_use` blocks in response ≠ count of tools extracted by parser).

Parsers are wrapped in try/catch; on exception, `ccxray.parser.error_total{parser}` increments and the entry continues to be written to local logs (degraded OTel, never blocked proxy).

Snapshot fixtures under `test/fixtures/parser/` lock current behavior; changes require committing new snapshots and pass review.

**Alternatives considered:**

- *Keep inline parsing* — rejected. Already fragile (silent dependence on Claude Code's evolving prompt format) and cannot detect drift.
- *Server-side parser updates via remote schema fetch* — rejected. Adds a new failure surface and security concern.

### D8. CLI surface: `status --otel`, `otel preview`, `parser report`

- `ccxray status --otel` — current tier, endpoint, OTel state, cardinality usage (e.g. `tool: 23/50`), dropped event counters, circuit breaker state.
- `ccxray otel preview` — dry-run printing the next export's content without sending. Lets users see exactly what would be exported before enabling.
- `ccxray parser report` — last 7 days of unknown tool / skill / MCP markers grouped by frequency; generates a GitHub issue template body for drift reports.

Startup banner declares the active tier and (if applicable) complement-mode coexistence with CLI OTel.

## Risks / Trade-offs

- **Risk: Adoption stalls because individual devs do not have an OTel backend.** → Ship `ccxray --otel-demo` that spins up a local Grafana + Prometheus via Docker Compose so a developer can see their own metrics in 30 seconds without joining any external service. Set a 3-month KPI gate: < 10 GitHub references → pause Phase 2 investment.
- **Risk: Manager misuse for individual surveillance.** → Default OFF + tier 2 requires personal opt-in by the engineer + explicit `docs/otel-ethics.md` distributed as part of the change ("these metrics are not for individual performance evaluation; the reasons follow…"). Track `ccxray.otel.tier_distribution`: if tier 2 share is < 5%, strengthen the docs.
- **Risk: Cardinality explosion despite budgets.** → Budgets enforced at SDK View API layer with sentinel counter for overflow visibility. CI lint blocks new metrics that lack a schema entry. `ccxray.metrics.overflow_total > 0` for sustained periods triggers an in-status warning.
- **Risk: Bundle bloat from OTel SDK.** → Import only `@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/resources`. No auto-instrumentations. Optional dependency pattern so the package still resolves when OTel deps are absent (lazy require).
- **Risk: Hub-mode env changes don't propagate.** → Business OTel is client-side (D2); hub env only affects `ccxray.hub.*` operational metrics. `ccxray status` displays per-client tier/endpoint so users can see whether each client has picked up the env they expected.
- **Risk: Parser drift when Anthropic changes the prompt format.** → Sentinel counters (`ccxray.parser.unknown_*_total`) make drift visible within hours instead of months; `last_verified_against` dates trigger quarterly re-verification; `ccxray parser report` makes drift reports easy to file.
- **Risk: OTel semconv conventions evolve and our attribute names become out of date.** → All metric names live in the schema registry under `server/otel.js`; a future migration is a search-and-replace plus a deprecation period.
- **Trade-off: We do not compete with the CLI on Anthropic tool span timing.** → Acceptable. Our value is the HTTP-layer truth, Codex/Gemini coverage, the reconciliation diff, and the future Phase 2 drill-back.

## Migration Plan

- **Forward.** Phase 1 ships behind opt-in defaults; existing ccxray users see no behavior change. Adopters add a `.ccxray.json`, set an endpoint, and confirm with `ccxray otel preview` before traffic flows. The `--otel-demo` subcommand provides a zero-config local Grafana for evaluation.
- **Rollback.** Each `ccxray.*` metric is a contract; once shipped, names cannot be renamed without a deprecation cycle. The schema registry tracks every metric with its introduction version.
- **Phase 2 prerequisites.** Shared modules introduced here (`otel-health.js`, `config-loader.js`, parser schemas, sentinel framework, status surface) are designed to host Phase 2's span emit and `/entry/:id` route without rework.

## Open Questions

- Should `.ccxray.json` lookup walk up from cwd to the nearest enclosing dir (monorepo-friendly), or only check cwd? Recommendation: walk up to nearest git root, take the first match.
- Should we ship `--otel-demo` Docker Compose files in this PR or as a follow-up doc? Recommendation: follow-up, to keep Phase 1 scope tight.
- Should `ccxray.hub.*` operational metrics ship in Phase 1 or be deferred? Recommendation: defer to keep this change focused on the client side.
- For the auto-update of `.gitignore`, should the user be prompted or should it be automatic? Recommendation: prompt the first time, with a `--yes` flag for automation.
- Should `ccxray --otel-demo` be a documented dev tool only, or a supported feature? Recommendation: dev tool only (clearly labeled experimental).
