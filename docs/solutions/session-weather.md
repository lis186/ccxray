# Session Weather Score — Design

> Diagnostic output for #315. Design settled in owner conversation 2026-07-20.

## Problem

ccxray already computes per-turn quality signals (context pressure, compaction,
truncation, stuck detection) but they exist only as visual cues scattered across
the dashboard. No single scalar answers "is this session healthy?" — and no
programmatic interface lets an agent (Claude Code / Codex) self-diagnose.

Jenkins solved the equivalent problem for CI with a 5-level weather icon
(sunny → stormy) aggregated from recent build results. Same metaphor applies
to LLM sessions.

## Signals (all wire-level, language-agnostic)

Existing per-turn fields consumed (no new server computation):

| Field | Source | Already on SSE entry |
|-------|--------|---------------------|
| `ctxPct` | `computeCtxUsed(usage) / maxContext * 100` | yes (via `wfCtxPct`) |
| `isCompacted` | server-side detection | yes |
| `stopReason` | API response | yes |
| `usage.output_tokens` | API response | yes |
| `toolFail` | server-side detection | yes |

`ctxZone(pct)` in `format.js` (safe <40% / warn 40-80% / danger >80%)
already exists — weather consumes ctxPct directly, does not replace ctxZone.

## Weather scale

| Level | Icon | Key | Meaning |
|-------|------|-----|---------|
| 0 | ☀️ | `clear` | healthy |
| 1 | 🌤️ | `fair` | context entering warn zone |
| 2 | ⛅ | `cloudy` | context danger zone, or compaction happened |
| 3 | 🌧️ | `rainy` | stuck detected, or multiple compactions |
| 4 | ⛈️ | `stormy` | critically degraded |

## Algorithm

Single priority-ordered degradation pass. Context zone sets the base; events
push upward; the highest level wins.

```js
function assessWeather(turns) {
  let level = 0;
  const factors = [];

  // 1. context zone (base) — last turn's ctxPct
  const last = turns[turns.length - 1];
  const ctxPct = last
    ? Math.min(100, computeCtxUsed(last.usage) / (last.maxContext || 200000) * 100)
    : 0;
  if (ctxPct > 80)       { level = Math.max(level, 2); factors.push('ctx_danger'); }
  else if (ctxPct >= 40)  { level = Math.max(level, 1); factors.push('ctx_warn'); }

  // 2. compaction scar (permanent, cumulative)
  const compactions = turns.filter(t => t.isCompacted).length;
  if (compactions >= 2)      { level = Math.max(level, 3); factors.push('compaction_multi'); }
  else if (compactions >= 1) { level = Math.max(level, 2); factors.push('compaction'); }

  // 3. truncation: stopReason=max_tokens AND output_tokens≥16000
  const truncations = turns.filter(
    t => t.stopReason === 'max_tokens' && (t.usage?.output_tokens ?? 0) >= 16000
  ).length;
  if (truncations > 0) { level = Math.min(level + 1, 4); factors.push('truncation'); }

  // 4. stuck detector: ≥10 consecutive tool_use with >25% error rate
  let streak = 0, errors = 0, maxStuck = 0;
  for (const t of turns) {
    if (t.stopReason === 'tool_use') {
      streak++;
      if (t.toolFail) errors++;
      if (streak >= 10 && errors / streak > 0.25) maxStuck = Math.max(maxStuck, streak);
    } else { streak = 0; errors = 0; }
  }
  if (maxStuck >= 10) { level = Math.max(level, 3); factors.push('stuck'); }

  // 5. elevated tool error rate (non-stuck, threshold 15%)
  const toolTurns = turns.filter(t => t.stopReason === 'tool_use');
  if (toolTurns.length >= 5) {
    const rate = toolTurns.filter(t => t.toolFail).length / toolTurns.length;
    if (rate > 0.15 && maxStuck < 10) {
      level = Math.min(level + 1, 4);
      factors.push('tool_error_elevated');
    }
  }

  const ICONS = ['☀️', '🌤️', '⛅', '🌧️', '⛈️'];
  const KEYS  = ['clear', 'fair', 'cloudy', 'rainy', 'stormy'];
  const i = Math.min(level, 4);
  return { weather: ICONS[i], level: KEYS[i], factors };
}
```

### Threshold rationale

| Threshold | Source |
|-----------|--------|
| 40% / 80% context zones | existing `ctxZone()`, aligns with practitioner consensus (Anthropic team recommends compacting at 50-60%; Hermes dual-layer 50%+85%) |
| 16000 output_tokens for truncation | #306 definition — filters low-risk subagent kicks |
| 10-turn streak + 25% error | #306 stuck detector definition |
| 15% tool error rate | owner decision 2026-07-20 (below stuck threshold, above noise floor) |

## Scoping rules

Weather is scope-dependent — same function, different `turns` input:

| Consumer | turns = |
|----------|---------|
| Session card | all turns in session |
| Agent card (swimlane lane title) | turns in that lane |
| Turn card | turns[0..N] (prefix to selected turn) |
| API / CLI / skill | parameterized (see below) |

### Design decision: compaction scar is permanent

A compaction event means context filled to the point the system had to
intervene. This structurally changes what the agent can recall — the session
never fully recovers. Weather cap: 1 compaction → max ⛅; 2+ → max 🌧️.

## Architecture

### One file: `public/weather.js`

Pure function, zero dependencies on other ccxray modules. Reads only plain
object fields present on every SSE entry. Isomorphic (browser script tag +
Node require).

### Two interfaces (design decision: separate)

**Dashboard** (descriptive): weather emoji on session card, agent card, turn
card. Prefix weather for turns is precomputed as `turnWeathers[]` on session
load (one sequential scan), not recomputed per hover.

**Agent API** (prescriptive):

```
GET /api/sessions/:id/weather                  → whole session
GET /api/sessions/:id/weather?agent=<laneKey>  → specific lane
GET /api/sessions/:id/weather?until=<turnId>   → prefix
```

Response:
```json
{
  "weather": "⛅",
  "level": "cloudy",
  "factors": ["compaction", "ctx_warn"],
  "turnCount": 47,
  "ctxPct": 62.3
}
```

CLI: `ccxray health [session-id] [--json]`
Skill: `/session-health` — adds prescriptive `recommendation` field.

## Deferred

- **Security signals** — needs request body inspection, different magnitude
- **Customizable thresholds** — YAGNI until proven otherwise
- **Weather trend / sparkline** — after core lands
