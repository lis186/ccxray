# Task attribution for orchestrators

An orchestrator that launches many short-lived agent workers needs their cost
grouped by the unit of work, not by session. ccxray records three optional
labels on every proxied request and serves an aggregate over them:

| Label | Index field | Meaning |
|---|---|---|
| `task` | `task` | The unit of work, e.g. an Agentflow Ask id `A-012` |
| `role` | `role` | The pipeline stage that made the call, e.g. `implementation`, `cross-check` |
| `project` | `taskProject` | The orchestrator's project label |

`taskProject` is deliberately not the dashboard's cwd-derived project. A worker
often runs in a disposable clone, so the two differ. Task ids are usually only
unique inside one project (`A-001` exists in every Agentflow notebook), so pass
`project` whenever you pass `task`.

Values are trimmed, stripped of control characters, and dropped when empty or
longer than 128 characters. Attribution is metadata: a malformed value is
ignored and never causes a proxied request to fail.

## Check the capability first

```
GET /_api/health
{ "ok": true, "app": "ccxray", "version": "…", "capabilities": ["task-attribution", "session-intervals", "cost-charges"] }
```

Inject the path prefix below **only** when `capabilities` contains
`task-attribution`. A ccxray that predates this feature has no such route: it
would forward the prefixed path upstream and every worker API call would 404.

## Carrier 1 — base-URL path prefix (works for every CLI)

```
/_ccxray/attr/<SEGMENT>
SEGMENT = encodeURIComponent(new URLSearchParams({ task, role, project }).toString())
```

One opaque path segment, non-empty keys only. Example:

```
/_ccxray/attr/task%3DA-012%26role%3Dcross-check%26project%3Dipadpos
```

ccxray strips the prefix before forwarding; the upstream never sees it. Put it
in the base URL each CLI already accepts:

| CLI | Setting |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:5577/_ccxray/attr/<SEGMENT>` |
| Codex CLI | `-c openai_base_url="…/_ccxray/attr/<SEGMENT>/v1" -c chatgpt_base_url="…/_ccxray/attr/<SEGMENT>/v1"` |
| Grok CLI | `GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:5577/_ccxray/attr/<SEGMENT>/v1` |

This is the only carrier that reaches Codex on a ChatGPT login and the Grok CLI:
neither can send custom headers. It also covers Codex's WebSocket transport.

The prefix composes with the hub's client route in either order, so a worker
launched from inside a `ccxray <agent>` session can keep the inherited
`/_ccxray/client/<pid>` and append its own attribution:

```
http://localhost:5577/_ccxray/client/4242/_ccxray/attr/<SEGMENT>
```

When two attribution segments are present the later one wins per key.

`server/attribution.js` exports `buildAttributionPrefix()` for Node callers.

## Carrier 2 — request headers (Claude Code, or your own HTTP client)

```
x-ccxray-task: A-012
x-ccxray-role: cross-check
x-ccxray-project: ipadpos
```

Like every `x-ccxray-*` header these are stripped before forwarding. When both
carriers are present the path prefix wins per key, because header environment
variables are inherited down a process tree and can be stale in a nested worker.
A value may not contain a comma: Node joins duplicate headers with `, `, so only
the first comma-separated segment is read.

## Carrier 3 — launch environment

`CCXRAY_TASK`, `CCXRAY_ROLE`, and `CCXRAY_PROJECT` set on a `ccxray <agent>`
launch are registered with the hub and apply to that client's requests. Use this
to label a whole interactive session. A per-request carrier overrides it.

## Coordinator usage

The coordinator is one long-lived host process, so its base URL cannot carry the
current Ask's task label. Agentflow can instead attribute a host interval by
session id:

```
GET /_api/task-summary?task=<id>[&project=<p>][&role=<r>][&from=<ms>&to=<ms>]&session=<SPEC>&session=<SPEC>…
SPEC = <sessionId>@<fromMs>-<toMs>
```

`fromMs` and `toMs` are inclusive epoch milliseconds. An empty `toMs` means
"until now". At most 32 `session` parameters are considered; malformed,
non-numeric, or reversed specs are ignored. The capability is advertised as
`session-intervals` in `GET /_api/health`.

`from` and `to` are optional epoch-millisecond bounds for labelled entries:
`from` is inclusive and `to` is exclusive. A missing side is unbounded and a
malformed or reversed window is ignored. The response reports the applied
window as `window: { from, to }`, or `window: null` when no valid bound was
applied. Session-selected coordinator entries continue to use their own
`session=<SPEC>` interval and are not filtered by this labelled-entry window.

The result is the union of entries labelled with the requested task and entries
whose exact `sessionId` and `receivedAt` match a valid interval. A session entry
with a different task label is skipped, and session-selected entries are
aggregated under role `coordinator`. Therefore
the coordinator SPEC path selects only entries whose `role` is null, undefined,
empty, or exactly `coordinator`; any other role is never coordinator-selected.
`role=coordinator` selects only session entries; another role selects only
labelled entries. The response includes `by_role.coordinator` and, when at least
one valid SPEC was supplied, a `coordinator` object whose `sessions` list
contains every valid SPEC, including zero-call intervals. Its aggregate fields
`calls`, `cost_usd`, `cost_confidence`, `uncomputable_requests`, `charges`,
`last_ingested_at`, and `pending_requests` match `by_role.coordinator`.
Session-selected entries are read from `index.ndjson` for the requested session
ids, so they are not limited by `CCXRAY_MAX_ENTRIES`; entries present in memory
and on disk are deduplicated by entry `id`.

## Reading it back

```
GET /_api/task-summary?task=A-012[&role=cross-check][&project=ipadpos]
```

```json
{
  "task": "A-012", "role": null, "project": "ipadpos",
  "calls": 3, "cost_usd": 0.0421,
  "tokens": { "input": 300, "output": 45, "cache_read": 1500, "cache_create": 0, "reasoning": 20, "total": 1845 },
  "cache_hit_rate": 0.833,
  "tools": { "Bash": 2 }, "tool_failures": 0, "skills": {},
  "by_role": { "cross-check": { "calls": 3, "cost_usd": 0.0421, "tokens": {}, "cache_hit_rate": 0.833, "charges": [] } },
  "models": ["gpt-5.5"], "agents": ["codex"], "sessions": 1,
  "first_ts": 1790000000000, "last_ts": 1790000009000,
  "charges": [{
    "model": "gpt-5.5", "billing_provider": "openai", "component": "input",
    "unit": "tokens", "quantity": "300", "usd_per_unit": "0.15",
    "usd": "0.000045", "basis": "recorded", "price_key": "gpt-5.5",
    "rate_source": "ccxray"
  }],
  "last_ingested_at": "2026-09-20T00:00:09.000Z", "pending_requests": 0,
  "window": null,
  "coverage": { "entries_in_memory": 812, "max_entries": 5000 }
}
```

The top-level summary, every `by_role` value, and the optional `coordinator`
value append `charges`, `last_ingested_at`, and `pending_requests`. `charges`
has one bucket per model/provider/component/rate/basis combination; components
are `input`, `output`, `cache_read`, and `cache_create`. Quantities and exact
USD totals are decimal strings, zero-quantity components are omitted, and
`basis` is `recorded`, `fallback`, or `unpriced`. An unpriced bucket retains
its observed quantity but has `usd_per_unit: null` and `usd: null`; a call with
no usage contributes no charge quantity. `uncomputable_requests` counts selected
entries with usage whose charge buckets contain at least one `unpriced` bucket,
once per entry, and excludes entries without usage. `last_ingested_at` is the
ISO form of the latest selected `receivedAt`, and `pending_requests` counts selected
entries whose status is `null`.

- Token fields are disjoint for every provider: `input` excludes cached tokens,
  and `total` is the sum of input, output, cache_read, and cache_create.
  `reasoning` is a subset of `output`.
- `project` matches `taskProject` exactly. An entry that declared no project
  falls back to its cwd, matched as a whole path segment (`ipadpos` does not
  match a cwd under `ipadpos-web`).
- An unknown task returns 200 with `calls: 0`.
- `cost_confidence` classifies every counted call: `priced`, `unknown` (usage
  present but no price, so `cost_usd` under-counts), `fallback` (priced with a
  default rate), `no_usage` (counted, contributes nothing). Mark a total whose
  `unknown` or `no_usage` is non-zero; do not present it as exact.
- Labelled (worker) entries are read from the in-memory window
  (`CCXRAY_MAX_ENTRIES`); `coverage` lets a caller tell "no calls" from "calls
  aged out". Coordinator entries selected by `session` are read from the index
  on disk and are not limited by that window.
- `/api/task-summary` is served as an alias.

Loopback callers need no credentials. See [SECURITY.md](../SECURITY.md) for
non-loopback access.
