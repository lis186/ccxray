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

## Amended by #377 (2026-07-30)

Weather is an isomorphic pure function: the same `public/weather.js` is loaded
by a browser script tag and by Node via `require`. It therefore cannot call the
client-only `sessionCtxWindow`. Callers with a partial view must inject the
per-session or per-lane window, while callers whose turns contain the complete
evidence may let weather fold those turns itself. The context-window contract
above is unchanged: weather was violating the contract; the contract was not
wrong.

`sessionCtxWindow` originally used the server-provided per-session fold only
when the client had no entry for that session. When `allEntries` is truncated
by `RESTORE_DAYS` or `SESSION_ENTRY_CAP`, a surviving turn can carry a smaller
`maxContext` while the discarded history contained the true 1M evidence; the
old gate then skipped the complete server fold. The client now unconditionally
merges that fold with its surviving turns using monotone `max(maxContext)` /
`OR(beta1m)`. The operator can only grow the window, so it cannot create a false
warning. That is only half of the safety argument, however: a wrongly enlarged
window can hide a true warning.

**F5 known limitation — server/client classification disagreement can hide a
true warning.** The server fold is now gated by `isMainTurnByAgentKey` (the
shared L1 agentKey classification, #381) — narrowing the original gap from
"raw `isSubagent` heuristic vs. full 5-layer pipeline" to "L1 only vs.
L1+L2+L3+L4". The remaining divergence is L2–L4 (coreHash/overlap/seq),
which the client applies but the server does not. If the server classifies a turn as main but the client classifies it
as subagent, and that turn is the session's only 1M evidence, the server fold
can enlarge an actually-200K main session to 1M and suppress real context
pressure. On 2026-07-30 we replayed L1 (the `agentKey` rule) and L2 (#350's
per-conversation `coreHash` plurality) over 84 sessions carrying 1M evidence:
all 44 `beta1m` sessions plus the 40 most recent `maxContext`-fossil sessions.
F5 hit **0/84**, with **0 observed harmful signal suppressions**. This
measurement is bounded: 631 other fossil candidates were not tested, and the
turn-level flips from ADR 0008 overlap and ADR 0009 sequencing were not run
through a complete `wfInferLanes` replay. The empirical shape explains the zero:
the main conversation almost always enables its own 1M window; “a subagent
exclusively owns the 1M evidence while main is truly 200K” did not occur in the
measured corpus.

On the server, deriving the injected window from `session-index`'s `s.beta1m`
and `s.maxContext` does not violate this ADR's stateless-at-render decision and
does not repeat `8b6789f`. That revert removed a client-side `sess.maxWindow`
attached to incremental `addEntry`; its commit touched only
`entry-rendering.js`, and all three blockers were incremental-render state
failures (failure to retract after reclassification, stale stored severity,
and live-merge enrichment not updating the latch). In contrast,
`session-index` is a rebuildable derived view whose monotone
`OR(beta1m)`/`max(maxContext)` aggregation is checked for mtime staleness,
rebuilt when reconcile detects drift, and forcibly rebuilt on schema
migration. There is already a precedent: `463bf61` (2026-07-28, four days
after this ADR) added these two aggregate fields specifically to feed
`sessionCtxWindow`'s cold-session fallback.

Although the computed `sessionWindow` remains stateless-at-render,
`sessionsMap.beta1m` and `sessionsMap.maxContext` are stored client state. This
client latch is admissible only while all three premises hold: (i) it is a
monotone merge of facts (`OR` / `max`), not a classification conclusion; (ii)
it mirrors a server-derived view that reload can reconstruct; and (iii) it
never feeds classification — `isCompacted`, per-turn `severity`, and lane
placement do not read it. If any premise stops holding, the latch must be
re-evaluated.

**New consistency contract:** any monotone merge into a hot session's window
fields (`mergeColdSessions`) must trigger weather/stats recomputation for every
affected session; otherwise it repeats `8b6789f` blocker 2's stale stored
severity failure.

One known seam remains in the live merge path. In `server/forward.js`,
`if (!merged) sessionIdx.updateFromEntry(entry)` means `beta1m` enrichment
carried only by a merged duplicate copy does not enter the session-index fold.

**It is not self-healing.** `reconcileMetas` (`server/session-index.js:184`)
compares only session count and responseId-deduped entry count; an enrichment
on an already-counted responseId changes neither, so no drift is detected and
no rebuild fires. The mtime staleness check in `loadSessionIndex` (`:37-41`)
does not cover it either: the live path still appends the raw line to
`index.ndjson`, but `sessions.json` is flushed afterwards by subsequent
entries, so at the next startup `sessions.json` is typically the newer file
and the check passes. Only an explicit rebuild (`ccxray rebuild-index`, a
schema migration, or a startup that happens to find `index.ndjson` newer)
re-derives the fold from the raw lines — where the evidence has been all
along, since the merge path never stops persisting it.

The seam's direction is safe: the window can only be under-reported, producing
over-warning rather than hiding pressure. It is bounded and recoverable, but
recovery is manual — this ADR does not claim it heals on its own.

**Resolved by #388 (2026-07-31).** `forward.js` and `restore.js` now call
`updateFromEntry(canonical)` unconditionally after merge. The `!merged` guard
is removed; enrichment fields propagate on every path. The "not self-healing"
analysis above is no longer applicable — the seam is closed.

Classification remains separate and unchanged. `isCompacted`, per-turn
`severity`, and lane placement still read raw per-turn `maxContext`; this
amendment changes only weather's display/health denominator and preserves the
ADR's display/classification boundary.

## Amended by #503 (2026-08-11) — a derivation-semantics probe for persisted weather

This ADR established that `sessions.json` is a **rebuildable derived view** whose
staleness is caught by three mechanisms: the mtime check (`loadSessionIndex:45-51`),
the field-existence probe (`:63-77`), and `reconcile`'s count comparison
(`:208`). #503 changed *how* the rebuild path derives weather — from a
first-seen responseId skip to `store.mergeByResponseId` — and none of the three
mechanisms can see that change:

- the field probe asks whether `weather.stats.toolSignal` **exists**, which is
  true before and after;
- `reconcile` compares session and entry **counts**, which the merge preserves by
  construction (one canonical per responseId — the ADR 0012 cardinality property);
- the mtime check compares files, not derivations, and `sessions.json` is normally
  the newer of the two.

So the rebuild would have been skipped and every cold session card would have kept
rendering weather produced by the deleted rule, with all checks green. The gap is
generic: **any** future change to a derivation feeding a persisted view has it.

**Decision**: persisted weather carries an explicit derivation revision,
`s.weatherRev`, and the load-time probe treats a mismatch exactly like a missing
field. `WEATHER_REV` is bumped whenever the derivation changes; revision 1 is the
implicit (absent) pre-#503 state.

The stamp is written by ONE setter, `_assignWeather`, because three paths persist
weather and restore's step-6 pass (`restore.js:457`, via `setWeather`) overwrites
what the rebuild wrote. An unstamped writer among them does not merely lose the
stamp — it makes every subsequent startup detect a stale revision and rebuild,
turning the probe into a permanent rebuild loop.

**New consistency contract**: a site that persists `s.weather` must go through
`_assignWeather`, and a change to the weather derivation must bump `WEATHER_REV`.
Neither is enforced at build or test time; the guard comments at `WEATHER_REV`,
`_assignWeather`, the probe, and each of the three writers name this ADR.
`test/session-index.test.js` (`#503`) asserts all three writers stamp, so a new
writer that bypasses the setter is caught only if it is added to that assertion —
the honest limitation, same class as ADR 0002's `sigParts` and ADR 0015's R4.

This changes nothing about the display/classification boundary: weather remains a
display/health view, and `isCompacted`, per-turn `severity`, and lane placement
still read raw per-turn `maxContext`.

## Amended by the 1M-capability work (2026-08-16) — `beta1m` is an interpretation, `ctxBeta` is the fact

This ADR's Decision line reads "**Persist `beta1m` (the fact); derive `sessionWindow`
(the view)**". Measured against real traffic, `beta1m` was never the fact. It is a
conclusion drawn at write time from two inputs: the observed `anthropic-beta` header
AND a model-capability judgement (`SUPPORTS_1M`). Collapsing both into one boolean
lost information the ADR's own persist-the-fact principle says to keep, and the
capability half was wrong in both directions the moment a model shipped:

- `claude-opus-5` was absent from the regex, so every 1M Opus 5 session divided by
  200K. Measured: a session at 13% of its window rendered 76%, and a counterfactual
  replay of the real corpus (the header as it actually rode the wire) moves 161 turns
  from 200K to 1M and flips 7 of 32 sessions from red to green.
- the bare `opus-4` prefix claimed 1M for `claude-opus-4-5`, which serves 200K —
  hiding real pressure, the more dangerous direction.

### What changes

1. **`ctxBeta` is persisted** (`INDEX_FIELDS`, add-only, appended last): the
   `context-*` entries of the request header, verbatim, filtered to the window shape
   `context-<n><k|m>-` so the context-EDITING beta cannot land in a window field.
   `beta1m` stays, unchanged in meaning, as the capability-gated interpretation.
   **The two may legitimately disagree**: a header on a model the gate refuses stores
   `ctxBeta` and no `beta1m`. A consumer that reads `ctxBeta` presence as "this is 1M"
   reintroduces the #211 over-claim.
2. **The tier is parsed, not tabulated**: `contextBetaWindow()` reads the size out of
   the beta id, so a future `context-400k-*` is legible without a code change. Nothing
   on the wire ships a non-1M tier today — this is why the raw header is kept rather
   than its boolean.
3. **The capability gate is a UNION of two sources**, `modelSupports1M()` =
   hand-list OR LiteLLM `max_input_tokens >= 1M`. LiteLLM may ADD, never DENY: its
   field is semantically inconsistent (it reports `claude-fable-5` at 1M = capability
   but `claude-sonnet-4-5` at 200K = default serving window, though Sonnet 4.5 serves
   1M under the beta), so a capability-decides gate silently demoted a model the list
   had right. Removing a wrong entry stays a manual edit; no upstream datum is trusted
   to mean "cannot do 1M".
4. **"The header was never on disk" is no longer true going forward.** This ADR's
   no-backfill section stays correct for legacy lines — the fact is gone for those —
   but new turns carry it, and `restore`'s heal pass re-derives from the line's own
   persisted signals instead of re-inferring from model+usage alone.
5. **The observation floor climbs to the smallest covering tier** instead of jumping
   to a hardcoded 1M (LiteLLM lists real Claude tiers at 80K/100K/128K/200K/409,600/1M),
   bounded by capability. Non-Claude providers are still never bumped: some report
   `input_tokens` inclusive of cached tokens, so an un-normalized usage object can sum
   above its window without the window being wrong, and widening from a possibly
   double-counted total would hide pressure.
6. **The Claude importer now derives `maxContext`**, as the Codex importer has since
   #384. Claude transcripts declare no window and never record the header, so the only
   evidence there is the observation. Measured on the real corpus: 332 of 750 imported
   turns gain a larger window, and 7 sessions stop rendering above 100% (148%, 239%, …).

### Trust must be monotone in time, not just consistent in code

The write gate, the marker branch, and `restore`'s `trustStored` share one predicate.
That is agreement in code, not in time: the predicate's input is a table refreshed
daily, so a missing cache, a renamed upstream key, or another machine can make the
same line resolve differently across a restart. `trustStored` therefore ALSO accepts
`meta.beta1m === true` — a write-time attestation that the header was present and the
gate accepted it. **Absence of capability data must never act as a deny**, or the
"every restart erases it" failure returns through a new door.

### Boundary preserved, inputs changed

`isCompacted`, per-turn `severity`, and lane placement still divide by raw per-turn
`maxContext`; the display fold is still session-global. What changed is HOW the raw
per-turn value is derived, and only for turns written after this lands — existing lines
are not rewritten, so nothing reclassifies retroactively and no `WEATHER_REV` bump is
required (the weather derivation is untouched; only future inputs differ).

### New test-isolation surface

Window resolution now reads `pricing-cache.json`, which is **package-relative and
therefore outside `CCXRAY_HOME` isolation** — the ADR 0015 R4 class. `CCXRAY_PRICING_CACHE`
overrides the path and `pricing.__setContextTableForTests()` injects a table; a test that
asserts window behaviour must use one of them or stub `getModelContext`, or it silently
reads the developer's cache. See `docs/testing.md`.

### Provenance is derived, never stored

`sessionCtxWindowSource(sid)` returns `declared | observed | default`, and the session
card marks an assumed denominator (`60% of 200K?` + tooltip) while leaving an evidenced
one clean. It is computed at render time from persisted facts, exactly as this ADR
requires of `sessionCtxWindow` — storing it would relaunder an interpretation as a fact.

The fold has a fourth state, `contradicted`, keyed on EVIDENCE rather than on
provenance: a main turn that carried more context than the window it is divided by
proves that window wrong, whatever produced it — so it outranks `declared` too. This
is a different claim from "unverified" and must not share its marker: the percentage
is not merely uncertain, it is a ratio whose denominator is already known to be too
small, and the display's `Math.min(100, …)` clamp otherwise renders it as a confident
"100%". The clamp is kept for the bar and the colour — saturation, not a claim — while
the number reports the real ratio, so the card shows `130% of 200K✗`.

It is keyed on the numerator the card actually renders (`latestMainCtxUsed` from the
session fold), with the retained entries as a second source. Deriving it from the
entries alone let the label and the number disagree whenever the overflowing turn had
been evicted or arrived without usage — which is precisely the cold-load path where
this state lives. A marker site must switch on the enum; `ctxWindowUnverified()`
answers only "may I treat this window as measured". Restore's heal pass repairs
such a window before the client ever sees it (the observation floor), so the state is
reachable only where the heal does not run: legacy lines with no `provider`, and the
cold-load path that serves raw index lines.

`declared` is keyed on `beta1m`, NOT on `ctxBeta` presence. Claude Code sends the header
on every request on a beta account, so keying on presence would mark every session
measured and silence the marker in precisely the case it exists for: the next unlisted
1M model rendering against an assumed 200K.
