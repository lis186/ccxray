# History-only 1M sessions over-report context pressure ~5x — diagnosis and design options

- Status: **Diagnostic** — awaiting owner `APPROVE-DESIGN 601-diag-0830` on #601
- Date: 2026-08-30
- Related: #601 (this) / #211 (capability ≠ serving window) / #588 (badge/dashboard sync — landed stopgap) / ADR 0013 (persist-fact-derive-view) / ADR 0020 (Herdr fixed context trend, targeted repair)

## Problem

`getMaxContext` clamps Claude models' LiteLLM capability value to 200K
(`server/config.js` #211 — correct: capability is not the serving window).
Recovering 1M requires evidence: the `context-1m-*` beta header (live wire),
the `[1m]` system-prompt marker (live wire), or observed usage climbing past
the assumed window. **A transcript-import-only ("history-only") session has
none of the first two**, so a genuine 1M session renders against a 200K
denominator until its usage crosses 200K — over-reporting context pressure up
to 5x in the badge and Mission Control. Reproduced: a fable-5 session whose
Claude Code statusline showed **ctx 9%** rendered **`51%↑?`** in the Herdr
sidebar (same numerator ~100K; denominator 1M vs 200K).

## Verified facts (2026-08-30)

### F1 — transcript schema carries no window signal (scope 1)

Searched locations (negative claim scope, per the issue's requirement):

- Homes: `~/.claude/projects/`, `~/.claude-personal/projects/`
  (`~/.claude-work/projects` is a **symlink** to `-personal` — see F4 caveat).
- Files inventoried in full (streamed, every line JSON-parsed, keys unioned to
  depth 4): four transcripts spanning Jun 23 → Aug 30 CC versions, including
  a 22.9 MB / 390-assistant-record fable-5 session written today.
- Record types seen (13): `assistant`, `user`, `system`, `attachment`,
  `last-prompt`, `mode`, `permission-mode`, `atis-latch`,
  `file-history-snapshot`, `queue-operation`, `ai-title`, `pr-link`,
  `agent-name`.
- Key regex `/context|window|beta|1m|maxcontext|budget|tier|serving/i` over
  every key path: hits only `message.usage.service_tier` (value `"standard"`
  — priority-tier, not window) and `message.usage.speed` (`"standard"` —
  fast-mode flag). No window-bearing field in any record type.
- `message.model` is the bare `claude-fable-5` in **440/440** assistant
  records checked (no `[1m]` suffix anywhere outside quoted conversation
  content). System prompt is not stored. Confirms the issue's two-path
  finding.

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
| O1 | Persist a settings-derived window **fact** at import: importer reads the scanned home's `settings.json`, and when the model base matches, writes an add-only index field (e.g. `settingsCtx1m: true`) — display fold treats it as a **new provenance tier** between `observed` and `default` (own marker, not bare, not `?`-free) | the number, for the dominant real case (user pins `[1m]`) | ADR 0013 discipline: persist the *fact* ("settings declared [1m] at import time"), never launder `maxContext=1M`; marker semantics decision (a third glyph or keep `?`); retroactive misattribution on model switches; **symlinked-homes ambiguity is real on this machine** (may need "any scanned home's settings match" OR-rule, which widens false 1M); touches importer + entry.js INDEX_FIELDS + fold sites (badge, dashboard `sessionCtxWindow`) | pressure triage: **mostly** (marked as assumed-from-settings; wrong across model-switch boundaries) |
| O2 | Upstream ask: Claude Code persists the session's context window (or model-with-variant) in the transcript | root cause, permanently, with true per-session provenance | not in our control; timeline unknown; still needs O0/O1 meanwhile | pressure triage: **yes**, once shipped |
| O3 | Herdr-only: the ADR 0020 targeted-repair worker reads `settings.json` when it scans the exact transcript, caching the window hint in its linkage state | the badge number, plugin-scope only, no index schema change | dashboard cold-load still divides by 200K (surfaces disagree — the exact class #588 existed to kill); same provenance caveats as O1 | badge yes / dashboard no — **splits the two surfaces**, not recommended alone |
| O4 | Suppress the number when `ctxWindowSource === 'default'` (render `?` alone, keep trend cells) | removes the misleading 51% | destroys real information for genuinely-200K default sessions (opus-4-x etc.) where the number is right; ADR 0020 chose visible-but-marked over hidden | attention: colour only; number withheld |

**Rejected — unconditional per-model 1M for fable-5**: F2 shows the 200K
client budget is real (picker variant, opt-in header, 150–200K compaction
shapes). Dividing a bare-mode fable session by 1M hides true pressure —
the exact #211 regression, in the dangerous direction.

## Recommendation

O1 (+ file O2 upstream as a tracking issue). O1 is the only option that fixes
the number on both surfaces without laundering an assumption into
`maxContext`: the persisted fact is honest ("the scanned home's settings
declared [1m] for this model at import time"), the fold stays
stateless-at-render, and the marker keeps telling the truth that the
denominator is inferred. The symlinked-homes ambiguity is the main design
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

## Signoff

Owner: comment `APPROVE-DESIGN 601-diag-0830` on #601 to approve a fix issue
per the recommendation (or name a different option). Per
`docs/issue-authoring.md`, the token deliberately does not contain this
pipeline round's runId.
