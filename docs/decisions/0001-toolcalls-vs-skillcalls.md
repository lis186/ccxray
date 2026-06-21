# 0001 — Keep `toolCalls` and `skillCalls` as separate index fields

- Status: Accepted
- Date: 2026-06-21
- Related: #90 / PR #94 (`ccxray usage`), #97

## Context

Each log entry carries a summarized `toolCalls` index — a plain `{toolName: count}`
map produced by `helpers.js:extractToolCalls` and persisted via `entry.js`. The
dashboard reads it directly in several places:

- `public/miller-columns.js` — `tc['Skill']` to decide whether a turn triggered a skill
- `public/entry-rendering.js` — tool chips
- tool-utilization counting

So `toolCalls` is a **shared contract**, not a private detail.

`ccxray usage` later needed *per-skill* granularity (which skill, how many
invocations, how many sessions loaded it). An early PR #94 revision met that need
by expanding `Skill` tool calls into `Skill:<name>` keys *inside* `extractToolCalls`.
That polluted the shared map: every dashboard consumer suddenly saw keys like
`Skill:superpowers:brainstorming` instead of `Skill`, and `tc['Skill']` stopped
matching — a chain of dashboard breakage from one extraction change.

## Decision

Keep the two concerns in two fields:

- `toolCalls` stays a plain `{toolName: count}` map. `Skill` and `Workflow` are
  **not** expanded — the key remains the bare tool name.
- A separate `skillCalls` `{skillName: count}` index field, produced by
  `helpers.js:extractSkillCalls`, holds the per-skill breakdown. Only `ccxray usage`
  reads it.

`extractSkillCalls` counts only the model-initiated `Skill` tool_use, keyed by its
`input.skill`. `Workflow` is excluded because it has no `skill` input.

```
              messages[].content[]  (tool_use blocks)
                        │
        ┌───────────────┴────────────────┐
        ▼                                 ▼
 extractToolCalls(msgs)           extractSkillCalls(msgs)
 {Skill:3, Bash:1}                {"superpowers:brainstorming":2}
        │                                 │
        ▼                                 ▼
   toolCalls  (index)               skillCalls  (index)
        │                                 │
   ┌────┴───────────┐                     │
   ▼                ▼                      ▼
 dashboard      ccxray usage         ccxray usage
 tc['Skill'],   "Tools" section      "Skills" section
 chips, util.   (aggregate)          (per-skill invocations/loads)
```

## Consequences

- The dashboard needs **zero changes** to gain per-skill stats — it never reads
  `skillCalls`.
- Entries written before `skillCalls` existed have no such field. `usage.js`
  degrades them to a single `(pre-tracking)` bucket (`invocations` from the legacy
  `toolCalls.Skill` count, `loads: null`) rather than dropping them.
- A small, deliberate denormalization: `toolCalls.Skill` equals the sum of
  `skillCalls` values for the same entry. This redundancy is inherent to keeping
  two indexes and is accepted.

## Rejected alternative

Expand `Skill:<name>` into `toolCalls` and teach every consumer to collapse it back
to `Skill`. Rejected: it spreads contract knowledge across every reader, and the
"collapse" step is exactly what broke the dashboard in the first place. A pollution
of the shared map is strictly worse than a second, purpose-built field.

**Do not merge the two fields back into one** to "save a field." The separation is
the fix, not an oversight.

## Provider scope: why `skillCalls` is Anthropic-only

This is structural, not a missing feature. The Codex (OpenAI Responses) protocol
has no concept of a skill *call*.

`extractSkillCalls` relies on Claude Code's first-class `Skill` tool:

```json
{ "type": "tool_use", "name": "Skill", "input": { "skill": "<name>" } }
```

That is a discrete, countable, attributable event. Codex has no equivalent.
Evidence from `test/fixtures/codex-sessions/*.jsonl`: the only `function_call`
names are `exec_command` and `write_stdin` — no `Skill` tool. Codex advertises
skills as **prompt instructions** (a `<skills_instructions>` block listing each
`SKILL.md`), and follows them inline. There is nothing in the wire format to
attribute to "skill X was invoked" — even a `cat SKILL.md` would surface as a
generic `exec_command` (Bash).

If Codex per-skill stats are ever wanted, they need a *different, lossy* mechanism
(parse `<skills_instructions>` for the available set, then heuristically detect
usage) — out of scope for the `skillCalls` field.
