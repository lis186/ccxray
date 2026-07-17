# 0010 — coreHash + convId identity routing for teammate lanes

- Status: Accepted
- Date: 2026-07-16
- Related: #258 / #257 / ADR 0005 / ADR 0008

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
| Compaction | = main | ∈ main set | → stays main |

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

## Alternatives considered

See `docs/solutions/corehash-identity-routing.md` for the full option
comparison — Option B (pure convId, rejected: convId is conversation
content, not identity, and ADR 0009 already rejected routing on it alone)
and Option C (pure jitter-tolerance epsilon, rejected: leaves teammates
transiting main with provisional-window pollution, and the same epsilon
would weaken the fork overlap invariant).
