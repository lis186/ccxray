# Spec: UX Card Polish

## ADDED Requirements

### Requirement: Session card SHALL surface a copyable continue command via an icon button

The session card MUST render an icon button (`.launch-btn`) on the first row next to the short session id. Clicking the button MUST write `claude --continue {shortSid}` to the system clipboard and provide brief visual feedback (the shipped UI flashes the button briefly before reverting). The button MUST carry a `title=` attribute reading `Copy: claude --continue {shortSid}` so the action is discoverable on hover. The button glyph is the rocket-ship character (`&#10697;` / U+2629) — a compact icon-only affordance, not a text chip.

> **Drift from earlier draft:** Earlier drafts specified a wide text chip `▶ continue: {shortSid}` with inline label flip (`✓ copied!`). The shipped UI uses a circular icon button instead because the session card horizontal real estate is contested by the title row, the pin button, the held badge, and the intercept-arm dot. The full continue command is discoverable via tooltip rather than primary text.

#### Scenario: Click to copy

- **WHEN** the user clicks the rocket icon button
- **THEN** `claude --continue 8adc7cfc` is written to the clipboard
- **AND** the button provides brief visual feedback before reverting

#### Scenario: Tooltip discoverability

- **WHEN** the user hovers the icon button
- **THEN** the tooltip reads `Copy: claude --continue 8adc7cfc`

#### Scenario: Session with title

- **WHEN** `sess.title` is set (via the session-title-display change)
- **THEN** the title renders on its own row above the row that contains the short sid + icon button

#### Scenario: Session without title

- **WHEN** `sess.title` is absent
- **THEN** the short sid appears as the primary label on the first row alongside the icon button

---

### Requirement: Cache TTL row SHALL use unambiguous language and colour-coded urgency

The cache TTL display MUST render as a single `.si-cache` element with text `cache {N}m left` (for `s >= 60`) or `cache {N}s left` (for `s < 60`) or `cache expired` (when remaining ≤ 0). The colour is conveyed by a CSS class on the same element, not by a separate leading dot:

- `.cache-far` (green) when `remaining / cacheTtlMs > 0.6`
- `.cache-near` (yellow) when `remaining / cacheTtlMs > 0.3` and ≤ 0.6
- `.cache-close` (red, with pulse animation) when remaining ≤ 30 % of TTL
- `.cache-expired` (terminal state) when remaining ≤ 0 — the ticker stops touching the element

A single app-level `setInterval(1000)` (`startCountdownTicker` in `public/countdown-ticker.js`) walks every `.si-cache[data-active="1"]` element each tick and rewrites `textContent` / `className` only when the desired value changes (DOM-write throttling). The plan TTL is read from `window.ccxraySettings` populated from `/_api/settings`.

> **Drift from earlier draft:** Earlier drafts specified `cache · {N}m left` with a separate leading coloured `●`, and absolute thresholds (60 s / 300 s) for tier switching. The shipped UI uses pct-based thresholds (`> 0.6`, `> 0.3`) so the same logic works for both 5-min Pro and 1-hr Max plans without per-plan branching, and folds the colour into the element itself so the ticker can update className in one DOM write per element.

#### Scenario: Cache with 57 min left on Max plan

- **WHEN** `cacheTtlMs` = 3600000 and remaining = 57 m (95 %)
- **THEN** the element renders text `cache 57m left` with class `si-cache cache-far` (green)

#### Scenario: Cache below 30 % of TTL

- **WHEN** remaining is 10 m on a 60 m TTL (17 %)
- **THEN** the element renders text `cache 10m left` with class `si-cache cache-close` (red, pulsing)

#### Scenario: Cache below 60 seconds

- **WHEN** remaining is 42 s
- **THEN** the element renders text `cache 42s left` with class `si-cache cache-close`

#### Scenario: Cache expired

- **WHEN** remaining ≤ 0
- **THEN** the element renders text `cache expired` with class `si-cache cache-expired`
- **AND** `data-active` is set to `"0"` so the ticker stops touching the element

#### Scenario: No cache row

- **WHEN** the session has no cache data (non-Claude-Code traffic) or plan is `api-key`
- **THEN** the cache row is absent

---

### Requirement: Tool-stats row SHALL be replaced by a last-assistant-message preview

The second row of a session card MUST display the first 60 characters of the most-recent assistant message text for that session, followed by `…` if truncated. If no assistant message exists for the session yet, the row MUST be omitted entirely (not shown as empty). The preview text MUST be rendered in `var(--dim)` colour and `font-size: 11px`. HTML entities from the original message MUST be stripped before truncation; no markdown formatting is applied.

#### Scenario: Session with assistant messages

- **WHEN** the last assistant message begins with `"全部 312 個測試通過，沒有失敗。實作已完成…"`
- **THEN** the row shows `全部 312 個測試通過，沒有失敗。實作已完成，所…` (60 chars + `…`)

#### Scenario: No assistant messages yet

- **WHEN** a session only has one turn and it has not received a response
- **THEN** the tool-stats / preview row is absent

---

### Requirement: Project dots SHALL carry a tooltip describing their status

Every project status dot MUST have a `title` attribute. The value MUST be:

- `"streaming"` when `statusClass === 'sdot-stream'`
- `"idle · {N}m ago"` when `statusClass === 'sdot-idle'`, where N = `Math.round((Date.now() - proj.lastSeenAt) / 60000)` clamped to a minimum of 1
- `"offline"` when `statusClass === 'sdot-off'`

`proj.lastSeenAt` is derived from the most recent `lastSeenAt` across all sessions in the project.

#### Scenario: Active project

- **WHEN** a project has one streaming session
- **THEN** hovering the green dot shows `"streaming"`

#### Scenario: Idle project

- **WHEN** the project's last session was seen 3 m ago
- **THEN** hovering the yellow dot shows `"idle · 3m ago"`

---

### Requirement: All cost values SHALL render with exactly two decimal places

Every `$`-prefixed cost display in project cards, session cards, and turn cards MUST use `.toFixed(2)`. This applies to: `proj.totalCost`, `sess.cost` (session total), `e.cost` (per-turn), and the topbar ROI display. Hover tooltips MAY show higher precision if desired but MUST NOT be required for the base display.

#### Scenario: Three-decimal cost

- **WHEN** `proj.totalCost` is `297.067`
- **THEN** the card shows `$297.07`

---

### Requirement: Turn card time row SHALL present `dur` as primary and `wait`/`think` as secondary

The time row MUST render as: `dur:{N}s` in normal text colour, followed by `(wait:{N}s · think:{N}s)` in `var(--dim)` and `font-size: 10px` on the same line. `think` is omitted if `thinkingDuration` is absent or zero. `wait` is omitted if `waitTime` is absent or zero. If all three values are absent the row is omitted.

#### Scenario: All three present

- **WHEN** dur=9s, wait=4s, think=1.9s
- **THEN** row renders: `dur:9s (wait:4s · think:1.9s)` with `(wait:4s · think:1.9s)` dimmed

#### Scenario: No thinking

- **WHEN** dur=5s, wait=2s, thinkingDuration absent
- **THEN** row renders: `dur:5s (wait:2s)`

---

### Requirement: Turn card cache hit label SHALL read `cache` not `hit`

The label prefix in the turn card stats line MUST be `cache:{N}%` not `hit:{N}%`. The value, colour, and position are unchanged.

#### Scenario: Rename

- **WHEN** cache hit rate is 100 %
- **THEN** turn card shows `cache:100%`
