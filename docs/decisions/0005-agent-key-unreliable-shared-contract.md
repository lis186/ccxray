# 0005 — Shared agentKey-unreliability contract

- Status: Accepted
- Date: 2026-07-10
- Related: PR #224

## Context

Two independent client files each classify a turn as "main" or "subagent":

- `entry-rendering.js`'s `addEntry()` — drives the turn list, the
  follow-live-turn pill, and session counters.
- `workflow-timeline.js`'s `wfInferLanes()` (batch) / `wfAddEntry()` (live) —
  drives which swimlane a turn is drawn in.

Both prefer the server-detected `agentKey` (from system-prompt content,
authoritative — not fooled by Claude Code's current behavior of Task-tool
subagent requests carrying the *parent's* `session_id`, which is what makes
the server's own `isAnthropicSubagent()` heuristic miss the common case).
But `extractAgentType()` (server, `system-prompt.js`) has two catch-all
defaults — `unknown` and `agent` — for prompts it can't classify. Those could
be a genuinely new main-agent variant, not necessarily a subagent, so
treating them as an authoritative "not main" signal risks silently breaking
follow-live-turn or misfiling a main turn into its own subagent lane.

Codex review (round 4, PR #224) caught the two files disagreeing on exactly
this: `entry-rendering.js` already guarded with `AGENT_KEY_UNRELIABLE`
(falling back to the raw `isSubagent` flag for `unknown`/`agent`),
`workflow-timeline.js` did not — so the same turn could show as "main" in
the turn list and as a subagent lane in the workflow view.

## Decision

`AGENT_KEY_UNRELIABLE = { unknown: 1, agent: 1 }` lives in
`workflow-timeline.js` (loaded before `entry-rendering.js`, see
`public/index.html` script order) so both files read the same object. Every
site in either file that branches on `entry.agentKey` to decide main vs.
subagent must gate on `entry.agentKey && !AGENT_KEY_UNRELIABLE[entry.agentKey]`
before trusting it, and fall back to the raw `isSubagent` flag otherwise:

| Site | File | Guard |
|------|------|-------|
| `isSubagent` computation | `entry-rendering.js` `addEntry()` | `e.agentKey && !AGENT_KEY_UNRELIABLE[e.agentKey]` |
| Batch lane build | `workflow-timeline.js` `wfInferLanes()` | `e.agentKey && !AGENT_KEY_UNRELIABLE[e.agentKey]` |
| Live lane update | `workflow-timeline.js` `wfAddEntry()` | `entry.agentKey && !AGENT_KEY_UNRELIABLE[entry.agentKey]` |
| coreHash identity routing (pre-scan) | `workflow-timeline.js` `wfInferLanes()` | coreHash+convId early-exit runs before `WF_MAIN_AGENT_KEYS` — see ADR 0010 |
| coreHash identity routing (live) | `workflow-timeline.js` `wfAddEntry()` | reads `wfState.mainCoreHash` / `wfState.mainConvIds` — see ADR 0010 |
| coreHash identity routing (turn list) | `entry-rendering.js` `addEntry()` | reads `wfState.mainCoreHash` / `wfState.mainConvIds`, gated on `wfState.sessionId === sid` — see ADR 0010 |

## Consequences

**Good**: the turn list and the workflow swimlanes can no longer disagree on
the same turn's main/subagent classification — both read the same
`AGENT_KEY_UNRELIABLE` object and apply the same fallback rule.

**Bad — consistency contract**: adding a new call site that branches on
`agentKey` (e.g. a future view) without this guard silently reintroduces the
round-4 bug for that view, undetectably until someone notices the same turn
classified two different ways in two different places.

**Mitigation**: `INVARIANT` guard comments at all three sites above name
this ADR. If `WF_MAIN_AGENT_KEYS` or `AGENT_KEY_UNRELIABLE` ever needs a new
entry, both files' classification logic reads from the one shared object —
there's nothing to keep in sync by hand.

## Alternatives considered

**Have the server never emit `unknown`/`agent` as `agentKey`, forcing a
real classification**: rejected — `extractAgentType()`'s regex fallback is
specifically there to degrade gracefully for prompts nobody has written a
matcher for yet; refusing to serve those entries or guessing wrong is worse
than the client falling back to the raw flag.

**Duplicate `AGENT_KEY_UNRELIABLE` in both files**: rejected — this is
exactly the shape of drift that caused the round-4 bug in the first place;
a single shared definition (like `WF_MAIN_AGENT_KEYS`, already shared the
same way) removes the possibility.
