# 0020 — Fixed, right-anchored context trend in the Herdr Sidebar

- Status: **Accepted** (owner decision 2026-08-27)
- Date: 2026-08-27
- Related: Herdr Sidebar context observability, ADR 0005, ADR 0013

## Context

The Herdr Sidebar context bar previously sized its trend from the number of
available samples. A session with one sample therefore rendered a short bar,
while a session with many samples rendered a long bar. That made bar length
look like context pressure even though it represented history depth.

The Sidebar is narrow and refresh-driven. It needs a stable viewport whose
geometry communicates time without animation, while preserving the scalar
percentage and its denominator marker.

## Decision

The context trend uses a fixed cell viewport derived from the measured Sidebar
width. Herdr's layout-derived outer width reserves four cells for native
Sidebar chrome before it becomes the custom-token width. The scalar suffix
occupies a fixed, right-aligned slot, so changing from
`9%` to `100%` cannot move the chart endpoint. The newest sample is always the
rightmost chart cell; refresh recalculates the stateless view.

```
older ------------------------------------------------------> newest
[░][░][▂][▃][▆][░] [  ?]
 ^ missing history       ^ latest unknown    fixed scalar slot
```

`░` (U+2591 LIGHT SHADE) means that the chart cell has no valid sample. It is
used for missing prefix history and for a latest turn whose context usage is
unknown when older valid history exists. It inherits the active context-band
colour. If no valid context sample exists at all, the bar renders only `?` and
does not fabricate an all-placeholder chart. Stale or denominator-uncertain
context keeps the existing neutral/unknown colour behavior.

When a native session is present in the index tail but fewer than three usable
main-agent samples are visible, the badge starts the existing detached targeted
repair. That worker already scans the exact transcript and caches at most 64
display samples in the linkage state. The refresh path merges that ring with
the tail; it never scans the global index to recover the trend. A matching
contextless subagent row is therefore not treated as sufficient context
evidence. If three or more known samples move by at least eight percentage
points, the scalar adds `↑` or `↓` as a guarded direction cue (for example,
`60%↑`).

An explicit context-input usage report containing zero is valid history and
renders as the lowest context block. A response with no context-input usage is
unknown, even if output usage exists.

## Data contract

`contextUsageKnown` is an append-only index field:

- `true`: the source explicitly reported context-bearing usage, including zero.
- `false`: the source was observed but did not report context-bearing usage.
- absent: legacy row. A positive normalized context sum remains inferable; a
  zero sum remains unknown.

All live proxy, WebSocket, rebuild, import, merge, and session-index paths
preserve this provenance. Renderers treat `contextUsed()` as nullable and share
the same received-time ordering and main-turn anchor for Sidebar and Mission
Control.

The Sidebar also reads the hub's per-session `beta1m` aggregate when the visible
tail has lost the declaring turn. This preserves the authoritative 1M
denominator without guessing from a model name or hardcoding 1M for every
Claude session.

## Consequences

**Good:** bar geometry is stable; right-to-left ordering makes time legible;
the scalar remains visible within Herdr's actual row content width; working
panes keep their metadata alive through startup refresh;
unknown data is visible without being presented as zero; explicit zero remains
distinguishable after restart; old index rows remain readable without a
backfill.

**Accepted limits:** a legacy zero-valued row cannot be recovered as known
without the original wire evidence; no animation is used; when the latest
sample is unknown, the scalar is `?` while older valid cells remain visible.
The repair ring is intentionally limited to 64 recent samples and is refreshed
only when the transcript fingerprint changes or an older state lacks samples.

## Verification

The contract is covered by Herdr formatter tests for fixed widths, scalar-slot
alignment, explicit zero, latest unknown, out-of-order input, missing history,
and compaction/jitter behavior. Parser/importer/index tests cover provenance
round trips and legacy-compatible unknown usage.
