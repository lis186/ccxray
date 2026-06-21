# `ccxray usage` — Output Schema Reference

`ccxray usage` summarizes your logged Claude Code / Codex traffic straight from
`~/.ccxray/logs/index.ndjson` — no running server required. The `--json` output
is an **agent-facing contract**: deterministic, idempotent for a given index,
and small (target `<4KB`).

The single source of truth for the shapes below is
[`server/usage.js`](../server/usage.js) (`analyze()`). This doc mirrors it; if
they ever disagree, the code wins — and that disagreement is a bug to fix here.

> **Contract note.** Because agents consume `--json`, the field set, types, and
> the three top-level shapes (single-scope object, multi-cwd array, error
> object) are treated as a contract. Shape changes must be deliberate and noted
> in the changelog below. The `usage --json shape contract` block in
> [`test/usage.test.js`](../test/usage.test.js) locks every section's exact key
> set and field types (plus the multi-cwd/error shapes and the e2e size budget),
> so an accidental field add/remove fails CI — a deliberate change must update
> both that test and this doc in the same commit.

---

## Output modes at a glance

`--json` emits a **single line** of compact `JSON.stringify` output to stdout.
Which of three shapes you get depends on the arguments:

| Condition | Shape | Exit |
|-----------|-------|------|
| Default (0 or 1 `--cwd`) | [Single-scope object](#1-single-scope-object-default) | 0 |
| `--cwd a,b` (**2+** values) | [Multi-cwd array](#2-multi-cwd-comparison-array) | 0 |
| No index / no matching entries | [Error object](#3-error-object) | 1 |

Rounded numeric fields are rounded to **at most** the number of decimals noted
per field. The value is coerced back to a JSON number (`+x.toFixed(n)`), so
trailing zeros are dropped — you get `0.5`, not `0.50`, and an exact `0` rather
than `0.00`. Treat the per-field precision as a **maximum**, not a fixed width;
the rounding cap is the contract.

---

## 1. Single-scope object (default)

```jsonc
{
  "meta":     { "totalEntries": 0, "totalSessions": 0, "totalCost": 0,
                "timeRange": { "from": "ISO|null", "to": "ISO|null" } },
  "sessions": { "count": 0, "byProvider": { "<provider>": 0 },
                "subagentRatio": 0,
                "turnDistribution": { "min": 0, "median": 0, "p75": 0, "max": 0 },
                "topSessions": [ /* ≤10, see below */ ] },
  "models":   [ /* ≤10, see below */ ],
  "tools":    { "totalCalls": 0, "top": [ /* ≤7 (all with --tools) */ ],
                "failRate": 0 },
  "skills":   [ /* see below; may be [] */ ],
  "prompts":  { "hashStability": { "sysHash": {…}, "toolsHash": {…}, "coreHash": {…} } },
  "cache":    { "hitRate": 0, "totalInputTokens": 0,
                "totalOutputTokens": 0, "totalCacheReadTokens": 0 },
  "gapCache": [ /* only non-empty buckets */ ]
}
```

### `meta`

| Field | Type | Notes |
|-------|------|-------|
| `totalEntries` | number | Count of entries (turns) after all filters. |
| `totalSessions` | number | Distinct `sessionId` count. Entries with no session id collapse into one `"unknown"` bucket, which counts here. |
| `totalCost` | number | Sum of per-turn cost, USD, **2 dp**. |
| `timeRange.from` | string \| null | Earliest `receivedAt` as ISO 8601, or `null` if no timestamps. |
| `timeRange.to` | string \| null | Latest `receivedAt` as ISO 8601, or `null`. |

### `sessions`

| Field | Type | Notes |
|-------|------|-------|
| `count` | number | Same value as `meta.totalSessions`. |
| `byProvider` | object | Map of `provider → turn count` (e.g. `{ "anthropic": 42 }`). Missing provider → `"unknown"`. Counts **turns**, not sessions. |
| `subagentRatio` | number | `subagent turns / totalEntries`, **3 dp**, range 0–1. |
| `turnDistribution` | object | `{ min, median, p75, max }` of turns-per-session. Percentiles take the value at zero-based index `floor(q × count)` (capped at the last element), so e.g. with 2 sessions `median` is the **upper** value, not an average. |
| `topSessions` | array | Up to **10** sessions, sorted by `cost` descending. The synthetic `"unknown"` and `"direct-api"` sessions are excluded here (they remain in `meta`/`sessions.count`). |

Each `topSessions[]` element:

| Field | Type | Notes |
|-------|------|-------|
| `sessionId` | string | Full session id. |
| `turns` | number | Turns in the session. |
| `cost` | number | USD, **2 dp**. |
| `durationMin` | number | First→last `receivedAt` span in minutes, **1 dp**. `0` if fewer than 2 timestamped turns. |
| `title` | string \| null | Best non-continuation title, truncated to 40 chars. `null` if none. |
| `model` | string | The session's **dominant** model (most turns), as a single string — not a map. `"unknown"` if absent. |
| `provider` | string | Provider of the first turn. |

### `models`

Array of up to **10** models, sorted by `turns` descending.

| Field | Type | Notes |
|-------|------|-------|
| `model` | string | Model id. `"unknown"` if absent. |
| `turns` | number | Turns on this model. |
| `cost` | number | USD, **2 dp**. |
| `costShare` | number | `model cost / totalCost`, **3 dp**, range 0–1. |

### `tools`

| Field | Type | Notes |
|-------|------|-------|
| `totalCalls` | number | Total tool invocations across all entries. |
| `top` | array | `[{ name, count }]`, sorted by `count` descending. Capped at **7** by default; `--tools` lifts the cap to all tools. |
| `failRate` | number | `entries with a tool failure / totalEntries`, **3 dp**. Note the denominator is **turns**, not tool calls. |

### `skills`

Array of skills, sorted by `invocations` descending. May be `[]`.

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Skill name (may be namespaced, e.g. `superpowers:brainstorming`). |
| `invocations` | number | Total times invoked. |
| `loads` | number \| null | Distinct sessions that invoked it (a proxy for unique "loads"). `null` only on the synthetic legacy row. |
| `scope` | string \| null | `"user"`, `"project"`, `"plugin"`, or `null`. Resolved by scanning skill directories **at analysis time**, so a since-deleted skill reads as `null`. |

**Legacy row.** Entries logged before per-skill tracking (`skillCalls`) existed
contribute a single appended row `{ "name": "(pre-tracking)", "invocations": N,
"loads": null, "scope": null }`, where `N` is the count of generic `Skill` tool
calls from those old entries. It is pushed after the sorted skills, so it is not
part of the descending-invocations order.

### `prompts.hashStability`

How often the system prompt / tools / core prompt change between adjacent turns
of a session — a window into prompt-cache churn.

```jsonc
"hashStability": {
  "sysHash":   { "changeRate": 0, "pairs": 0, "label": "never" },
  "toolsHash": { "changeRate": 0, "pairs": 0, "label": "never" },
  "coreHash":  { "changeRate": 0, "pairs": 0, "label": "never" }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `changeRate` | number | `changed pairs / pairs`, **4 dp**, range 0–1. |
| `pairs` | number | Adjacent turn pairs (within a session) where **both** turns carry that hash. |
| `label` | string | Bucketed `changeRate`: `> 0.5` → `every-turn`, `> 0.1` → `frequent`, `> 0.01` → `occasional`, `> 0` → `rare`, `= 0` → `never`. |

### `cache`

| Field | Type | Notes |
|-------|------|-------|
| `hitRate` | number | `cache-read tokens / all input tokens`, **3 dp**, range 0–1. |
| `totalInputTokens` | number | **All** input tokens = `input + cache_creation + cache_read`, summed. (Not just `input_tokens`.) |
| `totalOutputTokens` | number | Sum of `output_tokens`. |
| `totalCacheReadTokens` | number | Sum of `cache_read_input_tokens`. |

### `gapCache`

Cache hit rate bucketed by the idle gap before a turn (time since the previous
turn finished). Only buckets that contain at least one measured gap appear —
**empty buckets are omitted**, so this array can have 0–5 elements.

| Field | Type | Notes |
|-------|------|-------|
| `gap` | string | One of `"<30s"`, `"30s-5m"`, `"5-15m"`, `"15-60m"`, `">60m"`. |
| `turns` | number | Inter-turn gaps measured in this bucket (not sessions). |
| `avgHitRate` | number | Mean per-turn cache hit rate in the bucket, **3 dp**. |
| `medianHitRate` | number | Median per-turn cache hit rate, **3 dp**. |

---

## 2. Multi-cwd comparison array

When **two or more** `--cwd` values are given (e.g. `--cwd proj-a,proj-b`), the
output is a per-project comparison **array** instead of the single-scope object,
sorted by `cost` descending:

```jsonc
[
  { "cwd": "/work/project-alpha", "cost": 0.80, "sessions": 1, "turns": 2, "cacheHit": 0.86 },
  { "cwd": "/work/project-beta",  "cost": 0.30, "sessions": 1, "turns": 2, "cacheHit": 0.78 }
]
```

| Field | Type | Notes |
|-------|------|-------|
| `cwd` | string | Working directory (group key). Always a real path — the `--cwd` filter that triggers this mode drops entries with no cwd, so no `"unknown"` row appears here. |
| `cost` | number | `meta.totalCost` for that group, **2 dp**. |
| `sessions` | number | `meta.totalSessions` for that group. |
| `turns` | number | `meta.totalEntries` for that group. |
| `cacheHit` | number | `cache.hitRate` for that group, **3 dp**. |

The grouping is over the entries that already passed `--last`/`--cwd`/`--session`
filtering, so every matched cwd that survived appears as one row.

---

## 3. Error object

On failure, `--json` prints a single error object and exits with code **1**:

```jsonc
{ "error": "<reason>", "hint": "<actionable hint>" }
```

| `error` | When | `hint` |
|---------|------|--------|
| `"no logs found"` | `index.ndjson` does not exist under the active `CCXRAY_HOME`. | Names the resolved home so you can fix `CCXRAY_HOME`. |
| `"no matching entries"` | The index exists but no entry survived the filters. | Suggests loosening a specific filter (or notes the index is empty). |

Without `--json`, the same conditions print a human message to **stderr** (still
exit 1). Invalid `--last` durations also exit 1 with a stderr message, before any
JSON is produced.

---

## Filter semantics

These apply to both human and `--json` output.

### `--last <d/h/m>`

Keep entries with `receivedAt >= now - duration`. Forms: `7d`, `24h`, `30m`
(days / hours / minutes). Anything else exits 1 with an error. Applied first.

### `--cwd <path>` (matching)

Comma-separated or repeated. Each value matches one of two ways:

- **Absolute (`/…`) or `~`-rooted path → path-bound prefix.** `~` expands to
  your home dir first. The match is subtree-aware: `/work/proj` matches
  `/work/proj` and `/work/proj/sub`, but **not** the sibling `/work/proj-other`.
- **Anything else → case-insensitive substring** against the full cwd. A leading
  `./` is stripped, so `./foo` behaves like `foo`.

Giving **2+** cwd values switches the output to the
[multi-cwd array](#2-multi-cwd-comparison-array).

### `--session <id>` (matching)

Comma-separated or repeated. Resolved **after** `--last`/`--cwd`, so the aliases
operate on the already-filtered scope. Each value is one of:

- **Alias** — `latest` (newest by `receivedAt` in scope) or `costliest`
  (highest summed cost in scope).
- **UUID prefix** — `e.sessionId.startsWith(id)`.
- **Title substring** — case-insensitive match against the session title.

A value that isn't `latest`/`costliest` is tried as **both** a UUID prefix and a
title substring (either match keeps the session).

### `--tools`

Lifts the `tools.top` cap from 7 to all tools (and shows all in human output).

### `--open`

After printing, opens the dashboard to the resolved session — only valid when
exactly one session matched. With **2+** matches it prints a stderr note and
skips opening; with **0** matched sessions it silently does nothing. Either way
it never changes the JSON. In [multi-cwd comparison mode](#2-multi-cwd-comparison-array)
(`--cwd a,b`) `--open` is ignored entirely.

---

## See also

- [`docs/data-model.md`](data-model.md) — the per-entry summary fields
  (`cost`, `usage`, `toolCalls`, `skillCalls`, `sysHash`/`toolsHash`/`coreHash`,
  `isSubagent`, `cwd`, …) that `usage` aggregates from `index.ndjson`.
- [`server/usage.js`](../server/usage.js) — the implementation.
- README → *Usage Analytics CLI* — task-oriented command examples.

---

## Changelog

- **2026-06-21** (Claude, Opus 4.8) — Initial schema reference for
  `ccxray usage --json` as shipped in PR #94. Documents the single-scope object,
  multi-cwd array, and error object, plus filter semantics and per-field
  precision. Backed by the `usage --json shape contract` test that locks the key
  set and field types of every section.
