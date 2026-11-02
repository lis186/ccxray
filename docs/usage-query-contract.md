# Read-only usage query contract (version 1)

External tools should run `ccxray usage --json`. `index.ndjson` is an internal
storage format, not a consumer API. Raw rows can contain duplicate observations,
markers and incomplete metadata. Do not parse them to calculate usage.

```sh
ccxray usage --json --agent-id run-demo --branch feature \
  --cwd /tmp/demo --from 2026-06-01T00:00:00Z --to 2026-06-02T00:00:00Z
ccxray usage --json --by agent --turns --session demo-session
```

The command needs no running server. It reads the configured logs directory
(`LOGS_DIR`, otherwise `<CCXRAY_HOME>/logs`, otherwise `~/.ccxray/logs`) without
creating directories, writing files, starting timers, opening sockets or fetching
prices. Costs use available local pricing data and built-in rates, in memory.
A query does not refresh recordings or import transcripts. No HTTP endpoint is
provided; the CLI avoids introducing another hub authentication surface.

## Flags and selection

| Flag | Meaning |
| --- | --- |
| `--json` | One compact JSON object on stdout. |
| `--turns` | Include allowlisted per-turn summaries; requires `--json`. Omitted by default. |
| `--agent-id <id>` | Exact, case-sensitive recorded identity; comma-separated or repeated. |
| `--branch <name>` | Exact recorded branch; comma-separated or repeated. Never consults current git state. |
| `--from <ISO>`, `--since <ISO>` | Inclusive absolute start with timezone and seconds. |
| `--to <ISO>`, `--until <ISO>` | Exclusive absolute end. Either bound may be omitted. |
| `--last <duration>` | Relative window (`7d`, `24h`, `30m`); cannot combine with absolute bounds. |
| `--by agent\|branch\|cwd\|session` | Group selected turns by one recorded field. |
| `--cwd <path>` | Absolute or `~/` path: subtree prefix with path boundary. Otherwise case-insensitive substring; comma-separated or repeated. |
| `--session <id>` | Session prefix or title substring; `latest`/`costliest` resolve within the other filters. Comma-separated or repeated. |
| `--tools` | Lift the supplementary report's tool-count display cap. |

Values within a selector are ORed; different selectors are ANDed. An identity
is not inferred from cwd. Multiple runs can share a directory. Null identities
remain in unfiltered totals and in a null group. Branch switches split turns
across branch groups; missing branches are never filled from current git state.
Missing flag values and invalid windows exit 1 with a stderr error. `--open`
cannot be combined with `--json`, since opening a browser is a side effect.

JSON and grouped queries merge copies by responseId (ADR 0012), choose one
source per non-Anthropic session (proxy if observed anywhere in the index,
otherwise import), and then apply filters to the merged rows. A proxy and import
copy of one response count once. The whole index is read before filtering so
source selection is not changed by a time or identity filter. Distinct Codex
observations without a reconciliation key are not added across sources; a
partially proxied session can therefore undercount import-only traffic.

Selection uses `from <= receivedAt < to`. Rows without a finite timestamp are
excluded. Equal bounds, missing logs, an empty index, and no matching turns are
successful results (exit 0): zero totals, `groups: []`, and `turns: []` if asked.
Malformed JSON lines are ignored, following the existing reader. Read/permission
errors fail; a missing logs directory is not treated as proof of recording.

A marker has neither model nor usage. `excludedMarkerRows` counts markers that
survived the same merge, source and scope selection, before removing markers.
It is not a count of every raw line discarded. Markers do not affect totals,
groups, models, cost, or null-identity counts.

## Coverage and completeness

`coverage` is currently always `"unknown"`. The current hub lock has an ephemeral
start time, but no durable stop/gap history. Session markers prove individual
observations, not continuous recording throughout an arbitrary window. Neither
turns nor a current lock can establish historical coverage. The query therefore
does not inspect or contact a hub, and does not infer `"recorded"` from traffic.
**Zero turns with unknown coverage does not distinguish no traffic from an
unrecorded window.** A durable recording ledger would be needed to do that.

Retention and incomplete source coverage are separate from pricing confidence.
`meta.retentionDays`, `meta.retentionCutoff`, and conditional
`meta.retentionWarning` disclose the configured retention window. Older history
may have been removed; cost confidence does not certify recording completeness.

## Stable fields and token semantics

`schemaVersion` is the integer `1`. Every successful JSON output, including
single-scope, multi-cwd and grouped output, includes the same versioned fields:

| Field | Shape |
| --- | --- |
| `window` | `{from, to}`: requested ISO timestamps, or null for unbounded ends. `--last` resolves to an absolute start at invocation time. |
| `coverage` | `"unknown"` in version 1. |
| `totals` | Summary of all selected model calls. |
| `providerTotals` | Map of provider ID to Summary; absent providers are omitted. Legacy rows with no provider use `anthropic`. |
| `by` | `agent`, `branch`, `cwd`, `session`, or null when grouping was not requested. |
| `groups` | Summary plus `key` (recorded string or null); ascending key order, null last; no cap. Empty when no grouping was requested. |
| `excludedMarkerRows` | Count of excluded selected markers. |
| `nullAgentIdTurns`, `nullBranchTurns` | Selected model calls missing each identity. |
| `turns` | Optional array, sorted by timestamp then ID. Each item contains only the fields listed in the schema below. |

A Summary contains `turns` (count), `tokens`, `reasoningKnownTurns`, `cost` (USD,
unrounded), `costFold`, `models` (model ID to turn count, uncapped), and
`firstTs`/`lastTs` (observed earliest/latest ISO timestamps or null).

Token fields are `input`, `output`, `cacheRead`, `cacheWrite`, and `reasoning`.
Missing non-reasoning counters contribute zero; this is recorded usage, not an
estimate of missing provider data. All input is `input + cacheRead + cacheWrite`.

| Provider | Cache and reasoning semantics |
| --- | --- |
| Anthropic / Claude | `input` excludes cache reads and writes. `cacheRead` is cached input reused; `cacheWrite` is input written to cache. Reasoning is available only when recorded as `thinkingTokens` or thinking/reasoning token details; legacy rows often lack it. |
| OpenAI / Codex | **Codex input excludes cached tokens.** Wire input that includes cached input is normalized before summing; imported input is already normalized and is never subtracted twice. `cacheRead` is cached input; cache writes are zero unless recorded. Proxy reasoning details may be available. Import-only Codex rows fold reasoning into `output` and do not retain separate reasoning evidence. |
| xAI | Input that includes cached input is normalized using the provider profile; `cacheRead` and `cacheWrite` reflect recorded counters. Separate reasoning is available only when recorded. |
| Other providers | Uses the provider's normalization profile if defined; otherwise canonical recorded counters. No separate reasoning is assumed. |

`reasoning` is null when no selected call has finite reasoning evidence; explicit
zero remains zero. Mixed groups sum only known evidence, with
`reasoningKnownTurns` showing the number of known calls. Precedence is
`thinkingTokens`, output details' reasoning tokens, output details' thinking
tokens, then reasoning output tokens. Reasoning can already be part of `output`;
never add it to output to calculate total usage.

`costFold` is `{count, fallbackCount, fallbackCost, unknownCount}`. `count` equals
the Summary's turn count. Known exact/prefix and legacy finite costs contribute
to `cost`; fallback estimates also contribute and increase `fallbackCount` and
`fallbackCost`. Unpriced calls contribute zero and increase `unknownCount`.
Per-turn `costConfidence` is `exact`, `prefix`, `fallback`, `unknown`, or
`legacy` (a finite stored cost without a recorded confidence label).
A nonzero `unknownCount` means the cost is a lower bound, not a fully priced
zero. Use the complete fold to render confidence (ADR 0017); a mixture of exact
and fallback rates must not be described as wholly exact. Available stale costs
are repriced with the shared offline helper; there is no rate refresh.

Existing analytics fields (`meta`, `sessions`, `models`, `tools`, `skills`,
`prompts`, `cache`, `gapCache`, or `projects` in multi-cwd mode) remain as
supplementary report fields described in [usage.md](usage.md). They are not the
versioned query Summary. JSON session titles are null and skill scopes are null
(no unrelated configuration scan). Turn summaries never contain prompt/response
bodies, titles, headers, credentials, raw usage objects, or internal merge fields.

## JSON Schema

This schema describes the stable query fields. Additional top-level properties
allow the supplementary analytics and future additive fields. Consumers must
ignore unknown properties.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["schemaVersion", "window", "coverage", "totals", "providerTotals", "by", "groups", "excludedMarkerRows", "nullAgentIdTurns", "nullBranchTurns"],
  "properties": {
    "schemaVersion": {"const": 1},
    "window": {
      "type": "object", "required": ["from", "to"],
      "properties": {"from": {"$ref": "#/$defs/timestamp"}, "to": {"$ref": "#/$defs/timestamp"}}
    },
    "coverage": {"const": "unknown"},
    "totals": {"$ref": "#/$defs/summary"},
    "providerTotals": {"type": "object", "additionalProperties": {"$ref": "#/$defs/summary"}},
    "by": {"enum": [null, "agent", "branch", "cwd", "session"]},
    "groups": {"type": "array", "items": {"allOf": [
      {"$ref": "#/$defs/summary"},
      {"type": "object", "required": ["key"], "properties": {"key": {"type": ["string", "null"]}}}
    ]}},
    "excludedMarkerRows": {"$ref": "#/$defs/count"},
    "nullAgentIdTurns": {"$ref": "#/$defs/count"},
    "nullBranchTurns": {"$ref": "#/$defs/count"},
    "turns": {"type": "array", "items": {"$ref": "#/$defs/turn"}}
  },
  "$defs": {
    "count": {"type": "integer", "minimum": 0},
    "timestamp": {"type": ["string", "null"], "format": "date-time"},
    "tokens": {
      "type": "object", "required": ["input", "output", "cacheRead", "cacheWrite", "reasoning"],
      "properties": {
        "input": {"$ref": "#/$defs/count"}, "output": {"$ref": "#/$defs/count"},
        "cacheRead": {"$ref": "#/$defs/count"}, "cacheWrite": {"$ref": "#/$defs/count"},
        "reasoning": {"type": ["integer", "null"], "minimum": 0}
      }
    },
    "costFold": {
      "type": "object", "required": ["count", "fallbackCount", "fallbackCost", "unknownCount"],
      "properties": {
        "count": {"$ref": "#/$defs/count"}, "fallbackCount": {"$ref": "#/$defs/count"},
        "fallbackCost": {"type": "number"}, "unknownCount": {"$ref": "#/$defs/count"}
      }
    },
    "summary": {
      "type": "object", "required": ["turns", "tokens", "reasoningKnownTurns", "cost", "costFold", "models", "firstTs", "lastTs"],
      "properties": {
        "turns": {"$ref": "#/$defs/count"}, "tokens": {"$ref": "#/$defs/tokens"},
        "reasoningKnownTurns": {"$ref": "#/$defs/count"}, "cost": {"type": "number"},
        "costFold": {"$ref": "#/$defs/costFold"},
        "models": {"type": "object", "additionalProperties": {"$ref": "#/$defs/count"}},
        "firstTs": {"$ref": "#/$defs/timestamp"}, "lastTs": {"$ref": "#/$defs/timestamp"}
      }
    },
    "turn": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "sessionId", "agentId", "branch", "cwd", "provider", "model", "receivedAt", "tokens", "cost", "costConfidence", "costFold", "sources"],
      "properties": {
        "id": {"type": ["string", "null"]}, "sessionId": {"type": ["string", "null"]},
        "agentId": {"type": ["string", "null"]}, "branch": {"type": ["string", "null"]},
        "cwd": {"type": ["string", "null"]}, "provider": {"type": "string"},
        "model": {"type": ["string", "null"]}, "receivedAt": {"type": "number"},
        "tokens": {"$ref": "#/$defs/tokens"}, "cost": {"type": "number"},
        "costConfidence": {"enum": ["exact", "prefix", "fallback", "unknown", "legacy"]},
        "costFold": {"$ref": "#/$defs/costFold"},
        "sources": {"type": "array", "items": {"enum": ["import", "proxy"]}}
      }
    }
  }
}
```

## Dummy example

The stable fields from a query with one synthetic imported turn, without `--by`
or `--turns` (supplementary report fields omitted here):

```json
{
  "schemaVersion": 1,
  "window": {"from": "2026-06-01T00:00:00.000Z", "to": "2026-06-02T00:00:00.000Z"},
  "coverage": "unknown",
  "excludedMarkerRows": 1,
  "nullAgentIdTurns": 0,
  "nullBranchTurns": 0,
  "totals": {
    "turns": 1,
    "tokens": {"input": 40, "output": 17, "cacheRead": 80, "cacheWrite": 0, "reasoning": null},
    "reasoningKnownTurns": 0,
    "cost": 0.01,
    "costFold": {"count": 1, "fallbackCount": 0, "fallbackCost": 0, "unknownCount": 0},
    "models": {"dummy-model": 1},
    "firstTs": "2026-06-01T10:00:00.000Z", "lastTs": "2026-06-01T10:00:00.000Z"
  },
  "providerTotals": {
    "openai": {
      "turns": 1,
      "tokens": {"input": 40, "output": 17, "cacheRead": 80, "cacheWrite": 0, "reasoning": null},
      "reasoningKnownTurns": 0,
      "cost": 0.01,
      "costFold": {"count": 1, "fallbackCount": 0, "fallbackCost": 0, "unknownCount": 0},
      "models": {"dummy-model": 1},
      "firstTs": "2026-06-01T10:00:00.000Z", "lastTs": "2026-06-01T10:00:00.000Z"
    }
  },
  "by": null,
  "groups": []
}
```

## Versioning and migration

Within schema version 1, field names, types, selection rules, units and null
semantics above remain stable. New optional top-level or Summary properties may be added. Changes to the
per-turn allowlist, removing or renaming fields, changing meaning, or adding
coverage states require a new
schema version and migration notes. Check `schemaVersion` before consuming;
reject unsupported versions and ignore unknown properties in supported versions.

The first version intentionally standardizes JSON on the shared merged read
model. Earlier non-grouped reports could count cost-only or undated rows, apply
filters before merging, or return error objects on empty results. Those behaviors
remain only in legacy human reports where applicable. JSON now excludes markers
and undated rows, uses canonical attribution and one-source selection, omits
session titles, and treats emptiness as success. Default report size grows with
provider/model cardinality; only `--turns` exposes individual turn summaries.
