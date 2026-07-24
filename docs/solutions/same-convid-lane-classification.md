# same-convId lane classification — coreHash-authoritative per-conversation ownership (#350)

Companion to ADR 0010 (which this rewrites for the batch path). This file holds
the rule, the trade-offs, and the real-data evidence; ADR 0010 holds the
contract and the three-layer guard references.

## The bug (#350, two symptoms, one cause)

The swimlane view mis-classified a single conversation (`convId`, the hash of
`messages[0]`) in two complementary ways, both traced to the old ADR 0010
routing being **per turn + incremental `mainConvIds`**:

- **(a) scatter** — one 74-turn Fable-5 subagent conversation (`add88512` in
  real session `4b15c248`) split across `main`(48) + `agent-orchestrator:add88512`
  "Teammate"(25) + `parallel-fable-5:add88512` "Fork"(1).
- **(b) subagent leak into main** — `4b15c248`'s 291-turn "main" lane was
  `85771b`×193 (real orchestrator) + `null`×51 + **`86e2ea`×47 (the Fable
  subagent)**. ~16% of "main" was a subagent.

**Seed mechanism.** The first `add88512` turn carries `coreHash=85771b`
(== the parent orchestrator's, inherited across the spawn/fork boundary) even
though it is a subagent. The old per-turn check `coreHash !== mainCoreHash` is
therefore false for it → it lands in main → registers `add88512` into
`mainConvIds` → every later `86e2ea` turn then fails `!mainConvIds.has(convId)`
→ also stays main. A single anomalous turn poisons the whole conversation's
placement.

## The rule (batch: `_wfComputeConvIdentity` + `wfInferLanes`)

Ownership is per **conversation**, decided by its majority, so the seed turn is
a minority that cannot flip it.

1. **`convMaxHashes(convId)`** = the plurality-tied coreHashes — the set of
   non-null coreHashes sharing the maximum count over the conversation's
   lane-eligible turns (usually one). `add88512` = 73×`86e2ea` + 1×`85771b`
   → max-count `{86e2ea}`; the lone orchestrator-coreHash seed turn is not
   max-count, so it is outvoted.
2. **`mainCoreHashSet`** = the dominant coreHash of the **seed** conversation —
   the earliest-**starting** lane-eligible main-agentKey conversation that
   carries a coreHash (keyed on the conversation's earliest main turn, convId
   tie-break; a null `receivedAt` sorts last so a mid-session subagent seed can
   never win, and a subagent cannot seize the seed when main opens coreHash-less
   — codex R2). A `Set` for parity/API stability; in practice the trunk's single
   identity hash (see "why single-valued is safe" below).
3. **ownership → lane**:
   - any of `convMaxHashes(convId)` ∈ `mainCoreHashSet` → main candidate (whole
     conversation), then the ADR 0008 overlap sweep splits genuine parallel
     forks out. Keying on the tied **set** means a genuine A/B tie whose A is
     main's stays main — a `/model`-switching compaction successor is not
     ejected (codex R2).
   - plurality non-null, none ∈ set → **one** identity lane
     `agent-<agentKey>:<convId>` for the whole conversation, seed turn included.
   - no coreHash (legacy / no convId / all-null coreHash) → the pre-existing
     agentKey/fallback path, unchanged.

This one rule fixes both (a) (the whole conversation lands in one lane) and (b)
(a foreign-majority conversation cannot leak any turn into main), and makes the
`#218/#219` coreHash-blip immune for free (a blip is a single minority turn).

## Trade-offs and design decisions

### Why single-valued `mainCoreHashSet` is safe (per-conversation routing)

The issue's draft required a *multi-valued* set so a main `/model` switch
(opus-4-6 `85771b` → opus-4-8 `07024d`) would keep BOTH coreHashes "main". That
requirement was written against **per-turn** routing. Under **per-conversation**
routing it is unnecessary: a `/model` switch keeps `messages[0]` (hence the
convId), so the mixed conversation is *one* conversation and rides main as a
unit by its dominant — its opus-4-8 turns never need `07024d` in the set.

Adding the secondary coreHashes of a main conversation to the set is not just
unnecessary, it is *harmful*: a coreHash appearing inside main is **not** proof
that a *separate* conversation carrying it is also main.

- Real session `c6e1ddaa`: main conv `9f15483a` contains 72 turns @`7852d4`; a
  **separate** 94-turn conv `94226b7d` is also @`7852d4` but is a subagent.
  Adding `7852d4` to the set from the mixed main conv wrongly absorbs the 94
  turns (over-merge, verified +91 leak with the multi-valued variant).
- Real session `1abda99a`: a **1-turn** `30d4e3` blip inside the main
  conversation would, under an "add every coreHash ≥ 1" rule, pull a separate
  31-turn subagent into main.

So the set carries only the trunk's own identity hash. Compaction keeps the
successor conversation's dominant coreHash unchanged (same system prompt,
`messages[0]`→summary only), so it stays main with no set growth needed.

### Why NOT the ADR 0009 seq trunk (the mechanism the issue proposed)

Deriving the set from the seq tracker's trunk convs fails the acceptance
session. A subagent conversation that runs at the **session tail** (the trunk
convId never reappears after it) is indistinguishable from a compaction to the
seq bracketing → it stays in the trunk → its coreHash enters the set. `add88512`
is precisely the final run of `4b15c248` (verified: no `2d1e4478` run follows
it), so a seq-trunk set re-absorbs it into main. coreHash continuity has no tail
blind spot — `add88512`'s dominant `86e2ea` is novel, so it is never main
regardless of temporal position. This is an evidence-backed deviation from the
issue's prose in favour of the issue's *acceptance*.

### Known limitations (accepted, bounded — zero real-corpus harm, codex R1–R3)

- **Minority-shared-hash compaction successor**: a successor whose only
  shared-with-main hash is a *minority* (not plurality-tied) is ejected. It is
  structurally identical to add88512 (minority inherited + majority own), which
  we deliberately eject — no rule keeps one without re-absorbing the other. Same
  class as ADR 0009's rewind-across-compaction.
- **Two-turn 1-1 tie**: a conversation of exactly one inherited-main-hash turn +
  one own-hash turn is a genuine `{A,B}` tie and resolves toward main. Real
  subagents carry many own-hash turns (add88512: 73), so their own hash is the
  clear plurality; the 1-1 case is a synthetic tail edge, and leaning main
  avoids ejecting genuine `/model` continuations.
- **Null-convId main turns** (legacy/imported data) carry no conversation
  identity, so they cannot seed or be identity-routed — they fall to the
  pre-existing agentKey/fallback path, as before this change.
- **Ambiguous sessions with no clean `msg=1` main** (mostly imported ghosts;
  e.g. `1a71530a`) → the seed is whichever conversation starts earliest (convId
  tie-break for determinism); both candidate conversations remain represented
  (one main, one identity), so no conversation is lost — a relabelling within
  inherent ambiguity.
- **A1 scope**: batch (`wfInferLanes`) only. See ADR 0010 "A1/A2 boundary".

## Evidence (docs/verification-principles.md)

- **fail-on-old / pass-on-new** — `test/workflow-timeline.test.js`, `#350`
  suite: a seed turn carrying main's coreHash at the session tail. Old code:
  the conversation leaks into main. New code: one identity lane. (Plus two
  must-not-regress guards: blip immunity, within-conversation `/model`.)
- **Full-corpus real-JS replay** — 426 multi-coreHash sessions in the local
  `~/.ccxray` (299k index lines), running the actual `wfInferLanes` old vs new:

  | metric | OLD | NEW |
  |---|---|---|
  | coreHash-leak residual (main turns whose conversation's dominant coreHash is foreign) | 784 | **61 (−92%)** |
  | sessions where the leak *increased* (over-merge regression) | — | **0** |
  | null-convId non-main lanes (aggregate) | 741 | **741 (delta 0)** |
  | distinct non-main convIds (aggregate) | 2196 | 2192 (−4, single-turn null-coreHash overlap artifacts) |

- **`4b15c248` acceptance** — `add88512` 3 lanes → **1**
  (`agent-orchestrator:add88512`, 74 turns); main `86e2ea` 47 → **0**, main
  coreHash pure `85771b`. Cross/null-convId lane guard holds (the only lane
  removed is the redundant same-convId `parallel-fable-5:add88512` fragment).
- **Browser render smoke** — isolated port + `CCXRAY_HOME`, headless Chrome:
  `wfInferLanes` on the real fixture yields the consolidated lane, and
  `wfBuildState` + `wfRenderTimeline` execute with no thrown error and no
  uncaught JS error.

## Guard (three layers)

- **code**: `INVARIANT` comments at `_wfComputeConvIdentity` and the
  `wfInferLanes` main-agentKey routing branch name ADR 0010.
- **CLAUDE.md**: the invariants list references this rewrite.
- **ADR**: `docs/decisions/0010-corehash-identity-routing.md` "## Rewritten by
  #350".
