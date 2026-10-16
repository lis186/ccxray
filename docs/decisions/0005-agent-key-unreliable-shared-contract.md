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

`WF_MAIN_AGENT_KEYS`, `AGENT_KEY_UNRELIABLE`, and `isMainTurnByAgentKey()`
live in `public/agent-classification.js` — an isomorphic module loaded as a
browser script tag (before `workflow-timeline.js`, see `public/index.html`)
and `require()`'d by server modules (#381). All sites read the same shared
object. Every site that branches on `entry.agentKey` to decide main vs.
subagent must call `isMainTurnByAgentKey(entry)` (or gate on
`entry.agentKey && !AGENT_KEY_UNRELIABLE[entry.agentKey]` with the same
fallback) and fall back to the raw `isSubagent` flag otherwise:

| Site | File | Guard |
|------|------|-------|
| `isSubagent` computation | `entry-rendering.js` `addEntry()` | `e.agentKey && !AGENT_KEY_UNRELIABLE[e.agentKey]` |
| Batch lane build | `workflow-timeline.js` `wfInferLanes()` | `e.agentKey && !AGENT_KEY_UNRELIABLE[e.agentKey]` |
| Live lane update | `workflow-timeline.js` `wfAddEntry()` | `entry.agentKey && !AGENT_KEY_UNRELIABLE[entry.agentKey]` |
| Window fold + derived fields | `server/session-index.js` `_upsert()` | `isMainTurnByAgentKey(entry)` (#381) |
| coreHash identity routing (pre-scan) | `workflow-timeline.js` `wfInferLanes()` | coreHash+convId early-exit runs before `WF_MAIN_AGENT_KEYS` — see ADR 0010 |
| coreHash identity routing (live) | `workflow-timeline.js` `wfAddEntry()` | reads `wfState.mainCoreHash` / `wfState.mainConvIds` — see ADR 0010 |
| coreHash identity routing (turn list) | `entry-rendering.js` `addEntry()` | reads `wfState.mainCoreHash` / `wfState.mainConvIds`, gated on `wfState.sessionId === sid` — see ADR 0010 |

## Exception — the Herdr plugin badge (Accepted 2026-08-20)

The Decision above says *every* site that branches on `entry.agentKey` must call
`isMainTurnByAgentKey()`. That sentence is now false for a site inside this
repository, and the site is right to be an exception.

`plugins/herdr/bin/lib/ccxray.js` `mainDisplayTurns` branches on `agentKey` and
must NOT use the shared predicate: `isMainTurnByAgentKey` returns TRUE for
exactly the shape the badge exists to exclude. `agentKey: 'agent'` is in
`AGENT_KEY_UNRELIABLE`, so the predicate degrades to the raw `isSubagent` flag,
which a background conversation carries as `false` — importing it there would be
a no-op. The two rules answer different questions: core's is recall-oriented
(never misfile a possibly-new main variant as a subagent), the badge's is
precision-oriented (an unrecognized key must not SET the displayed number).

What the plugin DOES share is the drift-prone datum: it requires
`WF_MAIN_AGENT_KEYS` from this ADR's module (defensively — a plugin installed
outside a ccxray checkout has no core file, and degrades to the raw-flag tier).
The predicate stays local. Recording this so a later reader does not "unify"
a deliberate divergence away; it is not a new consumer row.

`mainDisplayTurns` has one additional fallback for provider records that omit
`agentKey` after a session has already emitted classified main turns:
`agentKey == null && isSubagent === false` is included in the mixed main fold.
A null key is missing classification data, not an authoritative subagent
classification. Explicit non-main keys (including `agent` and
`general-purpose`, as well as other non-null keys outside
`WF_MAIN_AGENT_KEYS`) remain excluded when a positive main key is present.
This preserves the badge's precision rule while keeping the latest Codex main
turn from being replaced by an older classified turn.

**Consistency obligation this creates inside the plugin.** Having two rules
means the plugin's own sites must agree with each other. They did not:
`paneSessionTelemetry` selected "main" with raw `!isSubagent` while
`summarizeTurnGroup` used `mainDisplayTurns`, so the sidebar badge and the
Mission Control row named different models for one pane (fixed 2026-08-20; the
in-tree comment had asserted this was impossible).

That first fix moved only the model label, and "any further main-selection site
must route through `mainDisplayTurns`" turned out to be the wrong shape of
obligation — sweeping enough to sound satisfied while `missionControlRow` still
computed ctx%, cache%, failures, and the prompt-change signals from raw turns.
The badge anchored those; Mission Control did not, so one pane rendered 1% on
the sidebar and 60% in Mission Control (`test/herdr-plugin.test.js`, "names the
same model in the sidebar badge and the Mission Control row", now asserts ctx%
agreement as well; fail-on-old verified 60 vs 1).

The obligation is therefore stated as an enumerated list of the figures that
must AGREE, not as a blanket rule:

| Figure | Both surfaces read | Must agree? |
|---|---|---|
| model label, context window + ctx%, cache%, tool failures, prompt-change | `mainDisplayTurns(turns)` | **yes** |
| evidence freshness ("seen") | every turn IN EACH SURFACE'S OWN SET — badge `evidenceStaleness(sorted)` over the selected session group, row `freshness` from `observedLatestAt` over `turns` + `subagentTurns` | **yes, for a same-session subagent** (see the scope note) |
| cost, turn count | different sources by design — see below | **no** |
| badge `ageText` vs row `sessionAge` | different QUANTITIES — see below | **no** |

Freshness is whole-session on purpose: a subagent turn logged a minute ago
proves ccxray is still watching the pane just as well as a main turn does. The
row's `freshness` was built from main-only `latestAt` and so reported a pane
stale while its subagent was working; it reads `observedLatestAt` now.

**Scope note — the two "every turn" sets are not identical.** The badge folds
the selected session GROUP; the row additionally folds child sessions (groups
whose turns carry `parentSessionId` of the selected session, via
`paneSessionTelemetry`'s `subagentTurns`). So the agreement holds for a
same-session subagent — the case the fix addressed and the case the test pins —
and a subagent that runs under its OWN session id can still refresh the row
while the badge, which never sees that group, reports the older main turn.
Closing that would mean giving the badge the child-session turns too, which is a
change to what "this session" means on the badge; recorded here as a bounded
residual rather than claimed as agreement.

`latestAt` also remains main-only for the row SORT — but only on the
agents branch: the no-agent fallback (`missionControlSnapshot`'s `else`) passes
every turn of a session straight to `missionControlRow` with no `subagentTurns`,
so there `latestAt` is already whole-session. Sort ordering is a separate
question this ADR does not settle either way.

**The two time figures are not the same measurement, so requiring agreement was
a category error.** With a `sessions.json` aggregate the badge's `ageText` is a
DURATION (`lastReceivedAt − firstReceivedAt`, how long the session ran), while
the row's `sessionAge` is ELAPSED SINCE START (`now − observedStartedAt`). They
differ by however long the session has been idle — for a session that started 10
minutes ago and ran 5, by 2× — and the badge reports duration deliberately
(4060eb: printing "how long ago it started" in the same terse `9.9h` shape made
the badge look like it disagreed with the dashboard about the same number).

Without an aggregate the badge falls back to `now − firstTs`, which is the row's
quantity rather than a duration, so on that path the two coincide. Neither path
is required to agree: the figure means different things depending on whether the
hub has flushed this session, which is itself a reason not to put it in a
"must agree" row. An earlier revision of this table did.

**Cost and turn count are deliberately NOT comparable, and must not be
"aligned".** The badge reports the hub's per-session aggregate (`sessions.json`)
because the plugin's own window is a 4 MiB tail of a much larger index — its sum
is a SAMPLE, and reporting it made the badge disagree with the dashboard about
the same session. The Mission Control row instead reports the **main-agent** sum
over that tail (`cost`, `turns`) plus a separately labelled subagent rollup
(`subagents N, total $X`), and keeps `totalCost`/`totalCostAgg` for the combined
figure. So the row's headline cost is main-only by design while the badge's is
whole-session from a different source; an earlier revision of this table claimed
both were whole-session, which was false in two ways at once.

A new figure added to either surface must be placed in this table. A figure that
must agree has to read the same set in both; a figure that cannot agree has to
say why here.

## Consequences

**Good**: the turn list and the workflow swimlanes can no longer disagree on
the same turn's main/subagent classification — both read the same
`AGENT_KEY_UNRELIABLE` object and apply the same fallback rule.

**Bad — consistency contract**: adding a new call site that branches on
`agentKey` (e.g. a future view or a new server module) without this guard
silently reintroduces the round-4 bug for that view, undetectably until
someone notices the same turn classified two different ways in two different
places.

**Mitigation**: `INVARIANT` guard comments at all ten sites above name this
ADR. All sites — client and server — read from the one shared
`agent-classification.js` module (#381); there's nothing to keep in sync by
hand.

## Alternatives considered

**Have the server never emit `unknown`/`agent` as `agentKey`, forcing a
real classification**: rejected — `extractAgentType()`'s regex fallback is
specifically there to degrade gracefully for prompts nobody has written a
matcher for yet; refusing to serve those entries or guessing wrong is worse
than the client falling back to the raw flag.

**Duplicate `AGENT_KEY_UNRELIABLE` in both files**: rejected — this is
exactly the shape of drift that caused the round-4 bug in the first place.
#381 extracted the constants into a shared isomorphic module
(`public/agent-classification.js`) that both client script tags and server
`require()` read, eliminating the duplication risk entirely.
