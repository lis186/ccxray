# Herdr sidebar observability rail

- Status: Implemented candidate; independent Fable validation pending
- Date: 2026-08-25
- Scope: Herdr sidebar rows owned by the ccxray plugin
- Related research: [`docs/research/herdr-sidebar-observability-2026-08-25.md`](../research/herdr-sidebar-observability-2026-08-25.md)

## Goal

Make every agent state scannable without losing the recent context history.
Rows may grow vertically, but no plugin-owned row may exceed the effective
sidebar width or be rendered with `...`/`…`.

The sidebar is a triage surface. Mission Control remains the detail surface
for the full model name, turn count, exact timestamps, and diagnostic data.

## Non-negotiable rules

1. Every rendered plugin token is selected by terminal display width, not JS
   string length.
2. A field is either shown in full or omitted. It is never partially clipped.
3. Context history and current ctx% share one dedicated row. Cache no longer
   consumes that row's width.
4. One visual channel has one owner:
   - workspace summary: linkage coverage;
   - route row: pane/session/activity state;
   - context row: recent history, current ctx%, and context provenance;
   - facts row: healthy facts;
   - alert row: the highest-priority concern.
5. Telemetry is never borrowed from another pane or session merely to fill a
   blank row.
6. Empty rows remain structurally empty. A missing value is not replaced by a
   misleading healthy value.
7. The installer owns only its marked rows and tokens. Native and user rows
   survive installation, upgrade, failure, and rollback.

## Layout

The following is an illustrative row contract, not copy-paste Herdr syntax.
The important part is row ownership and the mutually exclusive empty states.

```text
spaces
  row 1  $space                         compact workspace alias
  row 2  $xray                          xray N/M, ?, off, or 0/0

agents
  row 1  state_icon + $who              native activity icon + model alias
  row 2  $route                         route and pane state
  row 3  exactly one $ctx_*              history + ctx%
  row 4  exactly one $facts / $alert     healthy facts or one concern
```

The four context tokens (`ctx_green`, `ctx_yellow`, `ctx_red`,
`ctx_unknown`) are mutually exclusive. `$facts` and `$alert` are also
mutually exclusive. Herdr therefore skips an empty row instead of showing a
blank placeholder.

### Compact vocabulary

```text
who       opus, luna, sol, fable, sonnet, haiku; narrow form: X or C
route     >live p3V   =idle p3V   +ready   ?link   !hub   !block   =done
narrow    >           =           +         ?        !       !        =
```

`p3V` is a short stable pane/session suffix, not a substitute for the full
identity in Mission Control. If no safe identity exists, it is omitted.

The row must not use the native long `agent` or `state_text` fields in the
managed agent row; those fields are the source of the screenshot's visible
truncation. `state_icon` remains native so active/idle state is still visible.

## Width contract

The renderer chooses a complete variant. It never clips a chosen variant.
The examples below are complete rows; the right edge is the width boundary.

```text
width  8
┌────────┐
│● X     │
│>       │
│▂ 37%   │
│$15     │
└────────┘

width 10
┌──────────┐
│● codex   │
│>live p3V │
│▂▅ 37%    │
│$15 · 29m │
└──────────┘

width 14
┌──────────────┐
│● codex       │
│>live p3V     │
│▂▅▆ 37%       │
│$15 · 29m     │
└──────────────┘

width 18
┌──────────────────┐
│● luna            │
│>live p3V         │
│▂▃▅▆ 37%          │
│$14.96 · 29m     │
└──────────────────┘

width 26
┌──────────────────────────┐
│● opus                    │
│>live p3V                 │
│▁▂▃▅▆ 37%?               │
│$14.96 · hit 92% · 29m   │
└──────────────────────────┘

width 36
┌────────────────────────────────────┐
│● opus                              │
│>live p3V                           │
│▁▂▃▅▆▇ 37%                         │
│$14.96 · hit 92% · 29m             │
└────────────────────────────────────┘
```

The box drawings above are explanatory. The acceptance test measures the
actual row strings with terminal-cell width and allows no trailing overflow.
`?` after a percentage means the denominator or provenance is uncertain;
`✗` means the evidence is contradicted. Neither is silently treated as
healthy.

Field-fit policy for the facts row:

```text
W >= 24   $14.96 · hit 92% · 29m
W >= 12   $15 · 29m
W <= 11   $15
```

Cost is rounded only when necessary. A lower-bound cost keeps its `+`:
`$15+`. Age, cache, and cost are whole fields; there is no `cache...` or
`29...` form.

## Workspace states

The workspace row prevents the same long linkage warning from being repeated
for every agent.

```text
                         hub and agent inventory
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
         hub absent          inventory known       inventory unknown
             │                    │                    │
         xray off       ┌─────────┴─────────┐       xray ?
                         │                   │
                    zero agents         N of M linked
                         │                   │
                      xray 0/0       xray N/M
```

| Condition | Workspace row | Pane rows | Must not happen |
| --- | --- | --- | --- |
| Hub healthy, all linked | `xray 6/6` | normal route/context | Repeated `ccxray: linked` on every pane |
| Hub healthy, partial linkage | `xray 1/6` | linked panes render normally; others use `?link` | Claim `6/6` from a stale cache |
| No agent list/evidence unavailable | `xray ?` | preserve pane-local safe state, otherwise `?link` | Infer linkage from a model name alone |
| No hub | `xray off` | `!hub` | Show old context or cache as current |
| Hub healthy, zero agents | `xray 0/0` | no agent rows | Treat zero as unknown or as an error |

`N/M` counts only conservatively matched panes. The count is not a health
score and does not reorder the workspace.

## Pane route and activity states

```text
                         pane evidence
                              │
                 ┌────────────┴────────────┐
                 │                         │
             no safe match              safe match
                 │                         │
              ?link              ┌────────┼────────┐
                                 │        │        │
                              no hub   no turn   turn lifecycle
                                 │        │        │
                               !hub    +ready   ┌───┴──────────────┐
                                                  │                  │
                                               active             inactive
                                                  │                  │
                                             >live p3V     =idle p3V / =done
```

Additional terminal states are explicit rather than hidden in a generic
warning:

| State | Normal width | Narrow width | Context/facts behavior |
| --- | --- | --- | --- |
| Linked and receiving turns | `>live p3V` | `>` | Show newest valid context sample |
| Linked but idle | `=idle p3V` | `=` | Keep last known history; freshness governs color |
| Routed, no turn yet | `+ready` | `+` | Context is `?`, not 0% |
| Not linked | `?link` | `?` | No borrowed telemetry; context is `?` |
| Hub unavailable | `!hub` | `!` | No current telemetry; preserve no stale-green state |
| Blocked/refused | `!block` | `!` | Keep valid context; alert owns the reason if known |
| Completed | `=done` | `=` | Keep final valid context and facts until TTL |
| Activity/state unknown | `?state` | `?` | Neutral context token and no invented activity |

`?link` is intentionally shorter than the old `ccxray: not linked`. The
workspace summary carries the aggregate linkage explanation.

## Context states

The context row always has the same semantic shape:

```text
<recent history> <current ctx%><provenance marker>
```

```text
no telemetry       ?
one sample         ▆ 37%
recent history     ▁▂▃▅▆ 37%
default denominator▁▂▃ 37%?
contradicted       ▁▂ 100%✗
stale last sample  ▁▂▃ 37%?       +  !stale 11m
invalid raw value  ?              +  !ctx
```

| Evidence state | Color token | Display | Rule |
| --- | --- | --- | --- |
| Declared or observed, fresh, 0–40% | `ctx_green` | `▁▂▃ 37%` | Confident green band |
| Declared or observed, fresh, 41–80% | `ctx_yellow` | `▃▅▆ 64%` | Confident yellow band |
| Declared or observed, fresh, 81–100% | `ctx_red` | `▆▇ 92%` | Confident red band |
| No samples or no scalar | `ctx_unknown` | `?` | Do not render 0% |
| One valid sample | matching band | `▆ 37%` | One bar is valid history |
| Default denominator | `ctx_unknown` | `▁▂▃ 37%?` | Show value, withdraw confidence |
| Contradicted denominator/evidence | `ctx_unknown` | `▁▂ 100%✗` | Do not clamp to a healthy band |
| Stale but last value valid | `ctx_unknown` | `▁▂▃ 37%?` | Keep history, add `!stale` |
| Out-of-range/NaN/negative raw value | `ctx_unknown` | `?` | Add `!ctx` when diagnostic detail exists |
| Session or pane mismatch | `ctx_unknown` | `?` | Never use another session's sample |

`0%` and `100%` are valid when their denominator is valid. Values below 0 or
above 100 are invalid; they are not silently clamped. The context denominator
uses the existing declared/observed/default/contradicted provenance model.

History uses recent finite main-agent samples only. Subagent-only activity,
an import gap, and a missing main-agent sample do not create a fabricated
history point.

The history fold suppresses an unmarked reversal of at most 15 percentage
points by holding the preceding sample. Prompt/cache accounting can move by a
few tokens between adjacent turns even when the conversation context has not
reset; drawing that as a down-then-up sawtooth is misleading. A sample marked
`isCompacted` always breaks the fold, and an unmarked drop larger than 15 points
also remains visible as a possible reset. This preserves real compaction history
while removing small measurement jitter.

## Facts and alerts

The final row is either healthy facts or exactly one alert. It is not a second
status row.

```text
healthy facts       $14.96 · hit 92% · 29m
rounded facts       $15 · 29m
lower-bound facts   $15+
no facts/no alert   (row omitted)

alert priority      quota > stale > multi-failure > cache drop
quota refusal       !quota
stale import        !stale 11m
repeated failures   !fail2
cache regression    !cache
invalid context     !ctx
```

The priority list is applied only after the context row and route row have
owned their meanings. Context pressure is never duplicated as a generic
alert; linkage is never duplicated as a long per-agent warning.

When an alert does not fit with its optional detail, the complete short code
is retained (`!stale`, `!fail2`) and the detail is omitted. There is no partial
alert and no ellipsis.

## Edge-case state board

This board is the minimum set of visual states required by the implementation
and browser smoke test.

```text
┌──────────────────────┬─────────────────────────────┬──────────────────────┐
│ case                 │ visible result              │ forbidden result     │
├──────────────────────┼─────────────────────────────┼──────────────────────┤
│ long model name      │ compact alias: opus/luna/X  │ claude-opus...        │
│ long workspace name  │ compact $space alias        │ workspace...         │
│ width 8              │ 4 complete short rows      │ clipped token        │
│ width 10/14/18       │ complete fit variant        │ cache... / 29...     │
│ width 26/36           │ more history, full facts   │ fewer history bars   │
│ no hub                │ xray off + !hub            │ old green ctx%        │
│ no agent inventory    │ xray ?                     │ guessed N/M          │
│ zero agents           │ xray 0/0                   │ xray ?               │
│ unlinked pane         │ ?link + ? context          │ other pane's data    │
│ ready, no turn        │ +ready + ? context         │ 0% context           │
│ idle                  │ =idle + last known sample  │ row disappearance    │
│ completed             │ =done + final sample TTL   │ live marker forever  │
│ stale import          │ neutral history + !stale   │ stale green band     │
│ default denominator   │ value + ? provenance       │ confident band       │
│ contradicted evidence│ value + ✗ + neutral band  │ clamped green value   │
│ invalid numeric value │ ? + !ctx                   │ NaN/112% rendered    │
│ subagent-only pane    │ ? or last safe local data  │ borrowed main data   │
│ cache falls sharply   │ valid ctx + !cache         │ cache in ctx row     │
│ quota refusal         │ !quota                      │ buried in facts      │
│ repeated failures     │ !fail2                      │ generic !error only   │
│ no facts/no alert     │ row omitted                 │ blank spacer row     │
│ metadata write fails  │ last safe state + log      │ fabricated success   │
│ TTL expires           │ neutral/unknown state      │ stale-green forever  │
└──────────────────────┴─────────────────────────────┴──────────────────────┘
```

### Refresh, TTL, and failure behavior

```text
fresh report ──refresh──> fresh display
     │                         │
     │ write failure            │ TTL expires
     ▼                         ▼
last safe display        neutral/unknown display
     │                         │
     └──────diagnostic log─────┘
```

- A report write failure does not clear healthy data and does not claim that
  the new report was accepted.
- On TTL expiry, the display loses its confident color. It may retain the
  last history/value with `?` and `!stale`, or become `?` if no safe value
  remains.
- A refresh race must not allow an older report to overwrite a newer report.
- A missing model/provider uses `?`, `X`, or the safe generic alias selected
  by the width variant; it never copies a neighbor's model.
- If the width probe is missing or invalid, use the plugin's safe fallback
  width of 18 and apply the same no-clipping rules.

## Token and configuration limits

The design must fit within Herdr's metadata write limit of 16 token
properties. The proposed set is intentionally small:

```text
space, xray, who, route,
ctx_green, ctx_yellow, ctx_red, ctx_unknown,
facts, alert
```

The refresh operation sets populated tokens and explicitly clears the other
members of each mutually exclusive group. A set/clear request must stay below
the 16-property limit. Stored legacy or user tokens are not counted as a
reason to delete user configuration.

## Migration and recovery

1. Read and validate the existing Herdr configuration.
2. Confirm the installer-owned marker and take a recoverable backup.
3. Replace only the complete old ccxray-managed row/token block.
4. Preserve native rows, user rows, unknown rows, and user extensions.
5. Write the new block idempotently.
6. If parsing or writing fails, restore the previous managed block and leave a
   diagnostic. Do not partially install a row set.
7. A second install must produce the same configuration as the first.

The old repeated `ccxray: not linked` text must not be migrated into the new
route row. The new compact state is `?link`; aggregate explanation belongs in
`$xray`.

## Acceptance tests

### Rendering

- [ ] Golden output covers widths 8, 10, 14, 18, 26, and 36.
- [ ] Every managed row has `displayWidth(row) <= effectiveWidth`.
- [ ] No managed output contains ASCII `...` or Unicode `…`.
- [ ] No field is partially clipped; fields are selected as whole variants.
- [ ] Wide glyphs and sparkline blocks are measured by terminal cells.
- [ ] Long model, workspace, route, cost, age, and alert values remain
      readable through aliasing or omission.

### State coverage

- [ ] Workspace: `N/M`, `?`, `off`, and `0/0`.
- [ ] Route: live, idle, ready, linked-but-no-turn, unlinked, no hub,
      blocked, done, and unknown.
- [ ] Context: none, one sample, full history, all three confident bands,
      default provenance, contradicted provenance, stale, invalid, mismatch,
      0%, and 100%.
- [ ] Facts: full, rounded, lower-bound, and empty.
- [ ] Alerts: quota, stale, multi-failure, cache drop, invalid context, and
      priority ordering.
- [ ] Refresh failure, TTL expiry, race ordering, missing model, missing
      width, and metadata-limit failure.

### Integration and regression

- [ ] Empty context/facts/alert rows are skipped by Herdr.
- [ ] Exactly one context color token is populated per refresh.
- [ ] Exactly one of facts/alert is populated per refresh.
- [ ] An unlinked pane cannot display another pane's telemetry.
- [ ] Context history remains visible after cache text is removed from that
      row.
- [ ] Workspace linkage is not repeated as a long warning on every agent.
- [ ] Installer is idempotent and preserves native/user rows.
- [ ] Real-browser smoke verifies active, idle, unlinked, no-hub, stale,
      default, contradicted, and long-name cases.
- [ ] The render ceiling remains safe for 471 turns and 32 lanes.

This specification deliberately ends at design and verification criteria; it
does not change production code or Herdr configuration.
