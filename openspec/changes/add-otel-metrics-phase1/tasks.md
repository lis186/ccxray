## 1. Dependencies and package wiring

- [x] 1.1 Add `@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/resources` as `dependencies` in `package.json` (no auto-instrumentations)
- [x] 1.2 Implement lazy require in a helper so ccxray still runs at tier 0 when OTel packages are absent
- [x] 1.3 Update `package-lock.json` and confirm bundle size delta is within an acceptable bound

## 2. Config loader (`server/config-loader.js`)

- [ ] 2.1 Define JSON schema for `.ccxray.json` (project) and `.ccxray.user.json` (personal) covering: `otel.enabled`, `otel.tier`, `otel.endpoint`, `otel.headers`, `otel.resource_attributes`, `otel.cardinality_overrides`
- [ ] 2.2 Implement schema validation with line/column error reporting
- [ ] 2.3 Implement `${ENV_VAR}` interpolation across all string values; fail fast with named variable on unresolved
- [ ] 2.4 Implement literal-secret detector (Bearer/JWT/`sk_*`/`ghp_*`) that rejects values not wrapped in `${...}`
- [ ] 2.5 Implement project config lookup walking up from cwd to git root, taking the first `.ccxray.json` match
- [ ] 2.6 Implement personal config lookup: cwd first, then `$HOME` fallback
- [ ] 2.7 Implement tier resolution `effective = min(project_tier, personal_tier)` with downward clamp warning
- [ ] 2.8 Implement `.gitignore` check and auto-amend with `--yes` flag for `.ccxray.user.json`
- [ ] 2.9 Reject personal config that is currently tracked by git, with explanatory error
- [ ] 2.10 Persist `opt_in_acknowledged_at` ISO 8601 timestamp on first tier 2 enable
- [ ] 2.11 Unit tests covering all error paths, interpolation, secret rejection, tier resolution matrix

## 3. OTel health module (`server/otel-health.js`)

- [x] 3.1 Implement state machine with four states: `disabled / active / degraded / circuit_open` and transitions only via documented APIs
- [ ] 3.2 Implement bounded export queue with drop-oldest semantics and `ccxray.otel.exports_dropped_total{signal}` increment per drop
- [ ] 3.3 Implement circuit breaker: 5 consecutive failures trips, 60s initial cooldown, half-open trial, exponential backoff to 600s max
- [ ] 3.4 Implement `~/.ccxray/otel.log` append writer with size-based rotation (default 1 MB, 5 file retention)
- [x] 3.5 Implement SDK shutdown with 2-second hard cap to never block process exit
- [ ] 3.6 Surface state and metrics via a status reporter API consumed by the CLI status command
- [ ] 3.7 Unit tests with mock collector (200 / 500 / timeout) covering queue overflow, circuit transitions, half-open recovery, and exponential backoff

## 4. OTel SDK initialization (`server/otel.js`)

- [x] 4.1 Implement SDK init for metrics only, with `ccxray.source="ccxray-proxy"` resource attribute
- [ ] 4.2 Define metric registry with allow-list of attribute keys and cardinality budgets per metric (View API)
- [ ] 4.3 Implement cardinality budget tracker with `_overflow_` fallback and `ccxray.metrics.overflow_total{metric,attribute}` sentinel
- [ ] 4.4 Detect `CLAUDE_CODE_ENABLE_TELEMETRY=1` and apply `ccxray.cli_otel_active=true` attribute in complement mode
- [ ] 4.5 Register all metric families per `otel-export/spec.md`: cost, usage, quality, patterns, governance
- [ ] 4.6 Register sentinel metrics: overflow, parser unknowns, parser mismatches, otel state, reconciliation diff, tier distribution
- [ ] 4.7 Implement export-time masking of any value resolved from `${ENV_VAR}` for log lines and trace dumps
- [ ] 4.8 Implement internal invariant metrics (`ccxray.invariants.parser_mismatch_total{type}`, `ccxray.invariants.sse_truncated_total`) — cross-source diff against CLI is NOT in Phase 1; documented as downstream pattern instead
- [ ] 4.9 Unit tests for namespace lint (no metric name starts with `claude_code.`), source attribute presence, budget enforcement, complement mode attribute, lazy SDK init at tier 0

## 5. Parser schema-ization (`server/parsers/`)

- [ ] 5.1 Define the JSON schema format (fields: `version`, `last_verified_against`, `patterns`, `examples`)
- [ ] 5.2 Author `parsers/anthropic-tools.schema.json` covering current internal tool names
- [ ] 5.3 Author `parsers/anthropic-skills.schema.json` covering known skill marker formats from `system-prompt.js`
- [ ] 5.4 Author `parsers/anthropic-agent-types.schema.json` for general / explore / plan / known subagent types
- [ ] 5.5 Author `parsers/mcp-tools.schema.json` for `mcp__<server>__<tool>` naming
- [ ] 5.6 Author `parsers/codex-tools.schema.json` for OpenAI Responses tool patterns
- [ ] 5.7 Implement parser dispatch in `server/parsers/index.js` consuming the schemas
- [ ] 5.8 Replace inline string matching in `server/system-prompt.js`, `server/store.js`, and `server/helpers.js` with schema dispatch calls
- [ ] 5.9 Implement sentinel emission for unknown tools / skills / MCP markers and `~/.ccxray/parser-drift.log` append writer
- [ ] 5.10 Implement reconciliation invariants: tool_use block count equals extracted count; token attribution sums equal usage block values
- [ ] 5.11 Wrap parser calls in try/catch with `ccxray.parser.error_total{parser,error_type}` increment and `ccxray.parser.degraded=true` attribute on the affected entry
- [ ] 5.12 Author snapshot fixtures under `test/fixtures/parser/` for every (provider, scenario) pair listed in `parser-schemas/spec.md`
- [ ] 5.13 Wire snapshot tests into `npm test`

## 6. Wire metrics into forward / store paths

- [ ] 6.1 In `server/forward.js`, emit cost / token / latency / error / stop_reason metrics after each completed forward, using the otel-health queue _(partial: `emit('entry_completed', { entry })` wired in all 3 forward paths with full entry payload; routing through the otel-health queue is pending §3.2)_
- [ ] 6.2 In `server/store.js`, emit usage / pattern / governance metrics as session/tool/skill/MCP detection runs through the new parsers
- [ ] 6.3 Ensure no emit path can throw into the proxy code path; all emits are best-effort
- [ ] 6.4 Add a unit test that verifies forward.js continues to function with OTel disabled, init-failed (degraded), and circuit_open states

## 7. CLI introspection commands

- [ ] 7.1 Implement `ccxray status --otel` per `otel-introspection/spec.md`: tier, endpoint (masked), state, transitions, cooldown, cardinality usage rows, success/failure/dropped counts, opt_in_acknowledged_at, CLI coexistence flag
- [ ] 7.2 Implement `ccxray otel preview` dry-run printing next-export JSON with secrets masked
- [ ] 7.3 Implement `ccxray parser report` command summarizing top unknown tokens and generating a GitHub issue body template
- [ ] 7.4 Add startup banner declaring tier and complement-mode status when tier ≥ 1
- [ ] 7.5 Unit tests for each command and banner output

## 8. Hub-side coexistence (minimal Phase 1 changes)

- [ ] 8.1 Confirm the hub does NOT initialize OTel SDK for business metrics; document this explicitly in the hub module header comment
- [ ] 8.2 Make `ccxray status` aware of per-client OTel state via hub's existing client registration channel (so cross-client visibility works)
- [ ] 8.3 Defer `ccxray.hub.*` operational metrics to a follow-up change (per Open Questions in design.md)

## 9. Documentation

- [ ] 9.1 Add `docs/otel-ethics.md` (bilingual): why these metrics are not for individual performance evaluation; what acceptable uses look like
- [ ] 9.2 Add `docs/otel-quickstart.md` (bilingual): 90-second Grafana onboarding with screenshots
- [ ] 9.3 Reference `docs/otel-integration.html` (existing) as the design record from README
- [ ] 9.4 Update README with a single section: "Optional: send metrics to your observability backend" linking to quickstart and ethics docs
- [ ] 9.5 Update `CLAUDE.md` Architecture section to note the new modules and their roles
- [ ] 9.6 Add `docs/otel-recon.md` (bilingual): why cross-source reconciliation is a downstream concern, recording-rule / Grafana-panel / sidecar recipes for diffing ccxray vs CLI counts on `request_id`

## 10. Verification gates

- [ ] 10.1 CI lint: every emitted metric name MUST exist in `server/otel.js` schema registry; new metrics without registry entries fail build
- [ ] 10.2 CI lint: no metric name SHALL start with `claude_code.`; assertion runs across all `server/**/*.js`
- [ ] 10.3 Integration test: spin a local OTLP collector (docker), run a synthetic ccxray session, assert collector received the expected metric families with correct attributes
- [ ] 10.4 Integration test: simulate collector returning 500 → assert circuit opens, queue drops oldest, ccxray continues forwarding
- [ ] 10.5 Integration test: simulate `CLAUDE_CODE_ENABLE_TELEMETRY=1` → assert `cli_otel_active` attribute appears on emitted metrics
- [ ] 10.6 Manual usability test: 3 new engineers walk README + quickstart, target median time-to-first-metric < 5 minutes
- [ ] 10.7 Set 3-month KPI gate in repo: track GitHub references to "otel" / "OTEL_EXPORTER"; if < 10 within 3 months of release, pause Phase 2 work and revisit

## 11. Release prep

- [ ] 11.1 Update CHANGELOG with new dependencies, default-off behavior, three-tier model, and link to design doc
- [ ] 11.2 Confirm npm publish package size delta and document in PR description
- [ ] 11.3 Open follow-up issue for Phase 2 (span emit + `/entry/:id` drill-back)
- [ ] 11.4 Open follow-up issue for `--otel-demo` Docker Compose helper
- [ ] 11.5 Open follow-up issue for `ccxray.hub.*` operational metrics
