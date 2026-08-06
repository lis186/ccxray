# Session Weather

Session weather is a health indicator shown on each session card. It
condenses eight independent signals into a single score, displayed as an
emoji (sunny through stormy) with a hover tooltip that lists the active
factors.

Source of truth: [`public/weather.js`](../public/weather.js).

## Signals

| Signal | What it watches | Severity curve | Cap | Min turns |
|--------|----------------|----------------|-----|-----------|
| `ctx_pressure` | Last turn's context fill % | 40% &rarr; 0, 100% &rarr; 1.0 (linear) | 1.0 | 1 |
| `compaction_scar` | Number of compacted turns | 1 = 0.4, 2+ = 0.6 | 0.6 | 1 |
| `truncation` | Any turn hit `max_tokens` (&ge;16K output) | Fixed 0.5 | 0.5 | 1 |
| `stuck` | Longest consecutive tool-failure streak | &ge;10 = 0.9, else 0 | 0.9 | 1 |
| `latency_drift` | p75 of last 10 turns vs model baseline | 1x &rarr; 0, 3x &rarr; 1.0 | 1.0 | 5 |
| `error_cluster` | 5-turn sliding window tool error rate | rate / 2.0 | 0.5 | 5 |
| `error_cumulative` | Session-wide tool error ratio | 20% &rarr; 0.5, 40% &rarr; 1.0 | 1.0 | 10 tool turns |
| `cache_health` | Median cache hit rate (last 10 turns, skip first 3) | 50% &rarr; 0, 0% &rarr; 0.5 | 0.5 | 3 qualifying |

### Signal tiers

Severity caps encode relative importance:

- **Functional** (cap 0.9&ndash;1.0): `ctx_pressure`, `stuck`, `error_cumulative`, `latency_drift` &mdash; directly affect whether the agent can complete its work.
- **Quality** (cap 0.5&ndash;0.6): `compaction_scar`, `truncation`, `error_cluster` &mdash; the agent runs but information or quality is degraded.
- **Cost/efficiency** (cap 0.5): `cache_health` &mdash; functionality unaffected; the session costs more and runs slower.

### Provider scope

`cache_health` only applies to Anthropic entries (`provider === 'anthropic'`
or absent). OpenAI/Codex and xAI/Grok entries are skipped because their
wire parsers normalize cache fields differently.

## Score composition

```
score = max(severities) + 0.3 * second(severities)
```

Only the two highest severities contribute. This prevents multiple
low-severity signals from stacking into a false alarm.

## Levels

| Score range | Level | Emoji | Meaning |
|-------------|-------|-------|---------|
| < 0.35 | sunny | &#9728;&#65039; | Operating normally |
| < 0.55 | fair | &#127780;&#65039; | Minor signals, no action needed |
| < 0.75 | cloudy | &#9925; | Quality starting to degrade |
| < 0.95 | rainy | &#127783;&#65039; | Significantly degraded, take action |
| &ge; 0.95 | stormy | &#9928;&#65039; | Critically degraded, act now |

## Tooltip

The hover overlay shows different content depending on the level:

- **Sunny / Fair**: stats proving health &mdash; context %, error count,
  cache hit rate, latency ratio, compaction count.
- **Cloudy / Rainy / Stormy**: active factors sorted by severity, plus an
  action line linking to the relevant turns (when available).

## Cold-start immunity

Each signal has a minimum-turns requirement to avoid firing on incomplete
data. `cache_health` additionally skips the first three turns of the
window (prompt cache cold start) and ignores turns with fewer than 1,000
input tokens.
