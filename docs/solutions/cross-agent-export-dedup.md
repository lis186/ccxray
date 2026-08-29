# Cross-agent_id duplicate counting in the GCS export — design, for sign-off

- Status: **owner sign-off 2026-08-26 on all five decisions (§6). Not implemented.**
- Date: 2026-08-26
- Scope: the same-day, cross-`agent_id` residue only. The historical whole-index
  re-upload defect is already fixed by `3f07bb1` (permanent no-backfill date floor)
  and is not revisited here.
- Method: two independent proposals (fork A, fork B) written to one brief, then
  cross-attacked source-blinded, then every enumeration, number, and SQL claim in
  both re-verified — against source for code, and **against the live BigQuery dataset
  and GCS bucket** for data and SQL validity.
- **Three claims were asserted confidently by an attacker or by me and turned out to
  be false.** They are corrected in place and labelled, because the corrections
  change the design: §5.4 (two "blocker" SQL claims, both wrong), §4 (my own
  three-state proposal, which real data shows degenerates).

## 0. The defect

The same logical traffic can be observed and exported by more than one ccxray home
under more than one `agent_id`. Each exporter uploads its own `daily` row for
(`agent_id`, `dt`). `daily_latest` dedups only WITHIN an agent
(`ROW_NUMBER() OVER (PARTITION BY s.agent_id, s.dt ORDER BY s.upload_seq DESC)`,
`bq/02-daily_latest.sql:11`, **confirmed identical in the live view**), so summing
`cost_total` across agents double-counts.

Measured on the live bucket (§1.5): the over-count is **1.329×**, i.e. the reported
figure is 32.9% too high.

`test/export-cross-agent-dup.test.js` reproduces it deterministically. Note what its
second assertion does and does not establish: `sessionDedupTotal`
(`test/export-cross-agent-dup.test.js:160`) folds with
`bySession.set(r.session_id, r.cost_total)` — **last writer wins, in upload order**.
That recovers the true total only because the fixture's two copies are identical. It
is a contract test for "session rows carry a key that CAN dedup", not evidence that
any picking rule is safe. Real shards are usually *not* identical (§1.5).

## 1. Verified fact base

### 1.1 Corrections to the briefing premises

| Briefing premise | Correction |
|---|---|
| "session rows lack provenance, so BQ cannot tell an explicit id from a sentinel" | The datum is already **on disk**: `sessionInferred` is in `INDEX_FIELDS` (`server/entry.js:5`), as are `imported` and `importSource`. What is missing is **propagation** into the exported session object (`server/export-sync.js:623-639`). A propagation change, not a new capture. |
| "two sentinel literals (`direct-api`, `codex-raw`)" | **Four, and growing.** `server/providers.js:311-317` `listRawSessionBuckets()` = `{direct-api, codex-raw, unknown}` ∪ every `OPENAI_WIRE_CLIENTS[].rawSessionId` (currently adds `grok-raw`, `providers.js:131`). A **second, narrower** set already exists — `SENTINEL_SESSIONS = new Set(['direct-api'])` at `server/helpers.js:1123`, scoped to star retention. A design that hand-rolls a third literal set is drift. |
| (my own briefing error) `getAgentId()` at `export-sync.js:86-93` | It is at **`export-sync.js:79-93`**. Both proposers cited 79 correctly, so neither was misled. |

### 1.2 Measured on the real local index

296,169 raw lines with an id and a sessionId; 265,297 after responseId dedup;
$80,138.34 total cost.

| Measurement | Value | Why it matters |
|---|---|---|
| Sentinel session ids | 10 turns (0.004%), $0.01 | See §1.5 for the bucket-side figure, which is the one that matters. |
| `sessionInferred === true` | 50 turns (0.02%), $0.01 | Same order. |
| `imported === true` | 224,943 / 265,297 = **84.8%** | The dominant duplication mechanism is importer replay of the same `~/.claude` transcripts into each home. |
| Within-home responseId duplicates | 296,169 → 265,297 = **10.4%** | Duplication is not only cross-agent; #329's importer×proxy overlap is already live in one home. |
| Sessions mixing imported + proxy turns | 69 / 4,656 = **1.48%** | Mutual incompleteness between homes is structurally possible, confirming C3. |
| `receivedAt` coverage | 295,901 / 296,169 = **99.9%**; 268 lack it | `dt` comes from `receivedAt` (true UTC) when present, else from slicing `entry.id` (`export-sync.js:297-303`). |
| `idDt ≠ receivedAtDt` among those having it | 2.20% (6,521) | Sizes the hazard the fallback path carries if exercised: the live id is minted in hardcoded `Asia/Taipei` (`helpers.js:6-11`), the importer's in UTC (`importer.js:21-25`). |
| `receivedAt` ties within a (dt, session) shard | 2.56% of shards (130/5,083) | Bounds an order-dependence exposure — §5.2. |

### 1.3 responseId coverage — not the cliff it looks like

| provider | turns | with `responseId` | coverage |
|---|---|---|---|
| anthropic | 256,884 | 95,273 | 37.1% |
| openai | 39,254 | 0 | 0.0% |

Split by the turn's date and origin:

| bucket | turns | share |
|---|---|---|
| imported / pre-#333 / **no** rid | 153,130 | 59.6% |
| imported / post-#333 / rid | 54,009 | 21.0% |
| proxy / post-#333 / rid | 41,274 | 16.1% |
| imported / post-#333 / no rid | 4,812 | 1.9% |
| proxy / post-#333 / no rid | 3,669 | 1.4% |

The 59.6% is historical and `3f07bb1`'s date floor already excludes it from export.
**For the traffic the exporter will actually ship, anthropic responseId coverage is
95,283 / 103,764 = 91.8%.** openai stays 0%, but openai is excluded from the money
column by `06-reported-views.sql` and counted as `excluded_self_funded_turns`, so its
dedup quality affects the omission markers and `sessions_flagged`, not the dollar
figure.

### 1.4 Cross-home turn identity is layered, not binary

| duplication shape | stable cross-home key? | why |
|---|---|---|
| import ↔ import (dominant) | **yes**, both `responseId` and `entry.id` | `responseId = msg.id` from the transcript (`importer.js:196,216`); `entry.id = tsToId(obj.timestamp)` (`importer.js:21-25,171`) is deterministic in the transcript's own timestamp |
| live proxy ↔ import, post-#333 | **responseId only** | the live id is `helpers.timestamp()` (`server/index.js:291` → `helpers.js:6-11`), the observer's own clock in hardcoded `Asia/Taipei`; the importer's is UTC. The two id strings can never coincide for one turn |
| live proxy ↔ import, no responseId | **no key at all** | 1.4% (anthropic) + 3.9% (openai) of go-forward traffic |
| openai, imported | `entry.id` only | 37,712 / 39,254 = **96.1%** of openai traffic is imported from codex transcripts |
| openai, live proxy | none | 1,542 turns (3.9%) |

### 1.5 Live bucket ground truth — the section that decided the design

Queried directly against `uxo-dev.ccxray` on 2026-08-26.

| Measurement | Value |
|---|---|
| distinct `agent_id` | **177** |
| distinct `user_email` | **2** |
| dt range | 2026-03-01 … 2026-08-26 (129 dts) |
| sentinel session rows | 176 rows, 3 sids, **$0.217**, 275 turns |
| real session rows | 20,034 rows, 4,701 sids, $222,298, 928,755 turns |
| **sentinel share of session cost** | **0.0001%** |

Via `sessions_latest` (which applies the per-agent-latest filter through the
`summary_id` join):

| | cost | rows |
|---|---|---|
| naive (sum every session row) | **$107,379.53** | 11,189 |
| deduped by (`dt`, `session_id`), `MAX(cost_total)` | **$80,772.41** | 5,168 |
| **inflation** | **1.329×** | |

**Independent corroboration:** $80,772.41 from the BQ cross-agent dedup lands within
**0.8%** of $80,138.34 from the responseId dedup over the raw local index (§1.2) —
two unrelated methods over different inputs. The residual is consistent with the
bucket carrying a second `user_email`. This is the strongest evidence available that
the true figure is ≈$80K and that a session-level cross-agent dedup recovers it.

**Shard divergence, over the same 5,168 (`dt`, `session_id`) groups:**

| | groups | share |
|---|---|---|
| more than one shard | 4,942 | **95.6%** |
| shards disagree on `turn_count` (⇒ different turn sets) | 2,436 | **47.1%** |
| same `turn_count`, different `cost_total` (⇒ pricing divergence) | 1,806 | **34.9%** |
| **either** (what an equality gate would reject) | **4,242** | **82.1%** |
| money carried by the divergent groups | **$72,967 / $80,772** | **90.3%** |

**177 agent_ids for 2 emails** is F9 at full scale: every fresh `CCXRAY_HOME` mints a
new `agent_id`, so `agent_id` is not a person key and never was. `user_email` is the
only person key present, and it is self-asserted.

### 1.6 Live-vs-repo DDL drift: currently none, in the documented direction

`daily_latest`, `sessions_latest`, and `daily_reported` were dumped from the live
dataset and match `bq/02`, `bq/04`, and `bq/05` in body (`bq show` strips OPTIONS).
The historical drift warning is real but **not currently in effect**. Drift exists in
the *other* direction: the live dataset carries `events` (EXTERNAL) and
`events_dedup` (VIEW) with no counterpart in `bq/` — #504 leftovers that should be
either documented or dropped.

### 1.7 SQL validity: both "blocker" claims were false

Verified by `--dry_run` **and** by execution against the live dataset:

| Construct | Claimed | Actual |
|---|---|---|
| `COUNT(DISTINCT x) OVER (PARTITION BY …)` (fork A) | A's attacker: invalid, "**certain**", with a doc citation — and **I agreed** | **Valid.** A's exact canonical shape, with `ROW_NUMBER()` and two `COUNT(DISTINCT … ) OVER` in one subquery, both dry-runs and *executes*, returning rows. |
| `SELECT * FROM t QUALIFY ROW_NUMBER() OVER (…) = 1` with no `WHERE` (fork B) | B's attacker: rejected, "~90% certain", `WHERE TRUE` needed | **Valid.** Dry-runs clean. |
| BigQuery JSON key canonicalization (my open question against B) | unknown | **Canonicalizes.** `TO_JSON_STRING(JSON '{"b":1,"a":2}')` = `TO_JSON_STRING(JSON '{"a":2,"b":1}')` = `{"a":2,"b":1}`. So model-key insertion order cannot fake a fingerprint mismatch. |

Neither fork's SQL is broken. Both attackers reached for a confident SQL blocker and
neither had one; I propagated one of them. This is the round's clearest lesson: a
cited doc is not a dry-run.

## 2. Decision table

| # | Question | Fork A | Fork B | Taken | Rationale |
|---|---|---|---|---|---|
| 1 | Detect that two shards differ | `response_id_count` (a **count**) | `turn_set_hash` (a **set hash**) + `turn_set_basis` | **B's instrument, keyed on integers only** | A count cannot distinguish "identical" from "disjoint, same size" — two 3-turn disjoint views tie and merge silently, and A's `agent_span > 1` only says dedup happened, never that shards disagreed. B's hash is the right instrument. But B's *fingerprint* also includes `cost_total`, a **local derivation**, and §1.5 measures 34.9% of groups as same-turn-count-different-cost. Compare turn set + provider-assigned token counts; never cost. |
| 2 | What to do when shards disagree | pick the most complete | money `NULL` + conflict counters | **A's policy — see §4** | §1.5 settles this empirically. B's equality gate would reject 82.1% of groups carrying **90.3% of the money**: not a safeguard, a loss of the metric. A's pick yields $80,772, within 0.8% of the independently derived figure. My own three-state alternative degenerates for the same reason and is withdrawn (§4). |
| 3 | Sentinel disambiguation | salt with `agent_id` | HMAC with a new random salt file outside `CCXRAY_HOME` | **neither — do not merge sentinels (§3)** | Bucket-measured, sentinel sessions are **$0.217 of $222,298 = 0.0001%**. Both machineries are disproportionate and each has a failure mode: A's salt is `CCXRAY_AGENT_ID`-first, hence user-settable and shareable; B's introduces a file `CCXRAY_HOME` does not isolate, breaking 50 existing test call sites. |
| 4 | Sentinel set source | `listRawSessionBuckets()` | `listRawSessionBuckets()` | **agreed** | Both refused to mint a third literal set (§1.1). |
| 5 | Provenance fields | counts | booleans + `import_sources` | **both, but only after fixing `mergeEntry`** | `mergeEntry` (`export-sync.js:356-382`) starts from `{...a}` and its fill list (`:368-372`) omits `imported`/`importSource`, so imported-derived fields are **first-seen-wins** and order-dependent across homes. B anticipated this; A did not. |
| 6 | Money source for the headline | session `models{}` fold | resolved session `models{}` fold | **agreed** | Session rows cannot otherwise reconstruct vendor scoping: the money path is `daily_latest.models` → `daily_models` → `daily_models_reported` (`bq/03`, `bq/06`), and session rows carry no per-model token breakdown today. |
| 7 | ADR 0017 confidence fold | absent from the session `models{}` | `fallback_cost`, `fallback_count`, `unknown_count` per model | **B** | The daily bucket literal (`export-sync.js:507`) has no confidence counters. Copying that shape onto session rows would let a fabricated total render unmarked. With 34.9% of groups showing pricing divergence (§1.5), this is load-bearing, not hygiene. |
| 8 | `flags` across agents | recompute in BQ; `credential_leak` = OR; `high_cost` absolute arm only | no flags on the deduped path | **B's separation, A's `high_cost` reasoning** | A's OR is right in principle but composes with a shared `agent_id` into cross-person transfer (§5.3). A's `high_cost` diagnosis is correct regardless: the relative arm's denominator is the exporter's own per-agent daily average (`export-sync.js:776-778`), which post-dedup describes a fragment nobody looks at. |
| 9 | Person dimension on the deduped money | keep; grain → (`dt`, `user_email`, `team`) | **remove** | **owner decision — §6.1** | §1.5 sharpens this: `agent_id` is not a person key (177 for 2 emails), so `user_email` is the *only* person key — self-asserted, on a shared-write bucket. |
| 10 | F7 distribution fields | per-agent, labelled | per-agent, labelled | **agreed** | Neither can heal them without turn-level export, which both correctly reject. |
| 11 | SQL shape | `COUNT(DISTINCT …) OVER` in a window | `GROUP BY` CTE + `QUALIFY` | **either; prefer B's shape** | **Both are valid** — §1.7 corrects two false blocker claims. Prefer B's grouped-then-joined shape anyway: it is what A's own attacker recommended for A, and it keeps span computation separate from row selection, which §5.3 wants. |
| 12 | Schema version gate | bump to 2, views gate `>= 2` | bump to 2, views gate `>= 2` | **agreed** | No current view filters `_summary_schema_version`; it exists only in the external table (`bq/01:12`). `ignoreUnknownValues: true` (`bq/01:8`) silently drops new fields until `01` is updated, so the external-table update must precede any view reading them. |

## 3. Sentinel sessions: the machinery is disproportionate to the risk

Both forks built a mechanism to merge sentinel traffic across one person's homes while
keeping people apart. Bucket-measured, that merge is worth **$0.217 of $222,298
(0.0001%)** across 176 rows and 3 distinct sids. Each mechanism buys it at a real
cost:

- **A's salt is `agent_id`**, and `getAgentId()` (`export-sync.js:79-82`) reads
  `CCXRAY_AGENT_ID` **first** — user-settable, therefore shareable. And
  `docs/herdr-ccxray-plugin-research.md:168` already proposes exactly that:
  `CCXRAY_AGENT_ID=herdr:<pane_id>`. Pane ids are not unique across people, so if that
  plan ships, A's sentinel keys merge across people — the C1 failure the salt exists
  to prevent. (Adjacent and worth a separate decision: the same plan would make
  `daily_latest`'s `PARTITION BY (agent_id, dt)` collapse two people's dailies,
  last-writer-wins.)
- **B's salt is a new 32-byte random file at `~/.ccxray-export-identity-salt`, outside
  `CCXRAY_HOME`** — the ADR 0015 R4 failure class by construction. Counted, not
  estimated: it would de-hermeticize **50 existing call sites** (46 `flushExport()`
  calls in `test/export-sync.test.js` plus 4 in `test/export-cross-agent-dup.test.js`),
  none of which set `CCXRAY_EXPORT_ID_SALT_FILE`, in a file carrying only 4
  `CCXRAY_HOME` references. B's own tests set the override; B says nothing about
  retrofitting the suite. (B's attacker put this at "≈20"; the real figure is more than
  double.)

**Taken instead:** sentinel session rows are **never merged across agents** and are
**excluded from the deduped money figure, with their cost and turn count on a separate
labelled line** (ADR 0017: count the omission, never silently drop). No salt, no new
secret file, and — decisively — **no trust in `agent_id`**, which §1.5's 177-for-2
finding shows is unwarranted anyway. Cost: under-reporting $0.22.

`session_id_kind` is still exported, because it is what lets the view do this.

## 4. The partial-view question — A's policy, and the withdrawal of my alternative

An earlier revision of this document proposed a three-state design: `agreed` →
report the value, `divergent` → report `MAX(cost_total)` marked as a lower bound,
`excluded` → sentinels. **§1.5 withdraws it**, and for the same reason it rules out
fork B.

The measurement: 82.1% of (`dt`, `session_id`) groups have shards that disagree on
turn count or on cost, and those groups carry 90.3% of the money. So:

- **Fork B's equality gate would NULL 90% of the money.** Not conservative — the
  metric is gone. §5.1 called this "blanks the current day"; that was far too mild.
- **My three-state design would mark 90% of rows as lower bounds.** By ADR 0017's own
  reasoning a marker that always fires carries no information, and marking
  near-everything is exactly the worst-of pattern ADR 0017 rejected 3/3/3. It
  degenerates into fork A's answer plus noise.
- **Fork A's policy — pick the most complete shard — is empirically vindicated.** It
  yields $80,772.41, within 0.8% of the figure derived independently from the raw
  local index. That is the closest thing to ground truth available.

**Taken:** fork A's policy, with three amendments the measurements force.

1. **Selection key must not be `response_id_count`.** Coverage is 91.8% for
   go-forward anthropic traffic but 0% for openai (§1.3), so the key degrades to a
   tiebreak on 13% of traffic. Order by turn-set size derived from B's
   `turn_set_hash` basis, falling back to `turn_count`.
2. **The divergence signal is reported as an aggregate, not a per-row marker.** One
   coverage figure — "N of M session-days had disagreeing observations" — next to the
   headline. This is the ADR 0017-consistent form: the marker stays scarce and
   therefore informative, and the continuous detail lives in a place a reader can go
   look.
3. **The merge/comparison test must exclude cost.** Token counts
   (`input`/`output`/`cache_read`/`cache_creation`) are provider-assigned and identical
   across observers of one turn; cost is derived locally from a possibly-cold
   `pricing-cache.json`. §1.5's 34.9% same-turns-different-cost groups are the direct
   evidence. Cost is a value to reconcile, never a merge key. This also disposes of
   §5.2's float-tie concern.

What A's policy honestly costs: on genuinely disjoint shards it under-counts, because
one shard is reported rather than the union. §1.5 cannot separate "disjoint" from
"nested" without turn sets — which is precisely what shipping `turn_set_hash` (and,
if ever needed, a compact per-turn digest) would let a later round measure. The
direction is under-count, which is the safe direction, and it is 32.9 points better
than today.

## 5. Failure scenarios that survived verification

Severity ratings are mine.

### 5.1 B's equality gate destroys the metric — **fatal**
Superseded in magnitude by §1.5: not "blanks the current day" but 82.1% of groups /
90.3% of money. Severity: **fatal to fork B's policy**.

### 5.2 Float ties in an equality fingerprint — **subsumed**
`cost_total` is a float accumulation ordered by `export-sync.js:415`
(`sort` on `receivedAt`); ties compare 0 and V8's stable sort preserves each home's
index-file order. Measured exposure: 2.56% of shards. **Subsumed by §4's amendment 3**
(cost leaves the comparison entirely), and dwarfed by the pricing-divergence trigger
(§5.11). The related JSON-key-order worry is **resolved as a non-issue** (§1.7).

### 5.3 A's credential OR + a shared `agent_id` transfers a safety flag across people
`credential_leak_any = LOGICAL_OR(has_cred) OVER (PARTITION BY dt, session_key)` with
`email_span = COUNT(DISTINCT user_email) OVER (…)`, which ignores NULLs, means a
{named, email-less} group shows `attribution_conflict = false` and still ORs the
email-less shard's credential observation onto the named winner. Alone this needs an
explicit-session-UUID collision and is negligible; composed with a shared
`CCXRAY_AGENT_ID` (§3) sentinel keys collide legitimately across people and the OR
fires across them. Note `email_span` returns 0 on raw `summaries` session rows because
they carry no `user_email` — it only works via `sessions_latest`'s daily join.
Severity: **high as a composite**.

### 5.4 Both attackers' SQL blockers were false, and I propagated one
See §1.7. Fork A's `COUNT(DISTINCT …) OVER` executes; fork B's `QUALIFY` without
`WHERE` validates. An earlier revision of this document called A's construct a
deployment blocker on the strength of an attacker's stated certainty plus my own
agreement. Both were wrong. Severity: **none to either fork; a process finding about
this document**.

### 5.5 `dt` disagreement defeats dedup entirely — shared by both
Two observers deriving different `dt` for one turn put their copies in different
partitions, so no key brings them together. Reachable only for turns lacking
`receivedAt` (**268 turns, 0.09%**) that also fall in the 8-hour Taipei/UTC band. Not
a differentiator — both forks key on `dt`. Severity: **low, bounded, shared**.

### 5.6 `mergeEntry` drops `imported` — affects A only
`export-sync.js:356` starts from `{...a}`; the fill list at `:368-372` omits
`imported`/`importSource`. So `imported_turn_count` is first-seen-wins and
order-dependent across homes, invalidating A's "prefer observed-dominant agents"
mitigation as written. B requires the merge change explicitly. Severity: **medium**.

### 5.7 A's `tool_fail_count` is not a new column
`bq/01-summaries-external-table.json:38` already declares it. A's migration step 4
lists it as needing to be added — one of six enumerated items wrong. Severity: **low**,
but it makes the checklist untrustworthy.

### 5.8 A's T4 fail-on-old does not isolate its variable
T4 gates the mirror on `_summary_schema_version >= 2`, so on old code the input is
empty and assertions fail because there are **zero rows**, not because the picking rule
is absent. Without that gate, `turn_count` alone already selects the 4-turn shard, so
the assertions would **pass** on old code. No genuine fail-on-old evidence for
`response_id_count`. Severity: **high for the verification plan** — the "fail-on-old
for an unrelated reason" trap, which any test for the taken design must avoid.

### 5.9 B's `daily_reported` rewrite has no stated grain, and one reading resurrects the defect
`05-daily_reported.sql` is one row per (`agent_id`, `user_email`, `team`, `dt`,
`local_date`, `tz`) — `GROUP BY` at `:41`, session sub-CTE at `:49`, **confirmed
identical live**. Cross-agent deduped money has no `agent_id`. B never states the
resulting grain. Either the view becomes per-`dt` (breaking Looker bindings grouped by
`user_email`), or the deduped money is joined back onto per-agent rows, where any `SUM`
across agents **re-double-counts the exact defect being fixed**. Severity:
**medium-high, by omission**. Fix: split the view — money per-dt in its own view,
distributions in the existing per-agent one — so the wrong join is not expressible.

### 5.10 B conflicts *permanently* when a home dies mid-day
A re-homed machine mints a new `agent_id` (§1.5: 177 of them). Old home uploads a
partial shard and never runs again; new home uploads the complete one. Turn sets
differ, the stale agent never corrects, so the group stays conflicted forever and that
session-day's money is `NULL` permanently even though one copy is a provable superset.
Severity: **medium-high** — and given §1.5's divergence rates, this is the common case,
not an edge.

### 5.11 Pricing divergence — confirmed at 34.9% of groups
B's gate includes `cost_total` and `cost_confidence`. A fresh home imports the same
transcripts with a cold `pricing-cache.json` and prices `fallback` where the
established home priced `exact`: identical turn sets, different fingerprints, conflict.
**§1.5 measures this directly: 1,806 groups (34.9%) have identical `turn_count` and
different `cost_total`.** §4's amendment 3 is the fix. Severity: **high, and the reason
cost can never be a merge key**.

### 5.12 B's v1 stragglers are invisible to both the headline and the coverage columns
`normalized` filters `_summary_schema_version >= 2`; a post-wipe v1 writer's sessions
are neither resolved nor conflicted, and no column counts them, so B's migration step 2
has no data-side check. Severity: **low-medium**. Carry a `v1_row_count` metric.

## 6. Owner decisions — **signed off 2026-08-26**

### 6.1 Person dimension on the deduped money — **KEEP** (primary)

The deduped money view keeps `user_email` and `team`. Grain is
(`dt`, `user_email`, `team`) — `agent_id` leaves the money view, the person stays.

Three obligations follow, and none of them existed before this choice:

1. **The winner shard's `user_email` owns the session-day.** §4's selection rule
   (most complete shard, ordered by turn-set size then `turn_count`) already picks one
   shard per (`dt`, `session_id`); attribution rides that same winner. No separate
   rule, and specifically no "prefer the shard that has an email" — that would let a
   less complete observation decide who pays.
2. **`attribution_conflict` becomes mandatory, not optional.** A group carrying more
   than one distinct non-NULL `user_email` must be counted. §5.3's warning stands:
   `COUNT(DISTINCT user_email)` ignores NULLs, so a {named, email-less} pair reports
   `1` and looks clean. The counter must therefore be over non-NULL emails **and** the
   conflict tally reported next to the coverage figure from §6.2 — same aggregate
   line, same reasoning about marker scarcity.
3. **The self-asserted-email risk is now load-bearing and must be disclosed.**
   `CCXRAY_USER_EMAIL` is an env var on a bucket every laptop can write to. A
   wholesale mis-set silently moves one person's money onto another and produces no
   conflict signal at all (the group carries one email — the wrong one). See §6.1.1
   for how this is handled, which is NOT the IAM gate an earlier revision promised.

### 6.1.1 Attribution provenance — **owner decision 2026-08-27: no audit log; make the default correct and label it**

An earlier revision of obligation 3 read "it is what the IAM gate is for, and the
rollout must not present per-person money as verified attribution before that gate."
**That gate is not being built.** GCS Data Access audit logs — the only mechanism that
would make attribution unforgeable, by keying it on the platform-stamped
`principalEmail` rather than on payload content — were evaluated and declined.

Measured while evaluating it (2026-08-27): `auditConfigs` on `uxo-dev` is `NONE`, so no
such record exists today; enabling it needs `resourcemanager.projects.setIamPolicy`,
`logging.sinks.create`, and `logging.privateLogEntries.list`, none of which the owner's
account holds; and the blast radius is small (7-day project-wide `WriteObject` = 1,473,
of which cloudbuild is 3). It was declined on proportionality, not feasibility.

What ships instead, and the honest statement of what it does and does not buy:

**It fixes the real threat and not the theoretical one.** Accidental misconfiguration
across 38 machines — typo, unset var, copied dotfiles — is eliminated by making the
default come from the login identity. Deliberate forgery is not addressed: the exporter
still assembles the payload, so anyone who edits an env var or the code can still assert
someone else's name. That is accepted.

- **Identity resolves from the ADC token, not from a file.** The ADC file's `account`
  key exists but is empty; `https://openidconnect.googleapis.com/v1/userinfo` with the
  token the exporter already holds returns `{email, email_verified, hd}` (verified on
  the owner's machine). `CCXRAY_USER_EMAIL` becomes an override, and **ADC wins on
  conflict**.
- **Never skip an upload over identity.** On userinfo failure, degrade to
  `{email: env || null, source: env ? 'env' : 'unknown'}` and upload. A missing email
  scope is fixed at `gcloud auth application-default login` time and therefore
  *persistent per machine*, so skip-and-retry would mean that machine never exports
  again — the retry loop does not save it. A degraded, labelled row is strictly better
  than today's unlabelled literal.
- **Service-account mode does not call userinfo**, and an SA address never populates
  `user_email` — the dashboard's unit is a named person, and an SA would mint a fake
  one. Ship the authenticated principal as a separate `writer` field instead: keep the
  evidence, derive the judgment (the ADR 0013 lesson). This also answers CI without
  reopening the question.
- **`hd` is not checked.** The email string carries its own domain, so a read-side view
  can filter whenever it cares; and adding a configurable company-domain variable to a
  change whose purpose is removing env-var misconfiguration is self-contradictory.
- **`source` enum: `adc | adc-env-conflict | env | unknown`**, plus `writer`.
  `adc-env-conflict` is the load-bearing member — it is the misconfiguration detector
  firing, and the only channel telling a legitimate on-behalf-of override that its
  intent was discarded.
- **The discarded env value is NOT uploaded** (owner decision). Only the fact of the
  conflict travels; the losing value is printed to the local log. Uploading it would
  put a colleague's address into this person's row — the copied-dotfiles case is
  exactly when it fires — and the person who fixes the machine is sitting at it, while
  the dashboard already has `writer` to say whose machine it is.
- **Caching**: resolve at token acquisition and share `_cachedToken`'s ~1h lifetime.
  Once-per-process is wrong — a hub runs for days, and a mid-process re-auth as a
  different person would keep stamping the old address.
- **Legacy rows carry no `source`; absent means `env`**, so old self-asserted rows are
  never rendered as verified (the `WEATHER_REV` pattern).
- **Winner-shard selection ignores `source` quality** (owner decision) — the extension
  of §4's "do not prefer the shard that has an email". Completeness picks the winner;
  source quality is reported on the aggregate line, not used to pick.

**Disclosure obligation, replacing the withdrawn gate.** Attribution is self-asserted
with a correct default. The reported surfaces must say so — same aggregate line as
§6.2's coverage figure — and this data must not be used for individual evaluation.
That constraint is the substitute for the unforgeability the audit log would have
provided; if per-person money is ever going to drive a decision about a person, this
decision has to be revisited first.

**Two unverified premises, both blocking rollout rather than implementation:**
- The userinfo path is verified on **one** machine (n=1). If the team's standard gcloud
  flow mints tokens without the email scope, the fleet degrades to `env` and this buys
  almost nothing. Check 2–3 colleagues' ADC before rollout.
- `bq/01-summaries-external-table.json` has `ignoreUnknownValues: true`, so
  `user_email_source` and `writer` are silently dropped until that file is updated
  **first** — the same ordering trap as §2 #12.

**This also resolves §5.9**, which was open by omission. The two readings that
worried it were "per-`dt`, breaking Looker bindings" and "join back onto per-agent
rows, re-double-counting". The signed grain is neither: `agent_id` is gone from the
money view so the double-counting join is not expressible, and `user_email` survives
so the existing Looker groupings keep binding. `daily_reported` still splits — money
per (`dt`, `user_email`, `team`) in its own view, distributions in the existing
per-agent one.

§5.3's flag transfer is **separately** closed by decision table #8: no flags on any
cross-agent-merged row. Keeping the person dimension on money does not put them back.

### 6.2 Divergence disclosure — **aggregate coverage line**

One figure beside the headline: "N of M session-days had disagreeing observations",
plus the §6.1 attribution-conflict tally. No per-row marker — it would fire on 90.3%
of the money, which is the always-on shape ADR 0017 rejected 3/3/3.

The honest disclosure that must appear with the headline: **90.3% of the money comes
from session-days where observers disagreed, and the figure reports one observer's
view of each.** A drill-down view was offered and not taken; if the coverage figure
ever prompts "which ones?", that is the moment to build it, not before.

### 6.3 Sentinel sessions — **excluded, on a separate labelled line**

Confirmed. Never merged across agents, never in the deduped money, cost and turn
count on their own labelled line (ADR 0017: count the omission, never silently drop).
Cost: **$0.22 under-reported**. No salt, no new secret file, no trust in `agent_id`.
`session_id_kind` is still exported — it is what lets the view do this.

### 6.4 `CCXRAY_AGENT_ID` — **never a person key; pane ids must be globally unique**

Recorded here and to be written back to `docs/herdr-ccxray-plugin-research.md:168`:

- `agent_id` is a **home identifier**, not a person key. §1.5 measured 177 of them
  for 2 `user_email`s. Nothing in this design may key identity, salt, or attribution
  on it.
- The `agent_id = herdr:<pane_id>` proposal may proceed **only** with a value that is
  globally unique — e.g. `<user>:<host>:<pane_id>`. A bare pane id collides across
  people, and `daily_latest`'s `PARTITION BY (agent_id, dt)` would then fold two
  people's dailies last-writer-wins. That is a data-loss path independent of this
  document's defect, and it would land silently.

### 6.5 Undocumented live BQ objects — **verify unused, then drop**

`events` (EXTERNAL) and `events_dedup` (VIEW) exist live with no `bq/` counterpart
(§1.6) — #504 leftovers superseded by the `summaries` family. Confirm no Looker
tile or saved query reads them, then drop, so the pre-migration drift check has a
clean baseline. Dropping without that check is not authorised by this decision.

## 7. Verification status

All items previously blocked on GCP auth are now **resolved**: live-vs-repo drift
(§1.6), bucket inventory and inflation (§1.5), and all three SQL validity questions
(§1.7). Two attacker claims and one of my own assertions were falsified by that
verification and are corrected in place.

Remaining genuinely unverified:
- Whether a divergent group's shards are **nested or disjoint**. Not answerable from
  the current schema — it needs turn sets, which is what shipping `turn_set_hash`
  enables for a later round. This is the residual uncertainty in §4's under-count.
- Fleet behaviour beyond the 2 emails currently in the bucket.

## 8. Not doing

- No cross-agent daily-row dedup — `upload_seq` is a per-agent cursor value, not
  comparable across agents.
- No summing of overlapping session shards, and no union of two turn sets without
  turn-level evidence.
- No third sentinel literal set — `listRawSessionBuckets()` or nothing.
- No turn-level GCS export (volume, and it moves `cwd`/title/credential surface off the
  machine ahead of the credential-topology gate).
- No exporter-side cross-home dedup state — ADR 0012 scored shared mutable dedup state
  2.5/10; the merge point is the read side.
- No re-litigation of the no-backfill floor (`3f07bb1`).
- No trust upgrade for `agent_id` or `user_email`.
- No `INDEX_FIELDS` additions — propagation only (§1.1).
- No new secret file outside `CCXRAY_HOME` (§3).
- **No cost, or any locally derived value, in a merge key** (§4 amendment 3, §5.11).
  Merge keys are provider-assigned facts only: response ids, transcript timestamps,
  token counts.
- No cross-agent money joined back onto per-agent rows (§5.9).
- No per-row divergence marker on 90% of rows (§4 amendment 2) — ADR 0017's
  marker-scarcity reasoning.
- No classification-path change (ADR 0005 / 0013 boundary untouched; this is all
  summary/display).
