# Design: Session UX — Follow-Live-Turn + Session Card + Overview Panel

- Status: Draft (pending sign-off)
- Date: 2026-07-10
- Expert panel: Endsley (SA), Wickens (MRT), Czerwinski (Interruption), Tufte (Information Design)
- Autoresearch: 3 sub-problems, all ≥9/10

## Problem 1: Follow-live-turn jumps on subagent activity

When `followLiveTurn` is ON and a session has heavy subagent activity
(e.g., 473 Agent tool calls), every subagent turn auto-selects in the
Turns column, causing the detail panel to jump between main and subagent
content every few seconds. This destroys comprehension of the main
orchestrator's reasoning.

## Problem 2: Session card information gaps

The session card lacks duration, context window size, and temporal
anchors needed for the three user goals: cost control, better results,
less human intervention. The card serves Find/Triage/Compare jobs and
must be scannable in <0.5s.

## Problem 3: Overview panel depth metrics

When drilling into a session, deeper metrics (cost breakdown, token
analysis, autonomy indicators, tool failure rate) are needed for the
Investigate job but have no home in the current UI.

## Design

### Core rule: Follow main only

`followLiveTurn` auto-selects only `!isSubagent && !isRetry` turns.
Subagent turns append to the Turns list silently (visible as cards) but
do NOT call `selectTurn`.

### Subagent pill notification

When subagent turns arrive while the user is on the main live edge, a
pill appears at the bottom of the Turns column (same position as the
existing `showNewTurnPill`).

#### Pill text format (SP1 — 9.0/10)

| State              | Text                  | Color                                      |
|--------------------|-----------------------|--------------------------------------------|
| Normal (no errors) | `+3 sub`              | all `var(--dim)`                            |
| With errors        | `+5 sub · 1 err`      | all `var(--red)` (see SP3)                  |
| High count         | `+47 sub`             | all `var(--dim)`                            |
| High count + errors| `+47 sub · 2 err`     | all `var(--red)`                            |
| No errors          | no `· N err` suffix   | absence = normalcy                          |

- `sub` not `subagent` — 3 chars, peripheral/preattentive context
- `err` not `e` — 5-char red target for peripheral detection
- No count cap — the number itself carries magnitude information
- Tooltip: `"N subagent turns (M errors) since main #X"` — L2 bridge

**Symmetry**: When user manually clicks a subagent turn (off main live
edge), the existing `showNewTurnPill` shows `+N main` for subsequent
main turns.

#### Pill click behavior (SP2 — 9.0/10)

**Peek, not select.** Clicking the pill:
1. Scrolls the Turns column to reveal subagent turn cards
2. Resets pill count to 0, hides pill
3. Does NOT change `selectedTurnIdx` or detail panel content

The user can then optionally click a specific subagent turn card to
inspect it — that's a deliberate context switch.

**Scenarios:**

1. *User on main #121, clicks `+5 sub` pill* → Turns scrolls to show
   subagent cards. Detail stays on main #121. Pill disappears.

2. *After peek, main #122 arrives* → Auto-follows #122 normally (user
   was still on main live edge since `selectedTurnIdx === latestMainTurnIdx`).

3. *User clicks subagent card s47, then main #122 arrives* → User is
   off main live edge. Existing pill shows `+1`. User clicks pill to
   return to #122.

4. *User peeks, doesn't care* → Nothing to undo. Detail panel never
   changed.

**Implementation notes:**
- Track `latestMainTurnIdx` separately (init to `null`)
- Live-edge check: `latestMainTurnIdx !== null && selectedTurnIdx === latestMainTurnIdx`
- Pill only appears when `followLiveTurn === true`
- Retries excluded from auto-follow: `!isSubagent && !isRetry`

#### Error visual (SP3 — 9.2/10)

| State         | Color                      | Background | Animation |
|---------------|----------------------------|------------|-----------|
| Normal pill   | `var(--dim)` all           | none       | none      |
| Error pill    | `var(--red)` **all** text   | none       | none      |
| Error cleared | back to `var(--dim)`       | none       | none      |
| Dismissed     | removed                    | —          | —         |

- On error: **entire pill** turns red (not just the error token)
- ~15 chars of red monospace ≈ ~20mm — reliable peripheral detection
- No animation (HELD badge retains animation monopoly)
- No background (text-only, matches cache row pattern)
- Color onset (dim → red in one repaint) is the preattentive signal
- CSS: `.sub-pill.has-errors { color: var(--red); }`

### Salience hierarchy

| Level | Element    | Treatment                                | When      |
|-------|------------|------------------------------------------|-----------|
| 1     | HELD badge | Red bg + white text + pulse + container  | Intercept |
| 2     | Error pill | Red text, no bg, no animation            | Sub error |
| 3     | Normal pill| Dim grey text                            | Sub turns |

---

## Design: Session Card (L1)

### Information hierarchy

```
Tier 1 — Must have          Tier 2 — High value         Tier 3 — Useful
① Status dot                ⑤ Model                     ⑨ Duration
② Title                     ⑥ Relative time             ⑩ Preview text
③ Cost                      ⑦ Turn count
④ Context % + window size   ⑧ Cache TTL
```

### Card layout

```
● 95f7a15a  ⤻                                    ☆
查詢需記錄為 ADR 的項目
opus-4-6 · 396t · 9.5h
$25.92
████████░░░░░░░░░░░░░░░░░░░ 24% of 1M
Local main synced — `df5b925...
25m ago                              cache 34m left
```

Changes from current:
- **Model line**: add duration — `opus-4-6 · 396t · 9.5h`
- **Context bar**: add window size — `24% of 1M`
- Duration format: `<1h` → minutes (`8m`), `≥1h` → hours (`9.5h`), `≥24h` → days (`2.3d`)
- All other elements unchanged

### Tooltip (L2 — desktop shortcut, iPad skips to L3)

```
Started Jul 10 04:30
Last activity 25m ago
3 cache breaks
```

Tooltip is a convenience for desktop hover. No information is exclusive
to tooltip — everything appears in fuller form in the Overview panel.
iPad users tap the card to go directly to L3.

```
Desktop:  L1 Card → L2 Tooltip (hover) → L3 Overview (click)
iPad:     L1 Card → L3 Overview (tap)
```

---

## Design: Overview Panel (L3)

**Placement correction (post-implementation)**: the "session selected, no
turn drilled into" state described below does not exist in the current UI
— selecting a session always auto-selects a turn and a lane. The closest
existing panel is `wfRenderAgentCard(lane)` in `workflow-timeline.js`, but
it's per-lane (one agent thread), not session-wide — a lane has no view of
"the other lanes," so a Main/Subagent cost split can't be lane-local data.

Decided placement: extend `wfRenderAgentCard` so the session-wide rollup
sections below appear only when the selected lane is the true main lane
(`_wfIsMainLane(lane)` — do **not** use `!lane.spawnParent`; that's also
null for non-main lanes such as Task-tool subagents whose requests carry
the parent's session_id, which `isAnthropicSubagent()` in `store.js`
doesn't detect as a subagent — this caused an earlier version of the
Main/Subagent cost split below to misattribute subagent cost as "main" in
verification testing). Subagent lanes keep showing exactly what they showed
before this change.

**Dropped from this pass — Main/Subagent cost split**: because
`isAnthropicSubagent()` classifies by `!cwd && !session_id`, and current
Claude Code subagent requests carry the parent's `session_id`, subagent
turns that share the session_id are misclassified as main turns
server-side. A cost split built on that signal would silently show
subagent activity as 100% main cost for exactly this common case, so it
was cut from the shipped Cost section (Total only, unchanged from before
this design). Re-add once subagent detection is fixed — either the
server-side `isAnthropicSubagent()` heuristic, or reuse the client-side
lane-inference signal the workflow timeline already uses to split lanes
correctly (it isn't fooled by the shared session_id, per the verification
screenshots that caught this). Tracked as a separate follow-up, not blocking
this PR.

### New/enhanced sections

```
CONTEXT
  Peak              24.0%
  Window            1000K
  Compacts          3                  ← NEW: autocompact count

CACHE
  Hit rate          98.4%
  Breaks            3                  ← NEW: cache invalidation boundaries

COST
  Total             $25.92                (lane-scoped, pre-existing row)
  # Main/Subagent split dropped — see "Dropped from this pass" above

TOKENS                                 ← NEW section
  Input             2.4M
  Output            186K
  I/O ratio         12.9:1

AUTONOMY                               ← NEW section
  Turns/intervene   38
  Retries           12

TOOLS
  Bash              6758
  Agent             473
  Read              396
  Failure rate      2.3%               ← NEW: tool failure rate

TIME                                   ← NEW section
  Started           Jul 10 04:30
  Duration          9.5h
  Active            ~2.3h
```

### Overview swimlane strip — lane-focus mode (added post-review)

`ux-heuristic-analysis` on a real 5-subagent session found a MAJOR issue:
`#wf-lanes-section` hard-clips lanes off the bottom with a fixed max-height
and no scroll affordance (no visible scrollbar, no lane count, no fade
cue) — directly undermining this design's own motivating scenario (a
session with 473 Agent tool calls). This is pre-existing behavior from the
earlier swimlane feature (#91), not something Problems 1-3 introduced, but
it makes the new Agent Card metrics hard to reach in exactly the sessions
where they're most useful.

Fix: a collapse toggle button in `#wf-overview-label` (`wfToggleLaneFocus()`)
that narrows the sub-lane area to just the selected lane — main stays
visible (pinned, cheap) so orchestrator context is never lost; if main
itself is selected, the sub-lane area shows nothing. Two ▲/▼ buttons appear
next to the toggle when active, showing a "N/total" position and cycling
`wfState.selectedLane` — reusing the same stepping logic as the existing
Tab/Shift+Tab lane-cycle shortcut (`wfCycleLane(dir)`, extracted so both
call sites share one implementation). No build step, no new dependency —
pure CSS/JS reusing the existing `#wf-overview-label button` style.

### Data availability

| Metric | Source | Status |
|--------|--------|--------|
| Duration | `lastId - firstId` timestamp diff | ✅ Client can compute |
| Window size | `e.maxContext` from entry | ✅ Already in entries |
| Compacts | Count context % resets (sawtooth drops) | ⚠️ Need to track |
| Cache breaks | Count gaps > cache TTL between turns | ⚠️ Need to track |
| Cost main/sub split | Sum `turnCost` by `isSubagent` flag | ⚠️ Need to accumulate |
| Token I/O | Sum `input_tokens` / `output_tokens` | ⚠️ Need to accumulate |
| I/O ratio | Computed from above | ✅ Derived |
| Turns/intervene | Detect user turns vs auto-approved | ⚠️ Complex — may defer |
| Tool failure rate | Count error tool results / total | ⚠️ Need to track |
| Active time | Duration minus gaps > cache TTL | ⚠️ Derived from breaks |

---

## What this does NOT change

- Session card ordering in the Sessions column (separate issue)
- Existing `followLiveTurn` ON/OFF toggle behavior
- Turn card rendering for subagent turns (they still appear in the list)
- The existing `showNewTurnPill` mechanism (reused for `+N main`)

## Code locations

### Follow-live-turn pill

| File | Change |
|------|--------|
| `public/entry-rendering.js:565-577` | Add `!isSubagent && !isRetry` guard to `wasOnLiveEdge` auto-follow |
| `public/entry-rendering.js` | Track `latestMainTurnIdx`, increment `subPillCount` for subagent turns |
| `public/miller-columns.js` | Add `showSubagentPill(count, errCount)` — reuses pill DOM pattern |
| `public/style.css` | `.sub-pill` + `.sub-pill.has-errors` styles |

### Session card

| File | Change |
|------|--------|
| `public/miller-columns.js` `renderSessionItem()` | Add duration to model line, window size to ctx bar |
| `public/miller-columns.js` `renderSessionItem()` | Add tooltip with start time + cache breaks |

### Overview panel

| File | Change |
|------|--------|
| `public/entry-rendering.js` | Accumulate new session fields: `mainCost`, `subCost`, `inputTokens`, `outputTokens`, `compactCount`, `cacheBreaks` |
| `public/miller-columns.js` | Render new sections in overview detail panel |
