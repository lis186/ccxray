# ccxray × agentflow integration

- Status: Draft
- Date: 2026-09-27
- Related: PR #637 (subagent import, proxy cwd, 1-hour cache pricing, indexed effort), ADR 0012 (index lines are the durable record), ADR 0017 (aggregate cost confidence)

## Goal

[agentflow](https://github.com/agfnow/agentflow) keeps an AI-assisted project's history in a notebook (`.agentflow/devlog.md`). This integration answers one question for every step recorded there: **how many tokens it used, which models, at what reasoning effort, how long it took, and what it cost.**

Both tools must keep working on their own:

- **ccxray without agentflow** behaves exactly as today. The integration is an adapter; nothing in core depends on it.
- **agentflow without ccxray** behaves exactly as today. Phase A requires no change to agentflow at all. Phase B proposes two optional, tool-neutral hooks upstream, and both are no-ops when nothing is configured.

ccxray's maintainer does not maintain agentflow. Anything that needs agentflow to change is a proposal to its author, never a fork we carry.

## agentflow concepts this spec relies on

| Term | Meaning |
|---|---|
| Notebook | A Markdown file, by default `.agentflow/devlog.md`. Feature streams have their own notebook under `.agentflow/features/<name>/`, in a separate git worktree. Old rounds are compacted into `<notebook-stem>.archive.md`. |
| Ask / Reply | One round. `# → Ask / A-012` is the request; `# ← Reply / A-012` is the answer. The Ask heading carries **no timestamp**; the Reply opens with a stamp line `* _YYYY-MM-DD HH:MM:SS ±HHMM (host/model/effort)_`. The stamp reads `claude/unknown` or `host/unknown` when agentflow cannot identify the model; it cannot for Claude today. |
| RUN / WIP | Timestamped progress records inside a round. |
| `agf close` | Atomic closeout: writes the Reply, hashes the notebook and commits (in a git repo). The commit message carries an `Agentflow-Close-Id: <64 hex>` trailer. **The notebook must not be modified after close**; agentflow re-verifies the hash. |
| Host | The interactive session (Claude Code or Codex) the owner talks to; the coordinator. |
| Internal worker | A native subagent of the host (for example a Claude Code Task agent). Its transcript sits under the host session. |
| External worker | A separate `claude -p`, `codex exec` or `grok` process spawned by `external-runner.js` in a disposable clone at `$TMPDIR/agentflow-external-runner-XXXXXX/clone` (on macOS `/private/var/folders/…/T/…`). The clone is deleted afterwards. agentflow persists **no** record of which Ask or role a worker served. |

## Architecture

```
            transcripts (~/.claude/projects, ~/.codex/sessions)   proxy traffic (optional)
                                   │                                     │
                                   ▼                                     ▼
                         ┌──────────────────── ccxray index (index.ndjson) ─────────────────┐
                         │ per turn: session, cwd, model, effort, tokens, cost, subagent,    │
                         │ turn duration, receivedAt, responseId                             │
                         └───────────────────────────────┬──────────────────────────────────┘
                                                         │ core: usage query
                                                         ▼
                                  adapters/agentflow: notebook → Ask windows → report
                                                         │
                                                         ▼
                                   <notebook-stem>.usage.md   ·   terminal report
```

The split is deliberate:

- **Core** gets one reusable capability, a usage query: `query({ roots, from, to }) → aggregate`. It selects turns by working-directory root and time range, folds in subagent turns through their parent link, and aggregates tokens, cost (with ADR 0017 confidence), models, effort and duration per executor. The next workflow tool integration reuses it unchanged.
- **The agentflow adapter stays thin.** It only turns a notebook into Ask windows, classifies executors, and renders the report. It never parses agentflow's prompts or briefs, because any wording change upstream would break it.

## Data sources

**Transcripts are the primary source; the proxy is opportunistic.** Measured on Claude Code 2.1.283 (see Evidence):

- **Main-thread turns match exactly.** Imported and proxied turns agree turn for turn, including cost.
- **Subagent cost was the only real gap.** Before #637 the importer skipped `subagents/*.jsonl`, which made import-only cost about 37% low.
- **Proxy-only traffic is small**, about 1% of cost: title generation, quota checks and `count_tokens`.
- **Transcripts carry everything the report needs:**
  - effort: Claude `effort`/`perTurnEffort`, Codex `turn_context.effort`
  - turn duration: Claude `turn_duration`
  - thinking tokens
  - tool arguments
  - subagent parent linkage
- **Transcripts outlive the proxy.** Claude transcripts are kept 365 days by default. Imported index lines are never pruned. Proxy raw logs are pruned after `LOG_RETENTION_DAYS` (14).

Consequences:

- **The report works when the proxy was never running**, and can be computed after the fact.
- **When the proxy was running, its turns merge with imported ones** through responseId (ADR 0012) and add the proxy-only traffic. No separate "measured vs estimated" label: the ~1% difference does not justify the complexity. The report footer names the sources used.
- **Codex children merge into the parent.** Codex child rollouts carry `session_id = parent_thread_id`, so the importer folds children into the parent session. Parent-window totals are right; parent vs child split is not available yet.

## Ask windows

A window is the time range whose turns belong to one Ask.

**Boundaries.** An Ask's window runs from the end of the previous round to the end of this one:

1. **In a git repository:** the committer time of the `agf close` commit that recorded the round. It is found as a commit touching the notebook whose message carries `Agentflow-Close-Id`. This avoids parsing Markdown timestamps and time zones.
2. **Fallback:** the Reply stamp, when there is no git, no matching close commit (local delivery, plain folder), or history was rewritten. Rebase changes committer time, and so do stream merge-back and squash. When the two sources disagree by more than a minute, prefer the stamp and note it.
3. The first Ask starts at the earliest turn in the notebook's root after the notebook was created.
4. An Ask without a Reply is **open**: its window ends now, and it is never frozen.

**Turn-level attribution.** Attribution is per turn, not per session. A long host session that spans several Asks is split at the window boundaries.

**Session selection.** A turn belongs to the notebook when:

- **Host turns:** its cwd equals the notebook's worktree root. The root is the worktree, not the repository, so feature streams in separate worktrees do not collide. The turn's session must also show evidence of working on this notebook: a tool call in the transcript that reads or writes the notebook path, or that runs agentflow's `agf` script with it. Sessions in the same directory that never touched the notebook are excluded. When no tool-argument evidence is available, fall back to cwd plus window, and mark the Ask `partial`.
- **Internal workers:** a subagent turn belongs to the Ask of its parent turn, via the parent link from #637.
- **External workers:** turns whose cwd matches `*/agentflow-external-runner-*/clone` inside the window. The clone path does not say which repository it came from. If exactly one notebook has an open window at that time, the turns go to it. Otherwise they are listed under every candidate Ask as `ambiguous`, and the grand total counts them once.

## Report

**Surface.** A side file next to each notebook, `<notebook-stem>.usage.md` (for example `.agentflow/devlog.usage.md`). It is also available as a terminal report.

- The side file is a **local, rebuildable cache**. ccxray adds it to `.git/info/exclude`, never to the project's `.gitignore`, so it stays out of commits and out of agentflow's repository-state checks.
- Sharing cost with teammates or across machines is **not** a Phase A goal; that is Phase B2's job.
- ccxray never writes to the notebook itself.

**Format.** Two levels: the Ask summary, then one row per executor.

```markdown
## A-012 · 14m32s wall · $0.184 · 42 calls · in 12.3k / out 3.1k / cache 210k (hit 94%)
- host · claude-opus-5-5 · effort high · 9m10s · $0.121 · 30 calls
  - subagent general-purpose · claude-sonnet-5 · effort high · 1m02s · $0.018 · 4 calls
- external · codex gpt-5.6-sol · effort low · 5m22s · $0.063 · 12 calls
```

- **Wall time** is the window's span. **Executor time** is the sum of `turnDurationMs` where the transcript has it: Claude interactive sessions do; `claude -p` does not write `turn_duration`. Otherwise it is first-to-last turn.
- **Effort** is the value actually sent. When one executor used more than one level, list each with its call count.
- **Unpriced turns** follow ADR 0017: the total is rendered with its confidence (for example a `+` lower bound).
- **Coverage labels:** `partial` means some expected evidence is missing: a fallback session match, an ambiguous external, or a window with turns but no transcript for a known executor. `unmeasured` means no turns were found at all.
- **Tool statistics** stay in the dashboard; the report does not list them.
- **The footer** states the sources used (transcripts and/or proxy) and the generation time.

**Freezing.** An Ask is **settled** when all of these hold:

- it has a Reply
- ccxray has no pending proxy requests in its window
- the transcripts covering the window have been imported
- a grace period (default 10 minutes) has passed since the window end

A settled Ask is frozen as a snapshot in ccxray's own data directory, and later runs reuse it. This keeps history stable against pruning and price-table changes. `--rebuild` recomputes, for example after a pricing fix.

## CLI

```
ccxray agentflow report [--notebook <path>] [--ask A-012] [--write] [--all] [--rebuild] [--json]
```

- **Defaults:** without `--notebook`, it uses the agentflow notebook for the current directory: `ag.json` `target-doc`, else `.agentflow/devlog.md`.
- **Output:** stdout by default. `--write` updates the side file. `--json` emits the aggregate for other tools.
- **`--all`:** covers every notebook under the project (root, feature streams, archives) and prints cross-notebook totals.
- **Isolation:** like every ccxray subcommand, it must not boot a server, prune, or import implicitly unless asked. Import freshness is ensured by an explicit import step.

## Phases

**A0 — prerequisites (done).** PR #637:

- subagent import
- millisecond import ids
- Claude 2.1.283 and Codex proxy cwd
- 1-hour cache-write pricing
- indexed `effort`, `thinkingTokens` and `turnDurationMs`

**A1 — MVP.**

- **Scope:** `report --ask` for one notebook, stdout only.
- **Test fixtures:** anonymised from the 2026-09-26 experiment sessions: a `claude -p` worker with a subagent, and an interactive host with a subagent and title generation.
- **Also includes:** the core usage query.
- **Validation:** two real Asks cross-checked against Claude Code's own cost.

**A2.** `--write`, snapshots and freezing, `--rebuild`, multi-Ask reports. The external-worker classification must be verified with a real `codex exec` worker.

**A3.** `--all`, feature streams and archives. Auto-watch is opt-in and off by default: it discovers projects from recorded cwds that contain `.agentflow/` and refreshes a side file when a new Reply appears.

**Dogfood.** Use the report daily in at least two repositories and collect five or more reports before Phase B. Record every row that looked untrustworthy and why.

## Phase B — proposals to agentflow upstream

Both hooks are framed as **generic observability extension points**, with ccxray as one reference implementation. Neither mentions ccxray in agentflow's code. agentflow removed its earlier metrics helper because it was unfinished, not because it opposed the idea.

**B1 — external worker run ledger.** This is the one gap Phase A cannot close: an external worker's **role** (implementation, cross-check, …) and its **source repository**. Proposal: `external-runner.js` appends one JSON line per run under the workspace `.tmp/`:

```json
{"ask":"A-012","role":"cross-check","executable":"codex","requested_model":"gpt-5.6-sol","requested_effort":"low","clone_path":"/…/agentflow-external-runner-N59FRB/clone","started_at":"…","ended_at":"…","exit":0}
```

- **No network or environment changes.** Base URLs are not rewritten, headers are not injected, and nothing is proxy-specific.
- **Joining:** ccxray joins the ledger to turns by `clone_path`. This gives exact role and repository attribution, and the requested effort, so the report can flag requested ≠ actual.
- **Value to agentflow itself:** today `external-runner` persists nothing, so the ledger also helps agentflow debug and audit its own runs.
- **Timing:** propose it early. It is small and independent of the report format.

**B2 — close-time usage reporter.** An optional `usage-reporter` command. `agf close` calls it before hashing and pastes its stdout verbatim into the Reply, so the figures live in the committed notebook and reach teammates.

- **Discovery:** `auto` resolves it from `PATH` only.
- **Failure handling:** 3-second timeout, fail-open. It writes `usage: unavailable` only when explicitly enabled and it failed.
- **Contract:** the command is called with `--contract 1`; agentflow never parses the output.
- **Cut-off:** figures are cut off at close time, so the post-close tail of the final turn is not included and is noted as pending.
- **Timing:** propose it after the report format is stable.

**Out of scope for both proposals:** agentflow's Reply identity stamp. ccxray can see the actual Claude model and effort that the stamp shows as `unknown`. The proposal may mention this, but changing the stamp is the upstream author's call.

## Known gaps and risks

- **Codex children merge into the parent session** (see Data sources). There is no per-child split until the importer uses the child `id`.
- **Codex background memory agents** run alongside `codex exec` (for example `thread_source: memory_consolidation`, and the proxy's `codex-raw` fallback session). They may lack cwd and a real session id. They are counted only when attributable; the remainder is visible as a `partial` coverage note.
- **A long host session spanning Asks** must be split per turn. Idle gaps between Asks belong to no Ask.
- **Several worktrees of one repository** must be distinguished by worktree root, or `ambiguous` becomes common.
- **The dashboard shows no projects or sessions** for a home populated only by `import --target-transcript`. This is under investigation and must be resolved before A1 ships, so a first-time user does not see an empty dashboard.
- **Grok is untested:** recorded Grok turns carry no cwd.
- **External worker transcripts after clone deletion:** Claude writes them to `~/.claude/projects/<slug-of-clone-path>/`, and they survive the clone. A2 must confirm the same for Codex rollouts.

## Non-goals

- Changing agentflow's notebook, its prompts, or its Reply identity stamp.
- Rewriting worker base URLs or injecting headers. This was tried on the abandoned `feat/ccxray-telemetry` fork branch, which is now frozen as tag `archive/ccxray-telemetry`.
- Estimating tokens inside agentflow.
- A dedicated agentflow dashboard page, at least until after dogfooding.

## Evidence (2026-09-26)

Two Claude Code 2.1.283 sessions were run through an isolated proxy (`CCXRAY_HOME` temp dir, port 5599, export and import disabled) and also imported from their transcripts:

- a `claude -p --model claude-sonnet-5 --effort low` worker with one Task subagent
- an interactive `--effort medium` host with one subagent

| | Proxy | Import before #637 | Import after #637 | Claude Code's own total |
|---|---|---|---|---|
| Worker session cost | $0.3230 (5-minute rate for all cache writes) | $0.2043 (no subagents) | $0.4030201 | $0.4030201 |
| Worker session turns | 12 requests | 7 | 11 (7 main + 4 subagent) | — |

- **Before #637, every proxied Claude request had `cwd: null`.** The Codex `exec` probe had the same defect: its cwd was present only inside `input[]` `<environment_context>`.
- **Effort was present on every request** (`output_config.effort` for Claude). Codex carried it as prewarm `metadata.reasoning_effort`.
