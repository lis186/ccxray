## Why

Seven small UX gaps in the Project, Session, and Turn cards cause confusion or waste space. Each was evaluated against a weighted 10-point rubric; only solutions scoring ≥ 9 were accepted. They are bundled as one change because they all touch the same rendering surfaces (`miller-columns.js`, `entry-rendering.js`, `style.css`) and ship together with no cross-dependencies.

## What Changes

### 1 — Session hash → Continue UX (9.4)
The 8-char hash (e.g. `8adc7cfc`) is shown so users know they can `claude --continue 8adc7cfc`, but the connection between the raw hash and the continue command is invisible. Replace the bare hash with `▶ continue: 8adc7cfc`; clicking copies the full `claude --continue 8adc7cfc` command to the clipboard. A 1.5 s `✓ copied!` flash confirms the action.

### 2 — Cache TTL label (9.4)
`cache 57m` is ambiguous (started 57 m ago? expires in 57 m?). Replace with `cache · 57m left`. Colour the dot green (> 60 % TTL remaining), yellow (30–60 %), red (< 30 %) so urgency is communicated without hover. Thresholds are computed from the known plan TTL (Max = 1 h, Pro = 5 m).

### 3 — Tool stats → last-assistant-message preview (9.1)
`Bash-8594 Read-2509 Edit-1428` occupies the second row of every session card but conveys no actionable information. Replace with the first ~60 characters of the session's most-recent assistant message text, giving users an immediate "what was this session doing?" signal without opening the session.

### 4 — Project dot tooltips (9.1)
Project status dots (green / yellow / transparent) have no tooltip, so their meaning must be guessed. Session dots already have `title=` attributes for the intercept affordance. Apply the same pattern to project dots: `title="streaming"`, `title="idle · 3m ago"`, `title="offline"`.

### 5 — Amount decimal places (9.3)
`$297.067` and `$2.461` use three decimal places inconsistently. Fix all cost renders to exactly two decimal places (`toFixed(2)`).

### 6 — Turn time dimension layout (9.6)
`wait:4s dur:9s (think:1.9s)` presents three time values at equal visual weight. `dur` is what users care about; `wait` and `think` are secondary. Reorder to `dur:9s` in normal text followed by `(wait:4s · think:1.9s)` in dimmed smaller text on the same line.

### 7 — `hit` → `cache` label (9.0)
`hit:100%` in turn cards is opaque. Rename to `cache:100%` — the prefix immediately identifies what kind of hit rate is being shown.

## Capabilities

### Modified Capabilities

None. All changes are display-only and touch no server code.

## Impact

- **Client only**
  - `public/miller-columns.js`: session card hash display (#1), project dot tooltips (#4), cost formatting (#5)
  - `public/entry-rendering.js`: last-assistant-message extraction (#3), session map shape
  - `public/style.css`: continue-chip styles (#1), cache dot colour rules (#2), dim time styles (#6)
  - `public/messages.js` or `public/miller-columns.js`: turn card time layout (#6), `hit` → `cache` rename (#7)
- **Server**: none
- **Data**: none
- **Out of scope**: model name abbreviation, hover-expand for secondary turn details, amount hover-to-full-precision
