# 0014 — Providers declare capability; a provider-agnostic layer infers parentage

- Status: **Accepted** (expert-panel design 2026-07-29; owner ruling same day) — **decision only, not yet implemented**
- Date: 2026-07-29
- Related: ADR 0005 (agentKey unreliable — this ADR raises its conclusion to the
  protocol layer) / ADR 0008 (temporal overlap overrides declaration) / ADR 0010
  (coreHash-authoritative identity)
- ~~**Depends on #313**~~ — **landed.** `OPENAI_WIRE_CLIENTS` is in
  `server/providers.js` and `docs/provider-modules.md` exists, so the blocker
  this ADR recorded is gone. What remains unimplemented is the ADR's own
  decision: there is no `server/attribution.js`, and `roleSignal` is not on any
  `OPENAI_WIRE_CLIENTS` entry. Status is therefore still "decision only, not yet
  implemented" — but for a different reason than the one written here, which was
  factually stale (fixed 2026-08-20 while auditing the Herdr plugin, which has
  quietly become a CONSUMER of inferred parentage: it reads `parentSessionId` to
  decide that a session is not the pane's own — making an unimplemented
  decision load-bearing for a rendered surface).

## Context

#313 introduces a four-layer provider contract (`docs/provider-modules.md`):
launcher, wire family, OpenAI-wire client, upstream host. Every field in it
describes **how to get bytes to the right place** — `upstreamKey`,
`rawSessionId`, `modelPattern`, `sessionHeaderNames`, `matchHeaders`. No field
describes how a CLI expresses the relationship *between* its agents. Subagent
identification — which drives the swimlane, the product's differentiator — was
never part of the contract.

### The mechanism of the failure

Subagent detection dispatches on **wire family, not client**:

```
server/index.js:407   provider === 'openai' ? parser.isSubagent(parsedBody, clientReq.headers) : undefined
server/wire-parsers/openai.js:113   isOpenAISubagent → x-openai-subagent | metadata.is_subagent
```

`OPENAI_WIRE_CLIENTS` lets a new CLI share the Responses parser for body/SSE
shape — and thereby inherit Codex's subagent rule for free. Grok emits neither
signal, so `isSubagent` is permanently `false` for it. The hint feeds both
`store.linkParentSession` (`server/index.js:408`) and the entry field
(`server/index.js:468`), so one wrong verdict propagates to both.

### Observed evidence (live capture through the merged #313 tree, 2026-07-29)

One Grok run with an inline subagent (`grok --agents '{...}'`), four entries:

```
17:23:30  session A  cwd=/Users/…/dev/ccxray  coreHash=f6e1100a  msgs=6   parent
17:23:37  session B  cwd=(absent)             coreHash=e818f306  msgs=4   subagent
17:23:42  session B  cwd=(absent)             coreHash=e818f306  msgs=7   subagent
17:23:43  session A  cwd=/Users/…/dev/ccxray  coreHash=f6e1100a  msgs=10  parent
```

`isSubagent=false` on all four; `agentKey=default` / `agentLabel=Grok` for both
roles; `parentSessionId=none`. The subagent surfaces as a **sibling session**,
not a lane inside its parent. Note the two session ids share the prefix
`019fad2f` — that is UUIDv7 timestamp encoding, **not** a parent link; do not
read identity into it.

The three CLIs express subagents three incompatible ways:

| | Claude Code | Codex | Grok |
|---|---|---|---|
| subagent's session id | reuses the **parent's** | same session | **its own, new** |
| role signal | system-prompt content → `agentKey` | header `x-openai-subagent` | **none** |
| usable observable | `agentKey` + content hash | header | content hash, absent `cwd`, temporal nesting |

### Why inference is not a shortcut

OpenTelemetry's GenAI semantic conventions cover multi-agent tracing, but
express parent attribution **structurally, through span parentage carried by
propagated trace context** — there is no parent-agent attribute, and the
conventions name propagation failure as the primary way attribution breaks
(conventions still in Development; `gen_ai.*` moved to a dedicated repo
2026-06-12). ccxray is a passive wire observer: it cannot inject or propagate
context. **The industry answer is structurally unavailable here**, so inference
is the only available mechanism, not a cheaper substitute for a better one.

### Why not simply declare more

The obvious fix — add optional fields (`detectSubagent`, `sessionTopology`,
`titleExtractor`, `quotaAdapter`) to the client entry — was rejected. It adds
*self-reported* fields at precisely the point where ADR 0005, 0008, and 0010
each independently concluded that self-reported identity is untrustworthy and
content-derived identity is authoritative. The protocol was one generation
behind its own ADRs.

## Decision

**Two axes only** — session topology and role signal. Title extraction and
quota introspection stay declarative: they have no observable basis to infer
from, and inverting them would relocate the coupling rather than remove it.
The other provider-specific branches outside the registry (≈55 across 12 files
at time of writing) are **not** in scope.

### 1. The client declares one capability, not a mechanism

```js
// OPENAI_WIRE_CLIENTS entry (registry introduced by #313) — routing fields unchanged
{
  id: 'grok',
  upstreamKey: 'xai', rawSessionId: 'grok-raw', /* … */
  roleSignal: null,   // Codex: (headers, body) => isOpenAISubagent(headers, body)
}
```

**`sessionTopology` is deliberately NOT declarable.** Once a provider declares
"my subagents get their own session id", that inference is promoted from a
recomputable view to a pseudo source of truth, and a later CLI release cannot be
overruled by observation. Topology is derived from what is on the wire, always.

### 2. Inference lives in one provider-agnostic module

```js
// server/attribution.js (new)
inferParentage({ sessionId, cwd, coreHash, receivedAt, msgCount,
                 roleSignal, openSessions })
  → { parentSessionId, authority, basis }
```

**The signature contains no `provider` argument. This is the load-bearing
constraint of this ADR, not a stylistic preference.** The predicted failure mode
is that the inference layer accumulates provider conditionals and becomes the
old coupling relocated. Adding one requires changing the signature, which a
reviewer sees.

`basis` records which observables fired (e.g.
`['no-cwd','core-hash-differs','temporally-enclosed']`). It exists so fixtures
have something to assert on. It is deliberately **not** a vote tally and drives
**no** alerting — at three CLIs that machinery is unjustified.

### 3. `parentAuthority` is tri-state; only the weakest tier is marked

| value | source | lane rendering |
|---|---|---|
| `declared` | Codex header — the CLI states it | solid |
| `derived` | Claude Code — read from system-prompt **content the agent actually sent** | solid |
| `inferred` | Grok — **circumstantial only** (temporal nesting + absent `cwd` + differing hash) | **dashed + `inferred` badge** |

A two-tier split (only `declared` is trusted) was considered and rejected by the
owner: it would mark every Claude Code lane, and a marker present everywhere
warns about nothing. The `derived`/`inferred` line is drawn at a real
distinction — content the agent emitted versus circumstances around it — not at
convenience.

**Unlabelled inference must not reach the UI.** This is an admission condition
for the inference layer, not a follow-up: a passive observer that renders a
guess identically to a fact spends the trust the tool exists to earn.

### 4. Reuse the existing precedent; invent nothing

`sessionInferred` is already the same shape — a flag recording that identity was
inferred rather than read. `server/store.js:160,181,262` adopt
`(sessionId + sessionInferred + isSubagent)` as **one identity unit,
atomically**; `parentSessionId` + `parentAuthority` join that unit.
`public/miller-columns.js:2532` already renders a dashed-yellow `inferred` badge
(`title="Session attributed by inference"`) — lanes reuse that component. The
swimlane is SVG and already draws `stroke-dasharray="3 2"` for the model-switch
marker beside the subagent-spawn marker (`public/workflow-timeline.js:1604`), so
dashed lane rendering is available, not new.

### 5. Granularity: field on the entry, verdict at conversation level

Parentage is properly a *relation*, not a per-turn boolean. Changing granularity
now is scope creep against the atomic identity unit above, so the field rides on
the entry while the **lane-level verdict is a conversation majority** — exactly
what ADR 0010 already does for `coreHash`. `AGENT_KEY_UNRELIABLE`
(`public/workflow-timeline.js:279`) and its gates are untouched; this ADR
upholds ADR 0005, it does not amend it.

## Preconditions (blocking, not advisory)

0. **#313 must land**, or `OPENAI_WIRE_CLIENTS` must be introduced by other
   means. There is no registry to add `roleSignal` to until then.
1. **`linkParentSession` (`server/store.js:503`) currently has five unmerged
   worktree variants**, each carrying a different ~80-line change to the same
   function. Five variants means there is no specification. They must be
   collapsed to one before the inference layer is written. All four panellists
   raised this independently and unprompted.
2. **Golden fixtures before the layer.** The four-entry capture above becomes
   `test/fixtures/attribution/grok-subagent.json`, asserting `parentSessionId`,
   `authority='inferred'`, and `basis`. A **second fixture with `cwd`
   populated** — simulating a future Grok release that fills the field — must
   assert that `basis` changes. Absent `cwd` is not an interface; it is Grok not
   filling a field. Without that fixture, a signal flip degrades silently while
   the majority still passes and the swimlane keeps drawing confidently.

## Consequences

**Good**: a fourth CLI costs nothing on these two axes. The decision aligns the
protocol with ADR 0005/0008/0010 instead of contradicting them. Because the raw
request/response bodies and `rebuild-index` already exist, an improved inference
rule needs no migration — re-run it. That turns "the inference will sometimes be
wrong" from a risk into an iterable cost.

**Accepted limits**: (1) Grok parentage is circumstantial and will sometimes be
wrong; the dashed marker is the mitigation, not a fix. (2) Two genuinely
independent concurrent sessions in the same repo and time window can be merged
into a false parent-child, and that error direction is not observable from the
wire. (3) Live rendering may show a provisional verdict before enough of the
enclosing session is seen; it heals on re-render, and recomputability does not
repair the experience of having seen it wrong. (4) The ≈55 provider branches
remain.

**New consistency contract**: any site needing parentage reads
`parentSessionId` + `parentAuthority`; any renderer of a lane must consult
`parentAuthority` and must not draw `inferred` as solid. Adding a provider
conditional inside `server/attribution.js` is a contract violation, visible as a
signature change.

## Panel record (independent assessments, 2026-07-29)

Four lenses, briefed identically and answering without knowledge of each other,
then a final ruling. **Verdicts: three for a scoped inversion, one for full
inversion with a blocking precondition.**

- **Sigelman lens** (Dapper/OpenTracing): Dapper's parentage was reliable only
  because Google owned the RPC libraries — "not an engineering gap, a topology
  fact". Declaring topology writes a guess into a field that reads like an
  assertion. Demanded UI confidence tiers as a condition, golden fixtures, and
  the worktree collapse first.
- **Nottingham lens** (RFC 9170): "you are not writing a protocol, you are
  writing an observation model" — the peers are third-party CLIs that will never
  negotiate. An optional field with one implementer is the SNI extension-point
  lesson; Grok inheriting Codex's rule is the TLS version-intolerance pattern
  (an implementer believing it negotiated while copying a default). Argued for
  inverting **only** these two axes, leaving title and quota declarative — the
  scope this ADR adopts.
- **Kleppmann lens** (DDIA 2nd ed., 2026-03): the only system of record is the
  raw bytes plus arrival order; `agentKey`, `isSubagent`, `coreHash`, parentage
  and the swimlane are all derived. A per-turn `isSubagent` boolean is "a
  conclusion stored at the wrong granularity". Predicted the decisive failure
  mode: the inference layer becoming a new hidden provider branch — which
  §Decision 2 exists to prevent.
- **Metz lens** (*The Wrong Abstraction*): dissented. Judged the wire-family
  abstraction already expired ("Grok inheriting Codex's rule is not a bug, it is
  the interest on a wrong abstraction") and argued for un-sharing the OpenAI
  parser per client and waiting for a fourth CLI before abstracting anything.
- **Ruling**: scoped inversion, over Metz's objection. Temporal nesting, content
  hash and `cwd` presence are physical properties of the bytes, not an
  abstraction induced from three samples, so sample count does not bear on them;
  and one maintainer carrying three parsers is the headcount blind spot Metz
  named herself. Vote tallying with consensus alerting was ruled out as
  over-engineering at three CLIs.
- **Owner ruling**: tri-state `parentAuthority`, marking only `inferred`.

All four panellists independently disclaimed the same blind spot — none could
judge whether a wrongly drawn lane costs more trust than an absent swimlane.
That question was ruled on directly: for an observability tool it does, because
such a tool sells credibility rather than coverage, and one silent error
discredits the whole surface. §Decision 3's admission condition follows from
that ruling.

## Implementation sequence (not yet started)

Land #313 → collapse the five `linkParentSession` variants → land both fixtures
(including the `cwd`-flip) → `server/attribution.js` + `roleSignal` declaration →
lane rendering reads `parentAuthority`. No verification section: nothing is built
yet. This ADR records the decision only.
