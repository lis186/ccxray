## ADDED Requirements

### Requirement: Four-state OTel health machine

ccxray SHALL maintain an OTel health state machine with exactly four states: `disabled`, `active`, `degraded`, and `circuit_open`. Transitions SHALL be driven exclusively by the conditions described in the subsequent requirements; no other code path SHALL mutate state.

#### Scenario: Disabled at startup

- **WHEN** effective tier is 0 or OTel packages are absent
- **THEN** the state SHALL be `disabled` and `ccxray.otel.state` SHALL emit only its disabled gauge (where possible) and otherwise stay silent

#### Scenario: Active after successful init

- **WHEN** effective tier is ≥ 1 and SDK initialization completes
- **THEN** the state SHALL be `active`

### Requirement: Bounded export queue with drop-oldest semantics

The OTel export queue SHALL be bounded by a configurable size (default 2048 entries). When the queue is full and a new export is attempted, the oldest queued entry SHALL be dropped to make room. Each drop SHALL increment `ccxray.otel.exports_dropped_total{signal}`.

#### Scenario: Queue under limit

- **WHEN** the queue holds fewer than its configured maximum entries and a new export arrives
- **THEN** the new entry SHALL be appended and no drop SHALL occur

#### Scenario: Queue at limit

- **WHEN** the queue is at its configured maximum and a new export arrives
- **THEN** the oldest entry SHALL be removed, the new entry SHALL be appended, and `ccxray.otel.exports_dropped_total{signal="<signal name>"}` SHALL increment by 1

### Requirement: Circuit breaker with exponential backoff

After 5 consecutive export failures, the state SHALL transition to `circuit_open` and exports SHALL be paused. After an initial cooldown of 60 seconds, the state SHALL transition to `half_open` and a single export SHALL be attempted. Success SHALL return the state to `active`. Failure SHALL keep the state at `circuit_open` and the cooldown SHALL double up to a maximum of 600 seconds.

#### Scenario: Trip on 5 consecutive failures

- **WHEN** 5 consecutive export attempts return errors
- **THEN** the state SHALL transition to `circuit_open` and no further exports SHALL be attempted until the cooldown elapses

#### Scenario: Half-open success returns to active

- **WHEN** the cooldown elapses, the state moves to `half_open`, and the trial export succeeds
- **THEN** the state SHALL transition back to `active` and the cooldown SHALL reset to 60 seconds

#### Scenario: Half-open failure increases cooldown

- **WHEN** the trial export in `half_open` fails
- **THEN** the state SHALL remain `circuit_open` and the next cooldown SHALL be `min(previous_cooldown * 2, 600)` seconds

### Requirement: Failure log on local disk

Failed export attempts and state transitions SHALL be written to `~/.ccxray/otel.log` in append mode. The file SHALL be rotated once it exceeds a configurable size (default 1 MB). Rotated files SHALL be retained up to a configurable count (default 5).

#### Scenario: Export error recorded

- **WHEN** an export attempt fails with a network error
- **THEN** a single line SHALL be appended to `~/.ccxray/otel.log` containing the timestamp, the error class, and the queue depth at time of failure

#### Scenario: File rotated at size limit

- **WHEN** `~/.ccxray/otel.log` exceeds 1 MB
- **THEN** it SHALL be renamed to `otel.log.1` (with existing rotations shifted), a fresh `otel.log` SHALL be created, and files beyond the retention count SHALL be deleted

### Requirement: Never-block guarantee for the proxy

OTel export operations SHALL NOT block the HTTP proxy path. All emit operations SHALL enqueue without awaiting export completion. SDK shutdown during process exit SHALL be capped at 2 seconds and SHALL NOT prevent clean exit on timeout.

#### Scenario: Collector unreachable

- **WHEN** the OTLP endpoint is unreachable for the duration of a proxy request
- **THEN** the proxy SHALL forward the request and return the response with no additional latency from OTel

#### Scenario: SDK shutdown timeout

- **WHEN** the process is exiting and OTel SDK flush is in progress
- **THEN** the shutdown SHALL be aborted after 2 seconds and the process SHALL exit cleanly

### Requirement: Config errors fail fast, init/runtime errors degrade

Config parsing or schema errors SHALL cause non-zero process exit at startup with an actionable message. SDK initialization errors (e.g. invalid endpoint URL format) SHALL transition the state to `degraded` and SHALL NOT block ccxray startup. Runtime export errors SHALL be handled by the circuit breaker without affecting other ccxray behavior.

#### Scenario: Bad endpoint URL

- **WHEN** `.ccxray.json` sets `otel.endpoint` to a string that is not a valid URL
- **THEN** ccxray SHALL continue to start, the state SHALL be `degraded`, the dashboard and proxy SHALL function normally, and `ccxray status --otel` SHALL display the error

#### Scenario: Missing required field

- **WHEN** `.ccxray.json` enables tier 1 but omits `otel.endpoint`
- **THEN** ccxray SHALL exit non-zero at startup with an error pointing to the missing field

### Requirement: Health state observable via metric and status command

The current health state SHALL be observable through (a) a gauge `ccxray.otel.state{state}` (where possible — emitted only when state is `active` or `degraded`), and (b) the `ccxray status --otel` output regardless of state.

#### Scenario: State visible in status command

- **WHEN** an engineer runs `ccxray status --otel`
- **THEN** the output SHALL include the current state, the last 3 state transitions with timestamps, and the current circuit breaker cooldown remaining (if applicable)
