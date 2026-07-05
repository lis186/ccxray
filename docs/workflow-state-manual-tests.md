# Workflow-view state-management — manual test checklist

Covers the fixes from the 2026-07-05 state audit: #136, #137, #139, #140, #138 (A/C/B).
All checks are browser-side; the most reliable verification is reading `wfState` in
DevTools Console, paired with the matching UI gesture.

## Setup

1. Terminal: `ccxray claude`
2. Give it a subagent task, e.g. "use the Explore subagent to count .js files under
   server/" — run it twice so you get `main` + two agent lanes (multi-lane, multi-turn).
3. Browser → dashboard → click the project → click the session. The swimlane timeline
   (OVERVIEW minimap + lanes) renders in the turns column.
4. F12 → Console.

Section nav lives in the agent-card panel:
`Timeline / System / Core / MCP / Skills / Cost Efficiency / Request / Events`.

---

## T1 — #136 section highlight == rendered detail

**Story:** switching section keeps the nav highlight and the detail pane in agreement —
never "nav says System, detail shows Timeline".

UI:
1. Click a lane chart's empty area (lane selected, no turn locked).
2. Click a non-Timeline nav item (e.g. System).
3. Click a turn bar.
   - PASS: nav highlight == detail content.
   - OLD BUG: nav highlights System, detail renders Timeline.

Console:
```js
wfState.selectedTurnId = null; wfState.selectedLane = wfState.lanes[0];
wfSelectSection('system');
selectedSection === wfState.selectedSection   // → true
```

## T2 — #139 similar lane names don't co-select

**Story:** clicking one lane expands/highlights exactly that lane, even when two lanes
share a near-identical display name (same model + same first-8 hex of sessionId).

UI:
1. Have ≥2 agent lanes.
2. Click each lane's label area in turn.
   - PASS: exactly one lane expands; minimap frames one row.
   - OLD BUG (on name collision): two lanes expand together; clicks hit the wrong lane.

Console:
```js
const keys = wfState.lanes.map(l => l.key);
new Set(keys).size === keys.length   // → true (every lane key unique)
```

## T3 — #140 expanded lane == locked-turn lane (A==B)

**Story:** locking a turn from anywhere (bar, Cost Efficiency row, step row) expands the
turn's own lane and syncs the detail pane.

UI — entry A (Cost Efficiency):
1. Select a lane → nav "Cost Efficiency" → turn table appears.
2. Click any row.
   - PASS: that turn's lane expands + detail syncs to the turn.
   - OLD BUG: turn set but not lane → detail doesn't sync / wrong lane expands.

UI — entry B (step list): click a step row → swimlane dim/expand refreshes immediately.

Console:
```js
wfLockTurn(wfState.lanes[1].turns[0].id);
const h = wfState.turnIndex.get(wfState.selectedTurnId);
wfState.selectedLane.key === wfState.lanes[h.laneIdx].key   // → true
```

Also verify the wiring changed (the onclick now calls the helper):
```js
// cost-efficiency row onclick should contain "wfLockTurn(", not "selectedTurnId="
```

## T4 — #138A wfIsZoomed helper (pure refactor, no visible change)

**Story:** the "is zoomed?" test has one source of truth; behavior identical.

UI: zoom in → `⟲` reset badge appears; zoom back to full → badge disappears.
Console: `typeof wfIsZoomed === 'function'  // → true`

## T5 — #138C tiny brush doesn't over-zoom

**Story:** a very small brush on the overview is treated as a click, not a sub-2s zoom.

UI: brush a <2s-wide box on the overview → treated as click (hit-test nearest turn),
no ultra-narrow zoom. OLD BUG: a 1001–1999 ms brush zoomed below the 2000 ms floor.

## T6 — #138B live-follow slides like tail -f (behavior change)

**Story:** while a session runs and you haven't zoomed, new turns keep the newest bars
at a readable width; the window slides (older turns scroll off left). `⟲` shows full view.

UI (live): keep a long live session's swimlane open, don't touch zoom.
- PASS: newest bars keep constant width, window slides right, `⟲` restores full view.
- OLD BUG: window only grows right, every bar compresses toward the 2px floor.
Reverse: scroll/zoom back to an early segment → new turns must NOT yank you to the tail.

Console (no live needed):
```js
const span0 = wfState.viewT1 - wfState.viewT0;
wfState.viewT1 = wfState.tMax; const oldT1 = wfState.tMax;
wfState.tMax += 20000;                 // pretend a later turn arrived
_wfFollowTail(oldT1);
wfState.viewT1 === wfState.tMax &&                                   // followed the tail
Math.round(wfState.viewT1 - wfState.viewT0) === Math.round(span0)    // span unchanged (slid, not grown)
// → true
```
