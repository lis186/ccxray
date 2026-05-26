## Context

ccxray runs in two modes: a single-project proxy and a "hub" that detached-forks once and serves multiple Claude Code sessions across many project directories. In hub mode, every project's traffic interleaves on the hub's stdout (which is also the file `~/.ccxray/hub.log`). The dashboard already groups requests by project / session / turn for browser viewing, but the CLI surface — `tail -f hub.log` and post-hoc `grep` — has no equivalent attribution. The owner has confirmed personal demand for project, session, and turn visibility before any external user has reported it; the bar is therefore "minimum that satisfies my own use without leaving room for regret," not "general-purpose log framework."

A 15-issue pre-mortem produced this scope. All retained decisions scored ≥ 9 / 10 against issue-specific weighted rubrics. Issues that scored < 9 were deferred to backlog rather than shipped at lower quality.

## Goals / Non-Goals

**Goals:**

- Every REQUEST and RESPONSE log line carries enough context that a single line, in isolation, identifies which project / session / human-turn / tool-loop step it belongs to.
- The CLI's logical-turn vocabulary is unambiguous against the dashboard's existing per-request `data-entry-idx` numbering. Both numbers appear in the prefix so the user can cross-reference in either direction.
- Server-side and dashboard-side classification of "human turn opener vs injected text" is driven by one shared module, eliminating the dual-write drift that would otherwise emerge as Claude Code adds new injected tag types.
- `computeTurnStep` is a pure function with unit-test coverage for eight boundary cases.

**Non-Goals:**

- Color or ANSI styling of log lines. (Deferred — TTY detection and color-blind concerns are not yet warranted.)
- Renaming the dashboard's "Turns" column to "Steps" / "Requests" or adding a "Rounds" column. (Deferred — the cross-reference goal is met by including both numbers in the CLI prefix.)
- Disambiguating projects that share a basename (e.g. two `app` directories from different parents). (Deferred — single-user project; if/when collision is observed, dynamic upgrade to `app:port` form is documented as future work.)
- Replacing the dashboard's inline `INJECTED_TAG_RE` with a `<script src>` load. The shared Node module is the source of truth; the dashboard continues to inline a copy whose synchronization is enforced by the new test rather than by runtime sharing. (Reduces blast radius; full convergence is deferred.)
- Persistence of the new prefix format in any on-disk JSON. The change is presentation-only; `*_req.json` and `*_res.json` schemas are unchanged.

## Decisions

### D1: `R<turn>.<step>` instead of repurposing the word "Turn"

The dashboard already uses "Turn" as the column header for what is really a per-request row keyed by `data-entry-idx` / `sessNum`. Reusing the word in the CLI to mean "logical human-input round" would produce a silent semantic collision: the user reads "T5" in the CLI and clicks "Turn 5" in the dashboard and sees a different request.

We therefore introduce a new short form `R<turn>.<step>` for the logical concept and keep the dashboard's existing column unchanged. To preserve cross-reference, the prefix also carries `#<sessNum>` — the dashboard's number — alongside `R<turn>.<step>`.

**Alternatives considered:**

- Rename the dashboard column to "Steps" or "Requests". Rejected: visible UI change, breaks existing user familiarity, and exceeds this change's scope. Logged as backlog.
- Use only `R<turn>.<step>` and rely on the user to mentally map. Rejected: defeats the cross-reference goal and forces the user to count.
- Use only `#<sessNum>`. Rejected: loses the human-input-round signal, which is the entire reason the user asked for turn information.

### D2: Logical turn = count of human-text user messages; step = user-message count from last human-text inclusive

A "turn" in this design is one human-typed input. Within a turn, Claude Code's tool loop produces N requests (one per tool round-trip plus the final assistant text); each is a `step`. The walk pattern over `messages[]`:

1. Iterate `messages[]`. A user message qualifies as a "human-text opener" iff it has at least one `text` content block whose text does not match `INJECTED_TAG_RE` (matching the dashboard's `classifyUserMessage` exactly).
2. `turn` = count of qualifying messages from index 0 through the last qualifying message's index.
3. `step` = count of `role: user` messages (any kind) from that last qualifying index inclusive through the end.

Validation against the canonical Claude Code tool-loop pattern:
- Step 1 — `[user_text]` → 1 user → turn=N, step=1.
- Step 2 — `[user_text, asst(tool_use), user(tool_result)]` → 2 users → step=2.
- Step 3 — `[user_text, asst, user(tool_result), asst, user(tool_result)]` → 3 users → step=3.

**Alternatives considered:**

- Detect new turn by `messages.length` increasing past a stored watermark. Rejected: stateful, breaks under `/clear` and `/compact`, and is impossible to unit-test as a pure function.
- Only count strings (treat any user message whose `content` is a string as human). Rejected: misses that Claude Code uses array-content user messages even for typed input, and silently mis-classifies `system-reminder` injected text.

### D3: Shared injected-tag module loaded by `require` only

The dashboard and the server need an identical regex and classifier. We extract the canonical version to `shared/injected-tags.js` exporting `INJECTED_TAG_RE` and `isInjectedText(text)`. Server uses `require('../shared/injected-tags')`. The dashboard, for now, retains its inline copy in `public/messages.js`; a unit test asserts the two definitions are character-identical so any drift fails CI.

**Why not load via `<script src>` in the dashboard now?** Two reasons. First, the dashboard's existing `INJECTED_TAG_RE` is a literal at module top-level; converting to a runtime-loaded global expands blast radius into the rendering hot path for marginal benefit. Second, the failure mode this change defends against is "Claude Code introduces a new tag and only one consumer is updated"; a CI test that compares the two literals catches this just as effectively as runtime sharing, with much lower risk. Full convergence is logged as backlog and revisited if the test ever fires.

### D4: cwd fallback through the hub client registry

`extractCwd` reads `Primary working directory:` from the system prompt. The first request of a session sometimes lacks this — for instance, the request that immediately follows a quota check, or any request that omits the system block. Rather than print `[?/...]` for that first request, the server consults `hub.js`'s registered client list, which records `pid` and `cwd` per attached client. If exactly one client matches the in-flight session (by 1:1 mapping in single-client mode, or by direct association in multi-client mode), its cwd basename fills the project field. If no unambiguous match exists, the field falls back to `?`.

**Alternatives considered:**

- Defer the prefix entirely until cwd is known. Rejected: produces inconsistent line widths and confuses grep.
- Persist the last-seen cwd globally and reuse it across sessions. Rejected: causes wrong attribution in hub mode.

### D5: Two-line layout with title above details

A single-line prefix-plus-summary form approaches 80 columns and overflows narrow terminals. The new format places attribution and HTTP method on line 1 and request details (model, system tokens, message count) on a second indented line. This preserves grep-ability of the title line, keeps the main column under 80 chars, and aligns with the existing `summarizeRequest` multi-line idiom.

```
📤 [12:01:23] [ccxray/3f8a2c1b · #42 R5.3]  POST /v1/messages
   opus-4-7 · sys 18,234 · msgs 46
📥 [12:01:24] [ccxray/3f8a2c1b · #42 R5.3]  ✓ 200  3.2s  out=1,420 tok
```

The previous `Messages: 42 (21u/21a)` line is removed; turn/step in the prefix conveys the same shape information more directly.

### D6: Pure function for testability in absence of a type-checker

The project has no TypeScript or other static checker. To compensate, the new `computeTurnStep(messages)` function is implemented with no closures over module state, no I/O, and explicit numeric return. A new `tests/turn-step.test.js` covers the eight boundary cases enumerated in the proposal, run by the existing `npm test` harness.

## Risks / Trade-offs

- **Risk**: Shared classifier diverges if a maintainer edits one copy and not the other. **Mitigation**: A CI test in `tests/turn-step.test.js` compares the two definitions character-by-character and fails on drift.
- **Risk**: Hub registry lookup returns the wrong cwd when two clients share a session id (race after pid reuse). **Mitigation**: Lookup requires unambiguous 1:1 match; on ambiguity, fall back to `?` rather than guess.
- **Risk**: `inferParentSession()` mis-attributes an orphan subagent during a brief window where two sessions are both in-flight. **Mitigation**: Pre-existing risk; this change only renders the result with a `~` marker so the user can see the attribution is inferred. No new mis-attribution is introduced.
- **Risk**: Prefix still wraps on terminals narrower than 80 columns when project basenames are long (e.g. `claude-code-experiments-2025`). **Mitigation**: Accepted. Two-line layout already mitigates the typical case; truly narrow terminals can resize.
- **Trade-off**: Persisted log files (`hub.log`) get a new format. No external parsers are known and the project is single-user, so no migration path is needed. Documented in proposal Impact section.
- **Trade-off**: Removal of the old `Messages: N (Xu/Ya)` line is a visible regression for anyone who was eyeballing message counts. The new turn.step plus `msgs N` on the details line covers the same need.

## Migration Plan

This change is forward-only and presentation-only.

- No data migration. Logs that pre-date this change retain their old format; new lines from this point on use the new format. Mixed format in a single `hub.log` file is acceptable and self-documenting (timestamps separate them).
- No flag, no opt-in. The new format is the only format.
- Rollback is a `git revert`.

## Open Questions

- Should the response line carry `out=<output_tokens>` from the SSE-captured response, or only what the upstream returned in headers? **Proposed**: prefer SSE-captured `output_tokens` since it's already computed by `forward.js`; fall back to `?` if unavailable.
- For multi-line streaming responses where `forward.js` currently emits incremental updates, should each emit carry the full prefix? **Proposed**: only the final completion line carries the prefix; in-flight chunks remain unchanged to avoid log spam. Open until tasks phase confirms `forward.js` emit points.
