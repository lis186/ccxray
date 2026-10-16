# 0010 — coreHash + convId identity routing for teammate lanes

- Status: Accepted — **batch routing rule REWRITTEN by #350 (2026-07-24), see
  "## Rewritten by #350" below**; the live path (`wfAddEntry`) + turn-list
  (`entry-rendering.js`) keep the original per-turn early-exit as an ACCEPTED
  bounded divergence — see "A1/A2 boundary" below; no open issue tracks a mirror.
- Date: 2026-07-16
- Related: #258 / #257 / #350 / ADR 0005 / ADR 0008

## Context

Teammate agents (dispatched via Claude Code's Agent tool) share
`agentKey='orchestrator'` with the main agent, because their system prompt
starts with the same `"You are an interactive agent"` text that matches the
same `KNOWN_AGENTS` entry server-side (`server/system-prompt.js`). This
routes teammate turns into the main lane by `WF_MAIN_AGENT_KEYS[agentKey]`.

The existing temporal-overlap post-pass (ADR 0008) eventually exiles
teammate turns to a `parallel-` lane, but the `parallel-` best-fit logic has
no jitter tolerance: 8–30ms HTTP pipeline flush jitter between sequential
turns of the *same* teammate conversation splits them across `#1`/`#2`
numbered lanes — a visual bug, confirmed on real data (session `e622e4d2`,
`docs/solutions/corehash-identity-routing.md`).

A signal was going unused: `coreHash` (normalized system-prompt hash)
genuinely differs between main and teammate prompts — they run different
prompts — while forks (which inherit the parent's full prompt) correctly
share `coreHash` with main. `coreHash` alone is not safe to route on: it has
a documented history of mid-session instability (#218 autoMemory marker
regex, #219 platform normalization), so a coreHash divergence that still
shares main's `convId` (conversation identity, hash of `messages[0]`) is
noise, not a new agent.

## Decision

Add a coreHash + convId **early-exit** ahead of the existing
`WF_MAIN_AGENT_KEYS` routing: a turn with a main-agent `agentKey` is routed
to an identity sublane (`agent-<agentKey>:<convId>`, not the `parallel-`
family) iff **all** of the following hold —

- `coreHash` exists and differs from main's `coreHash`
- `convId` exists and is not in main's set of conv IDs

Any missing value (`coreHash` or `convId` null on either side) falls through
to the pre-existing classification path — legacy/incomplete data behaves as
it did before this ADR.

| Scenario | coreHash | convId | Result |
|---|---|---|---|
| Teammate | ≠ main | ∉ main set | → identity sublane |
| Fork | = main | ∈ main set | → main → ADR 0008 overlap |
| Upgrade/noise | ≠ main | ∈ main set | → stays main |
| Compaction | = main | ∉ main set (messages[0] replaced by summary — ADR 0009) | → stays main (coreHash = main dominates) |

**Three-site contract (ADR 0005 shape)** — all three must apply the same
condition, reading from the same computed main identity:

| Site | File | mainCoreHash / mainConvIds source |
|------|------|------|
| Batch pre-scan + routing | `workflow-timeline.js` `wfInferLanes()` | scanned from `entries[]`: coreHash of the earliest-`receivedAt` `WF_MAIN_AGENT_KEYS` entry |
| Live routing | `workflow-timeline.js` `wfAddEntry()` | `wfState.mainCoreHash` / `wfState.mainConvIds`, computed once in `wfBuildState()` from the final main lane (post overlap + seq passes), kept current as new main turns arrive |
| Turn list `isSubagent` | `entry-rendering.js` `addEntry()` | same `wfState.mainCoreHash` / `wfState.mainConvIds`, gated additionally on `wfState.sessionId === sid` — `wfState` reflects only the *currently viewed* session; without this guard, a background session's turns would be classified against the wrong session's main identity |

**Lane key**: identity-routed teammates use `agent-<agentKey>:<convId>`, the
same family as other agentKey-based sublanes — never `parallel-`, which is
reserved for the ADR 0008/0009 overlap/excursion mechanism and carries
jitter-prone best-fit matching that this ADR exists to avoid.

**Display name**: `_wfLaneDispName()` labels an identity-routed lane whose
`agentKey` is a main-agent key as `"Teammate <convId prefix>"`.

## Consequences

**Good**: teammate turns from the same conversation land in one stable lane
regardless of HTTP flush jitter — the `parallel-` best-fit's jitter
sensitivity no longer applies to teammates. Verified on the `e622e4d2`
fixture shape (unit tests in `test/workflow-timeline.test.js`, `#258
coreHash identity routing` suite).

**Bad — scope boundary**: this only fixes teammates (different coreHash).
Forks (same coreHash) still transit through main and rely entirely on ADR
0008's overlap sweep; a hypothetical future fork jitter-split is a separate,
narrower problem (epsilon tuning on the exile best-fit) and is explicitly
out of scope here.

**Bad — coreHash instability remains latent**: the convId AND-guard
prevents a coreHash blip from misrouting a genuine main turn (the blip keeps
main's convId, so it fails the `∉ main set` condition), but if a future
coreHash bug ever changes convId computation itself, this safety net does
not apply. `coreHash` is still not trusted alone anywhere in this codebase.

**Known edge — blip × compaction intersection**: compaction replaces
`messages[0]` with a summary (ADR 0009), producing a new convId not yet in
`mainConvIds`. If a coreHash blip coincides with this compaction turn, both
AND conditions fire (`coreHash ≠ main` AND `convId ∉ main set`) and the
turn is misrouted to a ghost `agent-` lane. Blast radius: single turn; the
next main turn restores coreHash and re-anchors. Low probability (blip is
rare × must coincide with compaction). Runtime mitigation deferred — no
instant-available signal distinguishes this from a real teammate at that
moment.

**Known divergence — turn-list background-session window (ADR 0005)**: the
turn-list `isSubagent` classification in `entry-rendering.js` is gated on
`wfState.sessionId === sid` — a turn arriving while a different session is
viewed skips coreHash routing and is classified by agentKey alone. When the
user later views that session, `wfInferLanes` correctly routes the turn to
an identity lane, but the turn list retains its original classification. No
retro-correction mechanism exists for this layer (unlike seq's
`_seqRetroFlip`). Accepted as a narrow window; a coreHash retro pass is a
potential future fix (requires ADR-level design due to three-layer
interaction complexity — see ADR 0005 round-4/5/6 history).

## Alternatives considered

See `docs/solutions/corehash-identity-routing.md` for the full option
comparison — Option B (pure convId, rejected: convId is conversation
content, not identity, and ADR 0009 already rejected routing on it alone)
and Option C (pure jitter-tolerance epsilon, rejected: leaves teammates
transiting main with provisional-window pollution, and the same epsilon
would weaken the fork overlap invariant).

## Rewritten by #350 (2026-07-24) — per-conversation ownership (batch path)

### What broke

The Decision above routes **per turn**: a turn is a teammate iff *its own*
`coreHash` differs from a single scanned `mainCoreHash` AND *its own* `convId`
is not yet in the incrementally-accumulated `mainConvIds`. Both halves are
fooled by one anomalous turn. Real session `4b15c248`, convId `add88512`: a
74-turn Fable-5 subagent whose **first** turn (msg 461) carries the parent
orchestrator's `coreHash` (`85771b`, == main) across the spawn/fork boundary,
while the other 47 carry the subagent's own (`86e2ea`). That seed turn fails
`coreHash !== mainCoreHash` → lands in main → registers `add88512` into
`mainConvIds` → every later `86e2ea` turn then fails `!mainConvIds.has(convId)`
→ also stays main. Result: the one conversation scattered across three lanes
(main 48 + `agent-orchestrator:add88512` 25 + `parallel-fable-5:add88512` 1),
and ~16% of the "main" lane was actually a Fable subagent (verified via
`wfInferLanes` on the real session: main coreHashes `85771b`×193 + `86e2ea`×47).

### The rewrite (batch — `wfInferLanes` / `_wfComputeConvIdentity`)

Ownership is decided **per conversation**, not per turn. A conversation's
identity is its **plurality-tied coreHashes** (`convMaxHashes` = the hashes
sharing the maximum count, usually one), so the minority seed/blip turn cannot
flip it:

| conversation vs `mainCoreHashSet` | lane |
|---|---|
| a plurality-tied coreHash ∈ set | main candidate (whole conversation) → ADR 0008 overlap sweep |
| plurality non-null, none ∈ set | ONE identity lane `agent-<agentKey>:<convId>` (seed turn included) |
| no coreHash (legacy/no-convId) | pre-existing agentKey/fallback path, unchanged |

Keying on the plurality-tied **set** (not a single dominant) is a codex-R2
hardening: a genuine A/B tie resolves toward main-membership, so a compaction
successor that `/model`-switches (`A×n + B×n`, A shared with main) is **not**
ejected — while a clear-majority foreign conversation (add88512: max-count
`{86e2ea}`, the lone inherited `85771b` seed turn is not max-count) stays a
subagent.

`mainCoreHashSet` is seeded from the earliest-**starting** lane-eligible
main-agentKey **conversation** that carries a coreHash (keyed on the
conversation's earliest main turn — not the earliest coreHash-bearing turn, or a
subagent could seize the seed when main opens coreHash-less; codex R2). null
`receivedAt` sorts last (never `Number(null)===0` → first; codex R1), convId
breaks exact ties. It is a `Set` for API/parity stability but in practice holds
the trunk's single identity hash: because routing is **per-conversation**, a
mixed conversation (main that `/model`-switches, keeping `messages[0]` hence its
convId) already rides main as one unit, so the set does **not** carry the
secondary coreHashes a main conversation happens to contain. That is
load-bearing — a coreHash appearing inside main is not proof that a *separate*
conversation carrying it is main (real session `c6e1ddaa`: main conv contains 72
turns @`7852d4`; a separate 94-turn conv is also @`7852d4` but a subagent).
Compaction (`messages[0]`→summary changes convId but not the prompt) keeps the
successor's plurality coreHash unchanged, so it stays main with no set growth.

**Bounded limitations (accepted; zero real-corpus harm, codex R1–R3):**
- A compaction successor whose only shared-with-main hash is a **minority** (not
  plurality-tied) is ejected. It is structurally identical to add88512 (minority
  inherited hash + majority own hash), which we deliberately eject, so no rule
  can keep one without re-absorbing the other. Same class as ADR 0009's
  rewind-across-compaction.
- A **two-turn** conversation split exactly 1 inherited-main hash + 1 own hash is
  a genuine `{A,B}` tie and resolves toward main. A real subagent carries many
  own-hash turns (add88512: 73), so its own hash is the clear plurality; the
  1-1 case is a synthetic tail edge with no overlap/bracket signal either way,
  and leaning main avoids ejecting genuine `/model` continuations.
- A genuine-main turn with a **null convId** (legacy/imported data) carries no
  conversation identity and cannot seed or be identity-routed — the whole
  #350 mechanism is convId-keyed, so null-convId turns fall to the pre-existing
  agentKey/fallback path.

This **subsumes** the AND-guard (the `#218/#219` blip is a single minority turn,
overruled by the dominant vote) and **rewrites** — does not merely gate — the
per-turn early-exit.

### Why NOT the ADR 0009 seq trunk (the option #350's issue proposed)

The issue proposed deriving `mainCoreHashSet` by feeding main-agentKey turns to
the ADR 0009 seq tracker and taking the trunk convs' coreHashes. Rejected on
evidence: a subagent conversation that runs at the **session tail** (trunk never
returns) is indistinguishable from a compaction to the seq bracketing, so it
stays in the trunk and its coreHash enters the set. `add88512` is exactly the
final run of `4b15c248`, so a seq-trunk-derived set re-absorbs it into main —
failing the acceptance. coreHash continuity has no tail blind spot: `add88512`'s
dominant `86e2ea` is novel, so it is never main regardless of position.

### Verification (docs/verification-principles.md)

- fail-on-old / pass-on-new unit test (`test/workflow-timeline.test.js`, `#350`
  suite): a seed turn carrying main's coreHash at the session tail — old code
  leaks the whole conversation into main, new code routes it to one identity
  lane.
- Full-corpus real-JS replay (426 multi-coreHash sessions, `~/.ccxray`):
  coreHash-leak residual (main turns whose conversation's dominant coreHash is
  foreign) **784 → 61 (92% reduction)**; **0** sessions where the leak
  increased (no over-merge regression); null-convId non-main lanes **delta 0**;
  distinct non-main convIds **2196 → 2192** (the −4 are single-turn null-coreHash
  `sdk-agent` lanes whose *spurious* overlap-split disappears once the leaked
  foreign turns leave main — a positive side effect).
- `4b15c248` acceptance: `add88512` 3 lanes → **1** (`agent-orchestrator:add88512`,
  74 turns); main `86e2ea` 47 → **0**. Browser render smoke: `wfBuildState` +
  `wfRenderTimeline` run without throwing on the consolidated lane.

### A1/A2 boundary (scope)

This ADR's rewrite covers the **batch** path only (`wfInferLanes`) — enough to
fix any *completed* session on cold-load+rebuild, which is how the dashboard
renders `4b15c248`. `wfBuildState` re-derives `mainCoreHash`/`mainConvIds` from
the now-correctly-composed final main lane, so the live `wfAddEntry` and
turn-list `entry-rendering.js` paths inherit a correct main identity for new
turns; their per-turn early-exit is left in place. Mirroring the
per-conversation rule + dominant-coreHash flip/trunk rebuild into those two
sites — once tracked as "A2" — was never implemented, and #350 is closed, so
nothing tracks it. The residual divergence is therefore ACCEPTED, not pending:
a *live* seed turn arriving on an actively-viewed session — bounded and
self-correcting on the next full rebuild. See `docs/solutions/same-convid-lane-classification.md`.
