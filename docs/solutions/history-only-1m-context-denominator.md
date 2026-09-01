# History-only 1M sessions over-report context pressure ~5x — diagnosis and design options

- Status: **Complete** — signed off 2026-08-30 (`APPROVE-DESIGN 601-diag-0830`);
  O1 shipped in #605, O2 declined (#608 closed not planned), #601 closed. The
  Problem and Verified-facts sections below are the state AS DIAGNOSED on
  2026-08-30/31 and are kept as evidence; see "Outcome" for what shipped.
- Date: 2026-08-30 (outcome recorded 2026-09-01)
- Related: #601 (this) / #211 (capability ≠ serving window) / #588 (badge/dashboard sync — landed stopgap) / ADR 0013 (persist-fact-derive-view) / ADR 0020 (Herdr fixed context trend, targeted repair)

## Problem (as diagnosed, before #605)

`getMaxContext` clamps Claude models' LiteLLM capability value to 200K
(`server/config.js` #211 — correct: capability is not the serving window).
Recovering 1M requires evidence: the `context-1m-*` beta header (live wire),
the `[1m]` system-prompt marker (live wire), or observed usage climbing past
the assumed window. **A transcript-import-only ("history-only") session has
none of the first two, and the import path consumed no window-variant
DECLARATION signal — its only recovery was the usage hatch** — so a genuine 1M
session rendered against a 200K denominator until its usage crossed 200K,
over-reporting context pressure up to 5x in the badge and Mission Control.
(Scope, per the corrected F1a/F4: declaration signals DO exist on disk for
some sessions — cost-state's `[1m]` key, settings.json — but at diagnosis time
the importer did not read them, so the over-report hit every history-only 1M
session below the usage hatch regardless of what sat on disk. Since #605 it is
narrowed to sessions lacking any positive declaration.) Reproduced: a fable-5 session whose
Claude Code statusline showed **ctx 9%** rendered **`51%↑?`** in the Herdr
sidebar (same numerator ~100K; denominator 1M vs 200K).

## Verified facts (2026-08-30)

### F1 — transcript schema inventory (scope 1) — **corrected 2026-08-31**

> **Correction.** The first revision of this section claimed "no window-bearing
> field in any record type" from a four-file sample. A full scan of all 91
> fable-5 transcripts found record types the sample missed — including one
> that DOES carry a positive window signal (`cost-state`, F1a below). The
> sampled negative claim was wrong in scope; what follows is the full-corpus
> result.

Searched locations (negative claim scope, per the issue's requirement):

- Homes: `~/.claude/projects/`, `~/.claude-personal/projects/`
  (`~/.claude-work/projects` is a **symlink** to `-personal` — see F4 caveat).
- **All 91 fable-5 transcripts** (mtime ≥ 2026-08-05, >300KB) streamed with
  every line JSON-parsed and keys unioned to depth 4.
- Record types seen (21): `assistant`, `user`, `system`, `attachment`,
  `last-prompt`, `mode`, `permission-mode`, `atis-latch`,
  `file-history-snapshot`, `queue-operation`, `ai-title`, `pr-link`,
  `agent-name`, `cost-state`, `fork-context-ref`, `file-history-delta`,
  `frame-link`, `relocated`, `worktree-state`, `artifact-autoreact-ledger`,
  `artifact-comment-monitor`.
- Key regex `/context|window|beta|1m|maxcontext|budget|tier|serving/i` over
  every key path. Non-signal hits: `message.usage.service_tier` /
  `message.usage.speed` (both `"standard"` — priority tier and fast-mode, not
  window), `message.context_management` (observed value `null`),
  `fork-context-ref.contextLength` (fork metadata, ~1100-scale counts, not a
  window), plus content-derived key names inside `toolUseResult`/snapshot
  maps. **Signal hit: `cost-state.modelUsage` — see F1a.**
- `message.model` is the bare `claude-fable-5` in every assistant record
  (13,288 across the corpus; no `[1m]` suffix outside quoted conversation
  content). System prompt is not stored. The issue's two named paths are
  confirmed empty — but the issue's overall "the import path has no signal"
  conclusion is superseded by F1a and F4.

### F1a — `cost-state.modelUsage` keys carry the `[1m]` variant (positive-only, partial coverage)

`cost-state` records (new — present only in transcripts with mtime ≥
2026-08-27, 15/91 files) aggregate per-model usage under `modelUsage`, keyed
by the **client-internal model id, `[1m]` suffix included** when the pane ran
the 1M variant (`claude-fable-5[1m]`, `claude-opus-4-6[1m]`,
`claude-opus-4-8[1m]` all observed). Reliability, measured against the
usage ground truth (a session whose main-chain context exceeded 200K provably
ran 1M):

| cost-state files | peak > 200K | `[1m]`-keyed | verdict |
|---|---|---|---|
| 15 | 13 | 6 | 6/6 verifiable positives confirmed; **7 false negatives** (bare or empty keys on sessions peaking up to 510K) |
| — | ≤ 200K: 2 | 1 | the `[1m]` hit at peak 115K is exactly the case the usage hatch cannot heal — but it is **unverifiable by usage** (see below) |

Measurement boundary (codex review, 2026-08-31): the usage ground truth can
only CONFIRM 1M (peak > 200K); it can never confirm that a ≤200K session ran
a 200K window, so **the false-positive rate is unmeasured** — there is no
known-200K control in this corpus. The 115K `[1m]` hit is consistent with the
pane's settings but not independently confirmed. What bounds the risk is
semantics, not measurement: the key records the client-internal model id the
pane ran, so a false positive requires cost-state to record a variant the
pane did not run. The fix design must still contain it (capability gate + no
alarm authority), not assume it away.

So the key is trustworthy in ONE direction only, and that trust is
semantic-plus-6/6-verified, not exhaustively measured: **presence of a
`[1m]`-suffixed key is per-session, in-transcript evidence of the 1M window;
absence proves nothing** (bare keys occur on provably-1M sessions written the
same week — mechanism undetermined).

**Enrichment-timing limitation (codex R3, measured 2026-08-31)**:
`cost-state` occurred once per transcript in the sampled set (4/4), and was
at the very end in 3/4. The importer dedups by assistant id — a later scan
rebuilds `existingIds` from `index.ndjson` and skips already-imported entries
(`server/importer.js:504-543`) — so an actively growing session normally
cannot acquire a late tail `cost-state` fact through an incremental rescan.

This is an explicit coverage split, not a new enrichment mechanism: settings
are consulted on every scan and therefore annotate newly imported turns; the
targeted-repair path re-reads the complete exact transcript and can see its
tail `cost-state` (with its bounded context samples carrying the fact); and
the ordinary cost-state path is strongest for sessions imported after they
finish. A transcript imported before its tail record remains recoverable by
`rebuild-index --reimport` — plain `rebuild-index` only replays
`index.ndjson` plus surviving `_req/_res`, so it cannot recover
transcript-only evidence. We do not add a rescan enrichment path here.
Accordingly, "wherever cost-state carries the key" describes those completed
or targeted-repair reads, not a promise that every already-imported live
session will be retroactively annotated. This remains a positive fact, never
a deny; coverage is new-turn / post-import-path only, and legacy sessions
remain in ADR 0013's no-backfill class.

### F2 — fable-5 serving-tier facts (scope 2)

The issue asked: does a 200K serving window exist for fable-5, or is 1M the
only window (which would make per-model unconditional 1M safe)? **Both tiers
exist; unconditional per-model 1M is a #211 regression.** Four independent
evidence lines:

1. **Official docs** (platform.claude.com models overview, fetched
   2026-08-30): Claude Fable 5 context window = **1M tokens** at the API,
   listed natively (no beta qualifier), with long-context pricing above 200K.
   So the *API* ceiling is 1M — but the API ceiling is not what the badge
   needs; the client's context budget is.
2. **Wire** (live hub aggregates, read-only): **37/173** fable-5 sessions
   were live-proxied carrying the `context-1m-*` beta header
   (`beta1m=true`, `SUPPORTS_1M`-gated at write time). Claude Code sends an
   explicit opt-in header for `[1m]` panes — an opt-in that would be
   pointless if every fable-5 session ran 1M.
3. **Product surface**: Claude Code's model picker distinguishes
   `claude-fable-5` from `claude-fable-5[1m]`
   (`~/.claude.json` → `additionalModelOptionsCache`), and the user's choice
   persists in each config-dir's `settings.json` (`"model":
   "claude-fable-5[1m]"`). Two picker variants = two client budgets; the
   bare variant is the 200K default (consistent with the in-repo comment at
   `server/config.js:339-341`).
4. **Behavior** (91 recent fable-5 transcripts, main-chain usage timelines):
   **42/91 sessions exceed 200K** (max 665K) — 1M sessions are real and
   common in this corpus; 4 compaction-shaped drops (>80K) start from the
   150–200K band (a 200K-budget auto-compact shape; manual `/compact` not
   ruled out per-event); 0 drops start from the 600–850K band (no session
   reached the 1M auto-compact threshold).

Note the earlier hub-bucket "77 fable sessions at 200K" is **not** evidence
of a 200K tier: bucketing is circular (any no-header session crossing 200K is
reclassified 1M by the usage hatch, so the 200K bucket only ever contains
≤200K sessions), and for imported sessions `beta1m=false` means the header
was *unobservable*, not absent.

**Blast radius in this corpus**: the user's `settings.json` pins `[1m]` in
both config-dir homes, so history-only fable-5 sessions here are
overwhelmingly 1M; the 77 sessions rendered against 200K include e.g. one at
**94%** displayed whose true ratio is likely ~19%. False-alarm direction, as
the issue states.

### F3 — the issue's UI blast-radius claims are stale: the stopgap already landed (scope 3)

The issue (filed 2026-08-30) asks to evaluate "色帶在 `?` 時不觸發黃/紅" as a
stopgap. **That exact behavior shipped in #588 (merged 2026-08-25)**, in both
consumers:

- Sidebar badge: `plugins/herdr/bin/lib/ccxray.js` `summarizeTurnGroup` sets
  `ctxBand: 'unknown'` when `ctxWindowSource === 'default' || 'contradicted'`;
  the renderer (`plugins/herdr/bin/refresh-badges.js`
  `applyContextColorTokens`) maps `'unknown'` to the neutral token.
- Mission Control: `missionControlRow` escalates severity on ctx% only under
  `measuredCtx` (`ctxWindowSource === 'declared' || 'observed'`); an assumed
  denominator instead emits the honest reason string
  `context window assumed N%?`. The attention filter and `focus-attention.js`
  key off `severity`, so ordering is protected by the same gate.
- The installed plugin (`~/.config/herdr/plugins.json`) points at this repo's
  live checkout, so the observed pane runs post-#588 code.

**Corrective to the issue body**: "badge 色帶在 40%/80% 用假數字轉黃/紅，
Mission Control 的 attention 排序跟著失真" does not hold on current main.
The residual defect is narrower: (a) the **number itself** is still ~5x wrong
(51% vs 9%) with only a `?` to carry the doubt, and (b) Mission Control's
concerns line emits `context window assumed 51%?` noise for sessions that are
in fact fine.

### F4 — a third signal exists outside the transcript, with weak provenance

The issue inventoried two signal locations (transcript `model` field, system
prompt). A third exists and is reachable by the import path:
**`<config-dir>/settings.json` `"model"`** — the persisted `[1m]` choice
(e.g. `claude-fable-5[1m]`). Caveats that any consumer must carry:

- It is **mutable current state**, not per-session provenance: sessions
  recorded before the user switched models would be retroactively
  mis-attributed. It is an *assumption with evidence*, never `declared`.
- **Per-home attribution is broken on this machine**: `~/.claude-work/projects`
  symlinks to `~/.claude-personal/projects`, while the two homes'
  `settings.json` disagree (`claude-fable-5[1m]` vs `opus[1m]`). A transcript
  under the shared `projects/` cannot be mapped to one home's settings.
- Only meaningful when the settings model's base name equals the transcript's
  `message.model`.

## Options

Per-option: what it fixes, what it costs, and what management question the
resulting number can/cannot answer.

| | Option | Fixes | Costs / risks | The badge % may then be used for |
|---|---|---|---|---|
| O0 | Status quo + README known limitation | nothing (documents it) | history-only 1M sessions keep a ~5x-high number with `?`; colour/severity already honest (#588) | attention triage via colour: **yes** (gated); reading the number as pressure: **no** for `?`-marked sessions |
| O1 *(amended 2026-08-31)* | Persist import-path window **facts** at import, two sources OR'd, both positive-only: **(a) primary — `cost-state.modelUsage` `[1m]`-suffixed key** (F1a: per-session, in-transcript provenance; 6/6 verifiable positives confirmed, false-positive rate unmeasured — no known-200K control) and **(b) fallback — the scanned home's `settings.json` model** (F4: home-level, mutable). Write an add-only index field; display fold treats it as a **new provenance tier** between `observed` and `default` (own marker, not bare, not `?`-free) | the number — (a) gives real per-session provenance for completed imports and targeted-repair reads that see the tail key; (b) covers new turns on every scan in the dominant pinned-settings case | ADR 0013 discipline: persist the *fact*, never launder `maxContext=1M`; (a) has measured false negatives (7/13) so (b) or the usage hatch must back it; an already-imported running session is recovered by `rebuild-index --reimport`, not a new enrichment mechanism (F1a); marker semantics decision (a third glyph or keep `?`); (b) risks retroactive misattribution on model switches and **symlinked-homes ambiguity is real on this machine**; touches importer + entry.js INDEX_FIELDS + fold sites (badge, dashboard `sessionCtxWindow`) | pressure triage: **mostly** — (a)-sourced numbers carry per-session evidence; (b)-sourced stay assumed-from-settings |
| O2 | Upstream ask: Claude Code persists the session's context window (or model-with-variant) in the transcript | root cause, permanently, with true per-session provenance | not in our control; timeline unknown; still needs O0/O1 meanwhile | pressure triage: **yes**, once shipped |
| O3 | Herdr-only: the ADR 0020 targeted-repair worker reads `settings.json` when it scans the exact transcript, caching the window hint in its linkage state | the badge number, plugin-scope only, no index schema change | dashboard cold-load still divides by 200K (surfaces disagree — the exact class #588 existed to kill); same provenance caveats as O1 | badge yes / dashboard no — **splits the two surfaces**, not recommended alone |
| O4 | Suppress the number when `ctxWindowSource === 'default'` (render `?` alone, keep trend cells) | removes the misleading 51% | destroys real information for genuinely-200K default sessions (opus-4-x etc.) where the number is right; ADR 0020 chose visible-but-marked over hidden | attention: colour only; number withheld |

**Rejected — unconditional per-model 1M for fable-5**: F2 shows the 200K
client budget is real (picker variant, opt-in header, 150–200K compaction
shapes). Dividing a bare-mode fable session by 1M hides true pressure —
the exact #211 regression, in the dangerous direction.

## Recommendation

O1 (+ file O2 upstream as a tracking issue). **Superseded by the outcome below
— O2 was declined; read that section before acting on this one.** O1 is the only option that fixes
the number on both surfaces without laundering an assumption into
`maxContext`: each persisted fact is honest ("this transcript's cost-state
declared the [1m] variant" / "the scanned home's settings declared [1m] for
this model at import time"), the fold stays stateless-at-render, and the
marker keeps telling the truth about the denominator's provenance. The
2026-08-31 amendment makes `cost-state` the primary source — it is the only
per-session signal — with settings as the weaker fallback; the (a)-primary
pivot was confirmed by the owner on 2026-08-31 and shipped in #605. The symlinked-homes ambiguity is the main design
question for the fix issue: scanning **every** discovered home's settings and
applying the OR widens false-1M risk, and a false 1M hides pressure — the
#211 danger direction. Two containments must therefore ship together:
(a) the signal applies only when the model base matches AND
`modelSupports1M()` passes (capability gate reused), and (b) the new tier is
**not** granted alarm authority — it stays outside `measuredCtx`, so colour
and severity keep treating the session as unmeasured; the tier only corrects
the displayed number and its marker. A wrongly-1M number then under-reports
but cannot silence a gated alarm that never fired from assumed denominators
anyway.

O4 is not recommended; O3 only as a stopgap if O1's index-schema cost is
deferred — but it re-splits surfaces #588 just unified.

## Outcome (2026-09-01) — O1 shipped, O2 declined by the owner

- **O1 shipped**: #603 / PR #605. Both facts are persisted positive-only under
  the capability gate, and the `imported` provenance tier corrects the displayed
  denominator while keeping the `?` marker and no alarm authority.
- **O2 declined**: filed as #608 and closed `not planned` — the owner chose not
  to pursue an upstream request. The evidence needed to reopen it is recorded on
  that issue.

The consequence is the part that matters for future readers: **the `imported`
tier is the permanent answer, not a bridge held open until upstream fixes the
transcript.** Every limit listed below and in #605 therefore stays — the
end-of-session `cost-state` write (ordinary incremental import does not enrich
an already-imported turn's index line or session aggregate — but the Herdr
targeted-repair path DOES overlay a late `cost-state` onto its returned
`contextSamples`, per ADR 0020, so do not rebuild that route), the
`[1m]`-key false negatives (7/13 measured), no legacy backfill, and a marker
that never graduates to `declared` for history-only sessions. Nothing upstream
is coming to remove them.

That also removes the cheapest argument for deferring the cold-aggregate
follow-up (#606): it can no longer be postponed on the grounds that an upstream
fix would make it moot, so it has to be judged on its own trigger rate — which
is a three-way intersection (mixed models × an observed non-default window × an
imported declaration), self-heals on entry load, and has no observed instance.

## Known limits

### Follow-up — cold aggregate loses a narrow observed window

For a mixed-model orchestrator session with a non-default observed narrow
window (for example, 128K) and an imported 1M fact, a cold card can temporarily
select 1M. `sessions.json` aggregates only `max(maxContext)` plus the imported
fact, so it cannot express that the observed non-default window takes category
precedence over the 200K default. This is under-reporting: the wider temporary
denominator makes displayed context pressure too low. Loading the session's
entries restores the per-turn observation and self-heals the card to 128K. The
follow-up fix is an add-only `sessions.json` observed-window aggregate field;
no schema change is made in this work.

## Signoff — complete

Two separate owner decisions, in order — conflating them would misdate the
source pivot:

1. **2026-08-30** — `APPROVE-DESIGN 601-diag-0830` on #601 approved O1's
   direction as specced at that time, i.e. the `settings.json` declaration as
   the signal.
2. **2026-08-31** — after the F1 correction (#604) surfaced
   `cost-state.modelUsage` as a stronger per-session signal, the owner
   confirmed the two-source pivot (cost-state primary, settings fallback) on
   #603; that is the form #605 shipped.

#601 is closed. Per `docs/issue-authoring.md`, the signoff token deliberately
did not contain that pipeline round's runId.
