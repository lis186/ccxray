## ADDED Requirements

### Requirement: `ccxray status --otel` shows effective configuration and health

The `ccxray status --otel` command SHALL print:

- The current effective tier (0/1/2) and which config files contributed.
- The endpoint URL with any `${VAR}` masked.
- The OTel health state (`disabled / active / degraded / circuit_open`) and last 3 state transitions with timestamps.
- The circuit breaker cooldown remaining (when applicable).
- Per-metric cardinality usage in `current / budget` format (e.g. `tool: 23/50`).
- Total counts: exports succeeded, exports failed, exports dropped (last hour and last 24 hours).
- The `opt_in_acknowledged_at` timestamp for tier 2 (when applicable).
- CLI coexistence indicator: whether `CLAUDE_CODE_ENABLE_TELEMETRY` is detected.

#### Scenario: Status at tier 1

- **WHEN** ccxray is running at tier 1 with a healthy collector
- **THEN** `ccxray status --otel` SHALL show `tier=1`, `state=active`, the endpoint, cardinality usage rows for each registered metric, and the export success/failure counts

#### Scenario: Status at tier 0

- **WHEN** ccxray is running at tier 0
- **THEN** `ccxray status --otel` SHALL show `tier=0`, `state=disabled`, and SHALL NOT attempt to read OTel runtime state

### Requirement: `ccxray otel preview` dry-run

The `ccxray otel preview` command SHALL print the exact JSON body that would be sent to the OTel collector on the next export, including all attribute values and resource attributes, WITHOUT sending any network request. Secrets resolved from `${ENV_VAR}` SHALL be masked in the output.

#### Scenario: Preview before enabling

- **WHEN** an engineer runs `ccxray otel preview` after setting up `.ccxray.json`
- **THEN** the command SHALL print a single JSON object representing the next export, with `Authorization` and similar header values shown as `Bearer ***` rather than the resolved token

#### Scenario: Preview with no recent metrics

- **WHEN** ccxray has no queued metrics to export
- **THEN** the command SHALL print a notice that no metrics are pending and SHALL exit zero

### Requirement: Startup banner declares active tier and mode

When ccxray starts at tier ≥ 1, it SHALL print a one-line banner to stderr summarizing: tier value, endpoint (without secret), and complement-mode status (if CLI OTel is active). The banner SHALL NOT print when tier is 0.

#### Scenario: Banner at tier 1 standalone

- **WHEN** ccxray starts at tier 1 without CLI OTel
- **THEN** stderr SHALL contain a single line matching the pattern `ccxray OTel tier: 1 (anonymous) → <endpoint>` followed by no further banner output for that launch

#### Scenario: Banner at tier 1 complement

- **WHEN** ccxray starts at tier 1 with `CLAUDE_CODE_ENABLE_TELEMETRY=1`
- **THEN** stderr SHALL contain a line indicating `tier: 1` and `complement-mode: true`

#### Scenario: No banner at tier 0

- **WHEN** ccxray starts at tier 0
- **THEN** stderr SHALL NOT contain any OTel-related banner line

### Requirement: Secrets masking in all introspection output

`ccxray status --otel` and `ccxray otel preview` SHALL mask any value resolved from a `${VAR}` interpolation. Masked values SHALL display as the prefix (up to 4 characters) followed by `***`. The full unmasked value SHALL never be printed by any introspection command.

#### Scenario: Auth header masked

- **WHEN** the resolved auth header is `Bearer abc123longtokenvalue`
- **THEN** introspection output SHALL display `Bearer abc1***` and SHALL NOT print the remainder of the token
