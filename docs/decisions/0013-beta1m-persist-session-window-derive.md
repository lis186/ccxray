# 0013 — Persist the beta1m fact; derive the per-session context% window

- Status: **Accepted** (expert-panel design 2026-07-24; owner plan approval same day)
- Date: 2026-07-24
- Related: #339 (this) / #342 (swimlane render rescope, kept) / #211 (over-claim
  guard) / #58 #212 (maxContext identity) / ADR 0012 (add-only index field
  precedent) / ADR 0005 (classification stays on raw per-turn signal)

## Context

Within one session the context% denominator `maxContext` was inconsistent
across turns — some ÷1,000,000, some ÷200,000 — so raw-smooth token usage
rendered a sawtooth (8% beside 40%). Root cause: the authoritative 1M signal
`beta1m` (the `anthropic-beta: context-1m-*` request header, read live at
`index.js:462`) is **never persisted**. `maxContext` is computed at three
independent paths — live forward (sees `beta1m`), restore, and cold-load
(both re-infer without it) — and the header is not echoed on every request, so
turns of the same 1M session disagree. `maxContext` is not only a display
denominator: **classification reads it** — `isCompacted` (`entry-rendering.js`,
`prev.maxContext`) and lane placement (`workflow-timeline.js`, `wfCtxPct`).

A four-expert panel (Kleppmann, Hickey, Helland, Bailis — independent
assessments, 2026-07-24) unanimously reframed the bug: *you persisted an
interpretation (`maxContext`) and discarded the observation (`beta1m`)*. The
fix is to persist the fact and derive the window, **not** to mutate the shared
`maxContext`:
- Mutating `maxContext` to a session-consistent value (option S) feeds a
  future-dependent latch into a prefix-local classifier: turn 3's compaction/
  lane verdict would change when turn 50 flips the latch, so the live path
  (hasn't seen turn 50) and a batch rebuild disagree — the exact live≠batch
  divergence that got #342's stateful `sess.maxWindow` reverted (8b6789f).
  Bailis: the latch is I-confluent, but `classification ∘ latch` is not.
- A pure render-time consensus with no persisted fact (option R) can't fold a
  fact that isn't on disk: after a restart, a 1M session whose usage never
  crossed 200K flattens to a false 200K (Hickey). R only works once the fact
  is persisted — at which point it collapses into this ADR.

## Decision (option S′)

**Persist `beta1m` (the fact); derive `sessionWindow` (the view). Classification
keeps raw per-turn `maxContext` untouched.** Display and classification have
different temporal semantics — the displayed denominator may be session-global
and future-dependent; classification must be a pure function of the prefix — so
they are genuinely two things and live in two fields.

### Persist the fact (write path, add-only)
- `beta1m` is added to `INDEX_FIELDS` / `buildIndexLine` (`server/entry.js`),
  add-only exactly like ADR 0012's `responseId`.
- `anthropic.buildEntryFields` returns `beta1m` **gated on
  `SUPPORTS_1M`** — mirroring `getMaxContext`'s `beta1m && SUPPORTS_1M` branch,
  so `beta1m` on the log ⟺ "this turn authoritatively ran a 1M window" and a
  stray 1M header on a non-1M model never over-claims (#211 guard). Written
  only when true (absent = no positive signal; a monotone OR-fold).
- `summarizeEntry` (`server/sse-broadcast.js`) surfaces `beta1m` so the client
  and cold-load derive from it.

### Derive the view (render, stateless)
- `sessionCtxWindow(sid)` (`public/miller-columns.js`): a render-time,
  **stateless** fold over the session's main turns — 1M if any turn has
  `beta1m===true` (authoritative), else the largest observed `maxContext`
  fossil (heals legacy 1M sessions whose usage crossed 200K, for which `beta1m`
  was never persisted), else 200K. Never stored on `sess` — recomputed each
  render, so it cannot go stale on reclassification / threshold crossing /
  live-merge (the three 8b6789f failure modes). Session card, its window label,
  and the timeline minimap divide by it; the swimlane lane fold
  (`_wfWinByTurn`, #342) prefers `beta1m` over the fossil.

### Classification is NOT derived from this
`isCompacted`, per-turn `severity`, and lane placement keep reading raw
per-turn `maxContext`. This preserves the ADR 0005 / a1dfe5c invariant
("classification stays on raw per-turn maxContext") — this ADR **upholds** it,
does not amend it.

## Legacy healing (no backfill — the header was never on disk)

The proposal floated a `rebuild-index` backfill of `beta1m` from surviving
`_req.json`. **Verified infeasible and unnecessary, so dropped**: the
`anthropic-beta` header is read only live (`index.js:462`) and persisted
nowhere per-turn (`_req.json` stores the body, not headers). Legacy 1M sessions
heal anyway via the fold's `maxContext`-fossil fallback (any turn that crossed
the usage hatch carries a 1M fossil). Sessions with zero surviving 1M evidence
are irrecoverable by any method — the fact is gone. This is Kleppmann's
"derive from the log": the log has `maxContext`, derive from it; nothing to
migrate.

## Consequences

**Good**: one consistent denominator per session; server-side single source of
truth for the persisted fact; survives restart and reaches cold-load; the
render fold is coordination-free and rebuildable (Bailis: I-confluent monotone
OR-fold; Kleppmann: pure function of the log). Classification untouched, so no
lane/compaction re-audit needed and no ADR 0005 risk.

**Accepted limits**: (1) legacy sessions with no surviving 1M fossil stay 200K
(under-report — the safe failure, and unrecoverable regardless). (2) Live, a
turn rendered before `beta1m` first arrives shows a provisional window that
heals on the next render / reload (display eventual-consistency — legitimate,
unlike a stale stored field). (3) `severity`'s context dimension still uses raw
per-turn `maxContext`, so a mixed-window edge case can mis-badge — the
pre-existing, documented #342 under-warning limit, not made worse here.

**New consistency contract**: a display site that needs the per-session
denominator must call `sessionCtxWindow(sid)` (or the lane fold), never divide
by raw per-turn `maxContext`. A classification site must do the opposite. Guard
comments at `sessionCtxWindow`, `_wfWinByTurn`, `entry-rendering.js` (the raw
numerator store), `server/entry.js`, and `anthropic.buildEntryFields` name this
ADR.

## Panel record (independent assessments, 2026-07-24)

Kleppmann / Hickey / Helland / Bailis — **all four ranked S′ first**, each
independently identifying "beta1m is never persisted" as the root cause. 3/4
vetoed S (mutate the shared field); Bailis's `classification ∘ latch is not
I-confluent` is the decisive argument. R is not a standalone solution (flattens
to a false 200K after restart when the fact is unpersisted; collapses into S′
once it is). Helland additionally vetoed the issue's original acceptance metric
("stored maxContext per session unique==1" — it rewards laundering an
interpretation into a fact); the metric was restated as "beta1m persisted +
sessionWindow per-session-consistent and rebuildable, never-beta1m sessions
stay 200K".

## Verification (real data, 2026-07-24)

- Unit: `test/session-ctx-window.test.js` — fold correctness, #211 over-latch
  guard, subagent exclusion; fail-on-old confirmed (`sessionCtxWindow` absent
  on the pre-fix commit).
- Real index (513 MB, streamed): the 5 mixed sessions from #339 (528ca562,
  6fedf7b0, 5cf687af, 0d1c519a, 7d31f073) each had 2–3 distinct main-turn
  `maxContext` values → fold to exactly 1. Global: 105 sessions carried the bug
  (>1 distinct) → **105/105 collapse to one window, 0 residual**. All heal via
  the fossil fallback (`beta1m=false` on legacy data), confirming the
  no-backfill decision.
- Classification zero-change by construction (no severity/isCompacted/lane code
  touched) + 296 affected tests green (incl. #44/#222/#332/#230 classifiers).
