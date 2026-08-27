# Making the export configDir allowlist actually apply — design, for sign-off

- Status: **awaiting owner sign-off. Not implemented.**
- Review: adversarial sign-off pass by fork A (2026-08-27) returned **SHIP-WITH-CHANGES**;
  its two blockers are folded in below (§2#1 canonicalization level, §2#3 rationale) plus
  one surfaced limitation (§7 codex OAuth). Fork B's pass was lost to a runtime state reset
  and has not been re-run.
- Date: 2026-08-27
- Scope: make the allowlist filter what it claims to. **Not** distinguishing company vs
  personal *account* inside an allowed directory — the owner accepts that loss (#549).
- Method: one brief → two independent proposals (fork A = Fable, fork B = Codex) →
  coordinator adjudication, every countable claim re-verified against source.

## 1. The defect: two bugs pointing in opposite directions

`CCXRAY_EXPORT_CONFIG_DIRS` (default `.claude`) is treated as the control that keeps
personal-account sessions out of the company bucket, and is about to be taught to 38
people. It filters nothing.

| # | Bug | Effect today | Effect if fixed ALONE |
|---|---|---|---|
| 1 | `configDir` absent from `INDEX_FIELDS`; predicate is fail-open (`export-sync.js:431-433`) | `cd` always undefined ⇒ **everything passes** | — |
| 2 | `configDirFromText` returns a **full path** (`store.js:448`) against a basename allowlist | unreachable | never matches ⇒ **everything is excluded** |

**So the obvious minimal fix — "add `configDir` to `INDEX_FIELDS`" — silently zeroes the
export.** Both halves must land together.

Key measurements (2026-08-27): exact-key grep `"configDir":"` over all 297,750 real
index lines returns **0 hits**; `.claude` has had 0 transcripts modified in 14 days
while `.claude-personal` has 1,137, and `.claude-work/projects` is a symlink to it.

## 2. Decision table

| # | Question | Fork A | Fork B | Taken | Rationale |
|---|---|---|---|---|---|
| 1 | Symlinks | realpath | realpath | **agreed, at the `projects` level** | The measured symlink is `~/.claude-work/projects → ~/.claude-personal/projects`; **the home dirs are distinct real inodes**, so `realpath(~/.claude-work)` is itself and resolves nothing. Canonicalize `realpath(<root>/projects)` and take its parent, on BOTH the label and the allowlist side |
| 2 | Filter vs merge order | after merge (heals unlabeled) | before merge (prevents contamination) | **neither — group predicate (§3)** | Both hazards are real; merge is simultaneously the healing and the contamination mechanism |
| 3 | Unlabeled turns | fail-closed (openai passes) | fail-closed (all) | **fail-closed** | "Unknown" is not evidence of belonging to an allowed store, and an uploaded GCS object is not clawed back by a later re-upload. For openai specifically see §4a — the earlier "an imported twin heals it" rationale was false and is withdrawn |
| 4 | Label value | basename | canonical absolute path | **B** | Basenames collide across locations; B's `parseConfigDirAllowlist(raw, home)` keeps the operator-facing env var unchanged, so onboarding is unaffected |
| 5 | Default value | add `.codex` | keep `.claude` | **A** | The importer labels Codex transcripts `.codex`. Keeping the bare default excludes ~13% of turns, and `sessions_flagged` is deliberately all-vendor — that amputates safety signal, not just an excluded money column |
| 6 | Session-level conflict | not addressed | latch, then return unknown | **B** | The sniff is a content regex and can mis-fire. Never last-write-wins |
| 7 | Authoritative live label | conditional hardening | not proposed | **promote to main line, same PR** | The mechanism already ships (`providers.js:39-40` + `forward.js:135-141`, #575). Without it, fail-closed rests on an obs-fragile text regex |
| 8 | Observability counters | two BQ columns | none | **A** | This project has a documented "exporter silently went quiet" failure class, and fail-closed is precisely the design that produces it |
| 9 | rebuild-index backfill | skip in v1 | do it | **A** | The date floor means historical lines never upload, so labeling them buys nothing exportable |

## 3. The core: a group-level predicate

Fork A puts the filter after `mergeEntry` so a labeled imported copy can heal an
unlabeled live turn; fork B puts it before so a disallowed copy cannot pour
cost/cwd/credential metadata into an allowed one. Both risks are real. Deciding per
responseId group takes both:

```
for each responseId group (and each unmerged singleton):
  labels := { e.configDir for e in group if e.configDir != null }
  any label ∉ allowlist  → exclude the whole group   # B's isolation
  else labels ≠ ∅        → include                    # A's healing
  else                   → exclude                    # fail-closed
```

Implementation: leave `mergeEntry` where it is, but carry a `_configDirs` Set on the
merged record (dropped before aggregation) and evaluate in the second pass. A
conflict-latched session (#6) contributes `null`, not a label.

**Grouping is gated on `responseId` (`export-sync.js:406-414`), so it does not exist for
openai/WS at all** — measured coverage is 0.0% on 39,417 real openai lines, and #508
records that both ends (live WS and the Codex importer literal) omit it. Every openai
entry is therefore an ungrouped singleton reading its own label. §4a states what that
means; anywhere else in this document that says "heals via its imported twin", read it as
anthropic-only (91.8% rid coverage on go-forward traffic).

## 4. The date floor shrinks the problem (verified, not assumed)

The floor applies **only in the upload loop** (`:924`); `aggregate()` is floor-blind and
`dt === cutoffDt` still uploads as partial (`:932`). The real cursor has no `cutoffDt`
yet, so the first post-deploy flush stamps it at that day.

**Therefore, if the label and the floor ship together, the unlabeled-line question
shrinks from 297,750 lines to at most one UTC day per machine.** Within that day live
lines heal via their imported twin; pre-deploy *imported* lines do not, because
`existingIds` (`importer.js:391`) blocks a re-append that would carry the label.
Direction is undercount, surfaced by the #8 counters.

## 4a. OpenAI: the conclusion stands, the original rationale does not

An earlier revision justified excluding unlabeled live openai turns by saying an imported
Codex twin would heal them through the group predicate. **That mechanism does not exist**
(§3): with no `responseId` there is no group key, so a live openai turn and its imported
twin are two independent singletons.

The decision is kept on different ground: because those two copies can never be deduped
(#508), exporting both is a **live+import double count** today. Excluding the unlabeled
live copy removes it, while the imported copy — which carries a `.codex` label from
`discoverCodexHomes` and is 96.1% of openai traffic — exports normally under the #5
default. Residual loss is the live-only fraction, ~3.9% of openai ≈ 0.5% of all turns,
and it does **not** heal. §6's T8 pins this; before the review, no test covered openai.

## 5. Implementation sites

| Path | Site | Change |
|---|---|---|
| Field | `server/entry.js` | `configDir` appended **last** + `OMIT_IF_NULL` (ADR 0012/0013 add-only shape) |
| Shared helper | new `server/config-dir.js` | `realpath(<root>/projects)` then take the parent — **the home dir itself is not a symlink, so canonicalizing it resolves nothing**; `parseConfigDirAllowlist(raw, home)` must canonicalize the same way or an operator-listed alias never matches. Realpath cached per input |
| Sniff | `server/store.js:443-476` | return the canonical path; `cacheConfigDir` latches on disagreement and returns null |
| Live anthropic | `server/forward.js` SSE / non-SSE | `entry.configDir = sessionMeta[sid]?.configDir` |
| Live authoritative | `server/providers.js` `createLaunch` + `forward.js` | inject `X-Ccxray-Config-Dir` alongside the existing `X-Ccxray-Auth`, priority over the sniff; `internal-headers.js` prefix deny keeps it off the wire to Anthropic |
| Importer | `server/importer.js:31-82`, `:204`/`:327` | `discoverHomes`/`discoverCodexHomes` return `{dir, configDir}` |
| Merge | `export-sync.js` `mergeEntry` | carry `_configDirs` (Set union) |
| Predicate | `export-sync.js` second pass (`:429` region) | §3 group predicate + `excludedByDir` / `excludedUnlabeled` counters |
| Default | `export-sync.js:869` | `'.claude,.config/claude,.codex'` |
| Startup signal | `export-sync.js:987-990` | print the resolved allowlist and the unlabeled policy |
| **BQ, first** | `ccxray-ops/bq/01-…json` | add the two counter columns before the exporter ships them — `ignoreUnknownValues: true` drops them silently otherwise |

## 6. Tests (hermetic, differential)

`flushExport()` gains no new ambient input, so the 50 existing call sites stay hermetic.

| # | Test | Why it fails on old code |
|---|---|---|
| T1 | Importer labels `.claude-personal`; allowlist `.claude` ⇒ 0 turns | old: no label ⇒ included |
| T1b | Same fixture, allowlist `.claude-personal` ⇒ uploaded | guards against a vacuous "drops everything" pass |
| T2 | Live sniff writes a canonical `configDir` | old: key absent |
| T3 | **Group predicate**: same responseId, allowed + disallowed ⇒ whole group excluded | old: both included |
| T4 | Header label beats the sniff, and survives a sniff miss | old: no such path |
| T5 | Symlink: two homes, one physical store ⇒ one label | old: scan-order dependent |
| T6 | Floor untouched: cursor `cutoffDt` unchanged after flush | `3f07bb1` regression guard |
| T7 | Conflict latch ⇒ null ⇒ group excluded | old: no latch |
| T8 | **openai**: unlabeled live openai line excluded; `.codex`-labeled imported line exported; assert they are NOT treated as one group | old: both included (double count) |
| T9 | **Cross-path symlink**: the live sniff path and the importer path over the same physical store must yield the SAME label (T5 covers only the importer side) | old: two different labels ⇒ group excluded under §3 |

## 7. Known limitations (accepted)

- **Same-day pre-deploy imported turns are dropped permanently** (`existingIds` blocks
  the labeled re-append). Bounded to one UTC day, direction undercount, counter-visible.
- **Sessions not launched via `ccxray <agent>`** have no authoritative header and fall
  back to the sniff, which matches an obs-fragile marker string (`store.js:444`). If a
  Claude Code release changes that text those turns become unlabeled and are excluded.
  Worth a row in `docs/wire-protocol-reference.md`.
- **The codex ChatGPT-OAuth launch path injects no headers at all.** `providers.js`
  adds `http_headers` only on the `OPENAI_API_KEY` branch; the OAuth branch returns with
  none. So the §2#7 authoritative label does not cover the common codex mode, which
  compounds §4a: live codex has neither a header nor a Claude-marker to sniff, and is
  therefore always unlabeled.
- **Account indistinguishability untouched** (#549). Allowing a physical store allows
  every account writing into it. This design does not foreclose a later account field.
- **On the owner's own machine the allowlist stays all-or-nothing**, because
  `.claude-work` and `.claude-personal` are one store. Its value is on the other 37
  machines, which are unmeasured.

## 8. Not doing

- No account/identity field (#549).
- No rebuild-index backfill in v1.
- No `configDir` in the GCS payload — only the two aggregate counters cross the boundary.
- No weakening of the `3f07bb1` date floor, and no cursor reset to recover excluded lines.
- No fail-open fallback when the allowlist is empty or malformed.
- No third literal directory set — one shared helper or nothing.
