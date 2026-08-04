# 0018 — `turnToolCalls`: null/undefined versus `{}`

- Status: Accepted
- Date: 2026-08-04
- Related: #427 / ADR 0001 (toolCalls versus skillCalls)

## Context

`toolCalls` is cumulative: it is extracted from request history, so summing it
across turns counts earlier calls repeatedly. `turnToolCalls` is the response-side
per-turn delta introduced by #427 and is therefore the preferred source for
aggregates.

The response-side extractor has to distinguish two cases that both contain no
tool names:

- An old entry, or an entry whose response data is missing, has no usable
  response-side result. It carries `turnToolCalls` as `null` or leaves it
  `undefined`.
- A parsed response with no `tool_use` blocks has a valid empty result, `{}`.

Collapsing `{}` into nullish state makes consumers fall back to cumulative
`toolCalls`, even though the response was successfully parsed and proves that
this turn made zero tool calls.

## Decision

`turnToolCalls` has a load-bearing null-vs-empty contract:

- `null`/`undefined` means a legacy entry or missing response data. Consumers
  may fall back to cumulative `toolCalls`, using a per-tool maximum within each
  session rather than summing the cumulative snapshots.
- `{}` means the response was parsed and contained zero tool calls. Consumers
  must not fall back to `toolCalls` for that turn.
- A non-empty object is the exact per-turn response delta and is summed directly.

This is intentionally expressed through JavaScript truthiness at the fallback
sites: `turnToolCalls || toolCalls` short-circuits correctly because `{}` is
truthy. Replacing the distinction with a generic falsy/empty check, or
normalizing `{}` to `null`, reintroduces the cumulative overcount.

The fallback sites covered by this contract are:

| Site | Required behavior |
|------|-------------------|
| `public/entry-rendering.js` hot path (~line 719) | Use the exact per-turn map; only nullish state uses cumulative `toolCalls` with per-tool max. |
| `public/entry-rendering.js` recompute path (~line 852) | Same preference and legacy fold as the hot path. |
| `public/workflow-timeline.js` lane totals (~line 2802) | Sum response deltas; put only nullish turns into the legacy per-tool max fold. |
| `server/usage.js` legacy fold (~line 237) | Skip response-parsed turns, including `{}`, from the cumulative per-session max fold. |

Guard comments at each site name this ADR. The distinction is part of the
stored/indexed field contract and must survive transport, restore, and cold-load.

## Consequences

**Good**: a parsed zero-tool response contributes zero without accidentally
  reusing historical request counts; legacy entries remain usable through the
  documented per-tool-max fallback; all consumers share one unambiguous test.

**Accepted limit**: legacy entries without response data cannot recover exact
  per-turn deltas, so their cumulative fallback may undercount when the observed
  per-tool maximum is incomplete. This is the honest behavior until response
  data is available; it must not be “healed” by treating an observed `{}` as
  missing.
