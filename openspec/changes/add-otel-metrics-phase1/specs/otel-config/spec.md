## ADDED Requirements

### Requirement: Project and personal config files

ccxray SHALL read two optional configuration files at startup: `.ccxray.json` (project-level, repo-checked-in) and `.ccxray.user.json` (personal-level, gitignored). Both files use JSON. Missing files SHALL be treated as tier 0 (disabled).

#### Scenario: No config present

- **WHEN** ccxray starts in a directory with neither `.ccxray.json` nor `.ccxray.user.json`
- **THEN** OTel SDK SHALL NOT initialize and no network egress SHALL occur

#### Scenario: Project config present, no personal config

- **WHEN** ccxray starts in a directory with `.ccxray.json` that enables tier 1
- **THEN** OTel SDK SHALL initialize at tier 1 with project-level attributes only

#### Scenario: Both project and personal config present

- **WHEN** project config sets tier 1 and personal config sets tier 2 with `enduser.id`
- **THEN** the effective tier SHALL be tier 2 and `enduser.id` SHALL be attached to emitted metrics

### Requirement: Tier resolution as upper bound and lower bound

The effective tier SHALL be `min(project_tier, personal_tier)` so that the project config is an upper bound and personal config can only equal-or-downgrade. An engineer SHALL be able to unilaterally opt out by setting tier 0 in personal config.

#### Scenario: Personal config downgrades from project

- **WHEN** project config enables tier 1 and personal config explicitly sets tier 0
- **THEN** no OTel emission SHALL occur for this engineer

#### Scenario: Personal config cannot exceed project

- **WHEN** project config enables tier 1 and personal config sets tier 2
- **THEN** the effective tier SHALL be tier 2 only if the project explicitly authorizes tier 2; otherwise tier resolution SHALL clamp to tier 1 and emit a warning

### Requirement: Environment variable interpolation

All string values in config files SHALL support `${VAR}` interpolation, resolved at load time from `process.env`. Unresolved variables SHALL cause startup failure with a clear error message naming the missing variable.

#### Scenario: Header value uses env var

- **WHEN** config contains `"Authorization": "Bearer ${OTLP_TOKEN}"` and `OTLP_TOKEN=abc123` is set in the environment
- **THEN** the loaded header value SHALL be `"Bearer abc123"` and the literal string SHALL NOT appear in any debug log line

#### Scenario: Missing env var

- **WHEN** config contains `"Authorization": "Bearer ${MISSING_VAR}"` and `MISSING_VAR` is not set
- **THEN** ccxray SHALL exit non-zero with an error message that includes the file path, line, and the variable name `MISSING_VAR`

### Requirement: Literal-secret rejection

The schema validator SHALL reject any string value that matches a literal-secret pattern (`Bearer [A-Za-z0-9]{20,}`, `sk_live_*`, `sk_test_*`, `ghp_*`, JWT three-segment structure) unless the value is wrapped in `${...}`. Pure URLs and hostnames SHALL be allowed.

#### Scenario: Literal bearer token rejected

- **WHEN** config contains `"Authorization": "Bearer abc123longtokenvalue..."`
- **THEN** ccxray SHALL exit at startup with an error suggesting the user switch to `${ENV_VAR}` interpolation

#### Scenario: Interpolated bearer token accepted

- **WHEN** config contains `"Authorization": "Bearer ${TOKEN}"` and `TOKEN` is set
- **THEN** ccxray SHALL load successfully and use the resolved value

### Requirement: Gitignore auto-amend on first generation

When ccxray writes a new `.ccxray.user.json` for the first time, it SHALL check whether the file is covered by the project's `.gitignore`. If not, ccxray SHALL prompt the user (or apply automatically when `--yes` is passed) to append `.ccxray.user.json` to `.gitignore`.

#### Scenario: Gitignore missing entry

- **WHEN** ccxray creates `.ccxray.user.json` in a repo whose `.gitignore` does not list it
- **THEN** ccxray SHALL prompt for permission to append `.ccxray.user.json` and reflect the choice in the next run

#### Scenario: Gitignore already covers the file

- **WHEN** ccxray creates `.ccxray.user.json` and `.gitignore` already contains an entry matching the file
- **THEN** no prompt SHALL appear and the file SHALL be written silently

### Requirement: Config error fails fast at startup

Config syntax errors, schema violations, unresolved `${VAR}` references, and literal-secret matches SHALL cause ccxray to exit non-zero at startup with an actionable error message. ccxray SHALL NOT silently continue with a partial config.

#### Scenario: Invalid JSON

- **WHEN** `.ccxray.json` contains malformed JSON
- **THEN** ccxray SHALL print a parse error citing the file path and the offending line/column, and SHALL exit non-zero

#### Scenario: Schema violation

- **WHEN** `.ccxray.json` sets `otel.tier` to an unknown value
- **THEN** ccxray SHALL print a schema error naming the field and listing valid values, and SHALL exit non-zero
