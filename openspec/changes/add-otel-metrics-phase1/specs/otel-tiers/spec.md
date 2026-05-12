## ADDED Requirements

### Requirement: Three discrete tier values

ccxray SHALL support exactly three tier values for OTel export:

- **0 — disabled**: No SDK initialization, no network egress.
- **1 — project anonymous**: Emit with project-level resource attributes (`project.name`, optional `team`) but no individual identity.
- **2 — personal named**: Emit with `enduser.id` attached (a self-chosen string set by the engineer).

#### Scenario: Tier 0 produces no egress

- **WHEN** the effective tier resolves to 0
- **THEN** no OTel package SHALL be loaded and no network connection SHALL be opened for telemetry

#### Scenario: Tier 1 omits identity

- **WHEN** the effective tier resolves to 1 and a request completes
- **THEN** emitted metrics SHALL include `project.name` (if configured) but SHALL NOT include any `enduser.id` attribute

#### Scenario: Tier 2 includes identity

- **WHEN** the effective tier resolves to 2 and personal config provides `identity: "alice"`
- **THEN** emitted metrics SHALL include `enduser.id="alice"` as a resource attribute

### Requirement: Tier resolution rule

The effective tier SHALL be `min(project_tier, personal_tier)`. If either side is absent, the present side SHALL be used. The minimum SHALL clamp downward; personal config SHALL NOT exceed project config.

#### Scenario: Personal lower than project

- **WHEN** project tier is 1 and personal tier is 0
- **THEN** the effective tier SHALL be 0

#### Scenario: Project lower than personal

- **WHEN** project tier is 1 and personal tier is 2 without project authorization for tier 2
- **THEN** the effective tier SHALL be 1 and ccxray SHALL emit a warning that personal tier is clamped

#### Scenario: Equal tiers

- **WHEN** project tier is 1 and personal tier is 1
- **THEN** the effective tier SHALL be 1

### Requirement: Engineer unilateral opt-out

Any engineer SHALL be able to opt out of OTel emission for their own machine by setting `tier: 0` in `.ccxray.user.json`, regardless of the project config. This opt-out SHALL take effect on the next ccxray launch.

#### Scenario: Opt-out overrides project tier

- **WHEN** project config sets tier 2 and personal config sets tier 0
- **THEN** the engineer's ccxray client SHALL emit no telemetry until personal config is changed

### Requirement: Personal config gitignore enforcement

The personal config file `.ccxray.user.json` SHALL be excluded from version control. ccxray SHALL refuse to load personal-tier identity from a file that is currently tracked by git and SHALL emit a warning explaining the risk.

#### Scenario: Personal config tracked by git

- **WHEN** `.ccxray.user.json` exists in the repo and is tracked by git
- **THEN** ccxray SHALL print a warning recommending `git rm --cached` and SHALL refuse to apply the personal identity until the file is untracked or moved to `$HOME`

### Requirement: Opt-in acknowledgment timestamp

When personal config sets tier 2 for the first time, the file SHALL record an `opt_in_acknowledged_at` ISO 8601 timestamp. This timestamp SHALL be displayed in `ccxray status --otel` so the engineer can confirm when they last opted in.

#### Scenario: First-time tier 2 opt-in

- **WHEN** a user creates `.ccxray.user.json` with tier 2 for the first time
- **THEN** ccxray SHALL write the current time into the file as `opt_in_acknowledged_at` and SHALL include it in subsequent `status --otel` output

### Requirement: Tier distribution sentinel

ccxray SHALL emit `ccxray.otel.tier_distribution{tier}` as a counter incremented once per process launch that initializes OTel, labeled with the effective tier value. This metric is meant to inform documentation strengthening decisions (e.g. low tier 2 share suggests trust concerns).

#### Scenario: Counter increments on launch

- **WHEN** ccxray client process initializes at tier 1
- **THEN** `ccxray.otel.tier_distribution{tier="1"}` SHALL increment by 1
