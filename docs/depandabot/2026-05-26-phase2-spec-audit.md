# depandabot audit — Phase 2 Spec Implementation Readiness

## §1 Current State

1. **openspec structure created** with 11 requirements in `specs/two-domain-auth/spec.md`, Phase 1 archived change (all tasks `[x]`), Phase 2 active change (49 open tasks across 4 sections), Phase 3 placeholder. All in `openspec/` but not yet committed.

2. **Phase 2 design.md has 6 decisions** with complete caller inventory (7 HTTP hub routes, 5→socket, 2→keep HTTP), framing protocol choice, socket lifecycle, verifyUpstream rewrite, version bump timing, Windows fallback documentation.

3. **Phase 2 tasks.md has 49 unchecked items** spanning commit 2.1 (19 tasks), 2.2 (15 tasks), 2.3 (11 tasks), PR (4 tasks). Each task is concrete (file + function + action).

4. **Prior depandabot audit (phase2-implementation-readiness) returned PROCEED_AMENDED** — plan is directionally approved with 5 amendments incorporated into the openspec design.md.

5. **`ccxray secret upstream` CLI is referenced in candidate-AB.md** (L367, L469, L488) as the user-facing way to retrieve `K_upstream` for scripts/curl, but is **missing from both spec.md and Phase 2 tasks.md**.

## §2 Intended Goal

Should we proceed with implementing Phase 2 using `openspec/changes/2026-05-26-auth-phase-2/` (proposal + design + tasks) as the execution spec?

## §3 Current Plan

1. Commit openspec files to main
2. Create `feat/auth-phase-2` branch from main
3. Execute tasks.md in order (2.1 → 2.2 → 2.3 → PR)
4. TDD discipline per task, `npm test` after each section
5. Smoke test per [[feedback-smoke-test-before-commit]]
6. Codex review gate before merge

## §4 Missing Directional Confirmations

1. **[risk]** `ccxray secret upstream` CLI command is missing from the spec and tasks. When 2.2 enforces `X-Ccxray-Auth`, users who `curl` the proxy need `$(ccxray secret upstream)` to get the token. Without it, enforcement has no documented escape hatch for script users.
2. **[assumption]** The spec's 11 requirements cover all auth-related behavior. Cross-checked against code: `classifyUpstreamAuth`, `isJwtShaped`, `getUpstreamToken` are helpers not called out as requirements — acceptable since they're implementation details under "Upstream authentication" and "WebSocket upgrade auth gate."
3. **[unknown]** Phase 3 has no design.md — only proposal + tasks. Acceptable because Phase 3 is pure deletion (no new design decisions), but should we write one anyway for completeness?
4. **[assumption]** The openspec format (proposal + design + tasks) matches the project's existing convention well enough to serve as execution spec. Verified against 5 archived changes — format is consistent.

## §5 Evidence & Arguments

**Non-empirical exemption invoked.** This audit is about internal spec completeness against the codebase — not a web-verifiable topic. External evidence about openspec methodology is irrelevant; what matters is whether the specs faithfully reflect the codebase state and design decisions.

**Internal evidence used:**

1. **candidate-AB.md L367, L469, L488** — Three distinct references to `ccxray secret upstream` as a user-facing CLI command for retrieving `K_upstream`. The enforcement CHANGELOG (L488) instructs users: `curl -H 'X-Ccxray-Auth: $(ccxray secret upstream)'`. Without this command, the migration guide tells users to run something that doesn't exist. → §4.1

2. **server/providers.js:12** — `K_upstream` derivation already exists in `getUpstreamToken()` as a private helper. Exposing it as a CLI subcommand is ~10 LOC in the CLI section of `server/index.js`. → §4.1

3. **5 archived openspec changes** (star-hotkey, star-retention, credential-scanning, hub-lifecycle, miller-keyboard) — all follow proposal + design + tasks format. Phase 1 archived change matches. Phase 2 matches. Phase 3 omits design.md (no design decisions to document for a pure-deletion phase). → §4.3, §4.4

4. **[Dissent: Phase 3 without design.md]** — Every other openspec change with >2 tasks has a design.md. Phase 3 has 9 tasks. While they're all deletions, the _matchesLegacyToken consolidation (carried from review O1) is a structural decision. Counter-argument: the consolidation is already documented in Phase 2's design.md decision 4 and review O1. Duplicating it in Phase 3's design.md adds no information. → §4.3

## §6 Second Opinion

### Round 1 — Reviewer verdict: AGREE

| ID | Severity | Category | Summary |
|----|----------|----------|---------|
| O1 | high | implementation | `ccxray secret upstream` missing from spec + tasks |
| O2 | low | conceptual | Phase 3 lacks design.md |
| O3 | low | implementation | No Windows fallback verification task |

### Claude's response (all accept-and-amend):

- **re: O1** — Accept. Amended: added requirement "CLI secret retrieval" to `spec.md`, added tasks 2.0 + 2.0.1 to Phase 2 `tasks.md`, added `ccxray secret upstream` reference to CHANGELOG task 3.8.
- **re: O2** — Re-tag as **implementation** (adding a stub doc is formatting, not a directional choice). Accept. Amended: created `design.md` for Phase 3 with "decisions inherited from Phase 2" stub.
- **re: O3** — Accept. Amended: task 5.4 now explicitly notes Windows limitation in PR description. No CI runner = documented known gap.

PROCEED_AMENDED
