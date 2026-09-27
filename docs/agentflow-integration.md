# ccxray × agentflow integration

- Status: Draft (revised after adversarial review by GPT-6 Astra and Fable 5.1; revised again 2026-09-27 to put the proxy in the MVP, after a threeways review)
- Date: 2026-09-27
- Related: PR #637 (subagent import, proxy cwd, 1-hour cache pricing, indexed effort), #639 (CLI flags), #640 (live proxy cwd), #641, ADR 0012 (responseId read-time merge), ADR 0017 (aggregate cost confidence)

## Goal

[agentflow](https://github.com/agfnow/agentflow) keeps an AI-assisted project's history in a notebook (`.agentflow/devlog.md`). This integration answers one question for every step recorded there: **how many tokens it used, which models, at what reasoning effort, how long it took, and what it cost.**

Both tools must keep working on their own:

- **ccxray without agentflow** behaves exactly as today. The integration is an adapter; nothing in core depends on it.
- **agentflow without ccxray** behaves exactly as today. Phase A requires no change to agentflow at all. Phase B proposes two opt-in, tool-neutral changes upstream; both do nothing unless enabled.

ccxray's maintainer does not maintain agentflow. Anything that needs agentflow to change is a proposal to its author, never a fork we carry.

**Why this is ccxray's job.** Any tool can read transcripts. Only a proxy sees the requests that never reach a transcript, and for an interactive host those are real spend (see Data sources). So the report works without the proxy, labelled as a lower bound, and becomes complete when the proxy was running. The MVP reads both.

## agentflow concepts this spec relies on

Paths below are relative to the notebook's workspace directory: `ag.json` `workspace-dir`, `.agentflow` by default.

| Term | Meaning |
|---|---|
| Notebook | A Markdown file, by default `.agentflow/devlog.md` (`ag.json` `target-doc`). Feature streams usually live in their own worktree at `.agentflow/features/<key>/<key>.devlog.md`; notebook-only streams may share a checkout. Compaction moves old rounds into an archive: `devlog.md` → `devlog.archive.md`, `<topic>.devlog.md` → `<topic>.archive.md`. |
| Ask | The request of one round, under `# → Ask / A-012`. The heading has **no timestamp**. The body is the owner's prompt, captured verbatim by agentflow's `UserPromptSubmit` hook or typed into the notebook. A freshly scaffolded Ask may be empty. |
| Reply | The answer, under `# ← Reply / A-012`. It opens with a stamp line `* _YYYY-MM-DD HH:MM:SS ±HHMM (<identity>)_`. The identity is `model/effort` when agentflow could read it (Codex) and `<host>/unknown` otherwise; today that means always for Claude. Every closed round has a Reply stamp, whatever the delivery mode. |
| RUN / WIP | Progress records. Their timestamps are **not** progress times: RUN bodies submitted with a close manifest are stamped at close. |
| `agf close` | Publishes the Reply, re-verifying the notebook hash inside a lock, and then, as a separate step that can fail on its own, commits with an `Agentflow-Close-Id: <64 hex>` trailer. Delivery affects the commit:<br>• `local` inside a Git repository still commits.<br>• A plain folder never commits.<br>• A stream's closing commits are fast-forwarded on merge-back, so their timestamps survive.<br>Owners may also close rounds without `agf close` (the ccxray repo does, to keep its notebook uncommitted). Closed rounds are byte-verified again only on compaction and ownership adoption. |
| Host | The interactive session (Claude Code or Codex) the owner talks to; the coordinator. |
| Internal worker | A native subagent of the host, for example a Claude Code Task agent. Its transcript sits under the host session. A resumed subagent may serve a later Ask. |
| External worker | A separate `claude -p`, `codex exec` or `grok` process run by `external-runner.js`. Its clone is a fresh `$TMPDIR/agentflow-external-runner-XXXXXX/clone` by default, but a caller-chosen `clone_directory` is also allowed. The runner does not delete the clone. The runner itself records nothing about the Ask or role. |
| Dispatch record | For each external run, the coordinator writes `<workspace>/artifacts/<A-NNN-slug>/dispatch/<stage>-dispatch.json`, following `references/delegation.md` ("record profile, model, effort, … facts"). Observed fields: `stage`, `model`, `effort`, `started`, `finished`, `clone`, and the runner's full `result` (command, exit code, clone identity). It is **host-authored**: the format is a convention, not a script-enforced contract, and it may be missing or incomplete. |

## Architecture

```
    transcripts (~/.claude/projects, ~/.codex/sessions)      proxy traffic (optional)
                              │ import                                 │ live
                              ▼                                        ▼
             ┌──────────────── ccxray index (index.ndjson) ─────────────────┐
             │ per turn: session, cwd, model, effort, tokens, cost,          │
             │ subagent link, turn duration, receivedAt, responseId          │
             └──────────────────────────────┬────────────────────────────────┘
                                            │ provider reconciliation (merged data):
                                            │ Claude responseId merge · Codex one source per session
                                            ▼
                                  core: usage query
                                            ▼
      adapters/agentflow: notebook + dispatch records → Ask windows → report
                                            │
                                            ▼
             report store under the ccxray data dir  ·  terminal / JSON
```

- **Core** gets one reusable capability, a usage query: `query({ roots, from, to, sessions? }) → aggregate`. It reads **merged data**, never raw index lines (see Deduplication), and **merges before it filters**: selection by session and cwd uses the merged row, because a proxy row recorded before #640 has `cwd: null` and only its merged twin carries the path. A proxy-only row with no twin (a prompt suggestion, say) takes its session's cwd. It selects turns by working-directory root, time range and optionally session. It folds in subagent turns per turn through their parent link, and aggregates tokens, cost (with ADR 0017 confidence), models, effort and duration per executor. The next workflow tool integration reuses it unchanged.
- **The agentflow adapter stays thin.** It turns notebooks and dispatch records into Ask windows, classifies executors, and renders the report. It never parses agentflow's prompts or briefs.

## Data sources

**The MVP reads both sources, merged.** Transcripts make the report work on its own; the proxy makes it complete. Measured on Claude Code 2.1.283 (see Evidence):

- **Claude main-thread turns match** between import and proxy after #637, turn for turn and in cost.
- **Some requests never reach a transcript.** Claude Code's prompt-suggestion requests (predicting the owner's next message, each re-reading the whole cached context) and its title-generation requests are billed but not written to the transcript. This is structural, not a sampling artefact, so a transcript-only host figure is always a **lower bound**. How low depends on session type and length:
  - **`claude -p` workers:** negligible. Import came within 0.1% of the proxy and of Claude Code's own total.
  - **Interactive hosts:** one measured two-prompt session was **11.7% low** (6 proxy-only rows, about $0.08 of $0.7334; re-verified on `e1b882c`, 2026-09-27). This is one measurement, not a calibrated correction; the share will vary with session length, the number of suggestions and context size.
  - agentflow's coordinator is always an interactive host, so a transcript-only report systematically under-counts its most expensive row.
- **Prompt suggestions are host cost.** The MVP adds them to the host row. Showing them as a separate category is a display change deferred to later.
- **Transcripts carry everything the report needs:**
  - effort: Claude `effort`/`perTurnEffort`, Codex `turn_context.effort`
  - turn duration: Claude `turn_duration`, written only by interactive sessions, not by `claude -p`
  - thinking tokens
  - tool arguments
  - subagent parent linkage

Retention bounds what can be recomputed later:

- **Claude Code deletes transcripts after `cleanupPeriodDays`, 30 days by default.** Machines configured longer keep them longer.
- **Proxy raw logs** are pruned after `LOG_RETENTION_DAYS` (14), and **their index lines go with them** (`server/restore.js` `_shouldKeepIndexLine`, #344): a proxy line is kept only while its `_req.json` survives.
- **Imported index lines are kept, except the twin of a pruned proxy turn.** An imported line whose responseId some proxy line also carried is deleted once no proxy copy of that responseId survives. A later import restores it if the transcript still exists; proxy-only rows (prompt suggestions, titles) are gone for good.

So a report recomputed after 14 days loses its proxy-only rows and drops from `complete` to `transcripts only`; after the transcript retention window it loses the rest. Snapshots (see Freezing) are the durable record; they ship in A1b, and A1a says in its output that its figures are recomputed from what is still on disk.

**Deduplication across sources** is per provider:

- **Claude:** proxy and imported turns merge by responseId (`msg.id`, ADR 0012). Verified: with both sources in one home, the server's read path returned the proxy count and Claude Code's exact total. The merge happens at **read time**, while `index.ndjson` holds both rows, so the adapter never sums raw lines. It **calls the same merge function the server uses** (`store.mergeByResponseId`, as the cold-load path `server/routes/api.js` does) rather than calling a running server's API, because the CLI must work with no server. Requiring it must stay side-effect free (no timers, writes or price fetches), guarded by a test; whether the function first moves into its own module is an implementation choice. Known merge caveats carried into the report:
  - Lines without a responseId (legacy) are not merged and are reported as-is.
  - For a responseId seen under two sessions, the merge assigns the turn to the highest-identity copy's session (ADR 0012 scope note). The report follows the merge, not `sessions.json`.
  - Until pricing is unified (see Phases), the two copies of a turn can carry different cost confidence; the merge keeps the richest usage and a priced cost.
- **Codex:** neither imported nor proxied turns carry a responseId, so ADR 0012 does not apply and naive union double-counts. Verified: the read path returned four rows for a two-turn session. Until a tested Codex reconciliation key exists (session id plus turn id, or session plus timestamp within tolerance), the adapter uses **one source per Codex session**: the proxy if it recorded that session, otherwise the import. The report footer says which.
- **Codex children** (`session_id = parent_thread_id`) import merged into the parent session. Parent totals include them; a per-child split is not available.

### Completeness

Every Ask carries one completeness label, derived from the data at report time (never stored in A1a):

| Label | Meaning |
|---|---|
| `complete` | Every host transcript turn in the window has a proxy twin (same responseId), so the host's traffic went through the proxy, including requests that never reach a transcript. |
| `partial proxy coverage` | Some host turns in the window have a proxy twin and some do not. |
| `transcripts only` | No proxy twin in the window. The host total is a lower bound: in one measured interactive session it was 11.7% low. |

Why per-turn twins are enough evidence: a Claude Code session's base URL is fixed at launch, so its requests all go through the proxy or none do, and a stopped hub makes requests fail rather than bypass it (inferred from launch behaviour, not separately measured). A request that failed while the hub was down was not billed. Workers are labelled the same way but a transcript-only worker is not flagged as low, since `claude -p` was measured complete within 0.1%.

**Codex** has no responseId, so completeness follows the one-source rule: a session read from the proxy is `complete`, one read from import is `transcripts only`.

This replaces the earlier "no separate measured vs estimated label" rule, which assumed the proxy added only about 1%. The 2026-09-27 re-verification disproved that for interactive hosts.

Because proxy lines are pruned after 14 days (see Retention), a recomputed Ask can move from `complete` to `transcripts only`. That downgrade is honest, never a false `complete`; freezing in A1b keeps the original figure.

## Ask windows

A window is the half-open time range `[start, end)` whose turns belong to one Ask.

**End.** The Ask's Reply stamp. It is always present and parsed with agentflow's local-time format. When the round has a matching close commit (`Agentflow-Close-Id`, touching this notebook, whose tree contains this Reply), its committer time is a cross-check only: if the two disagree by more than a minute, keep the stamp and flag the Ask. An Ask with no Reply is **open**: its window ends now and it is never frozen.

**Tail.** Wrap-up turns (the host telling the owner it is done) follow the Reply stamp by seconds. The window therefore ends at `stamp + tail` (default 2 minutes, capped at the next Ask's start); observed tails were 0–35 s.

**Start.** The timestamp of the host-transcript user message that contains the Ask body's **first bullet**, after whitespace normalisation. agentflow's hook captures the owner's prompt verbatim, so this is the moment the owner asked. Only the first bullet is used, for three reasons:
- A pasted prompt is split into one bullet per paragraph in the notebook.
- Later bullets record follow-ups and task notifications, which render differently from the transcript.
- The notebook side may wrap text in `<pasted_content>` tags, which are stripped before matching.

The matched message also identifies the **host session**; the Reply stamp cannot, since it reads `host/unknown` for Claude. Turns before the first Ask's start, such as a bare `godev` bootstrap, form a `setup` row rather than disappearing.
- **Fallback:** the previous round's Reply stamp. The Ask is then labelled `estimated start`, because idle time and unrelated work in that gap may be included.
- **Empty Asks** (scaffolds with no body) have no window.

Edge cases:

- **Idle time** between a Reply and the next Ask's start belongs to no Ask.
- **Several Asks closed together** each keep their own start. Where two windows overlap, turns are assigned to the Ask whose start is the most recent before the turn, and the overlap is flagged.
- **A retried or failed close** uses the stamp that finally stands in the notebook; a Reply that was replaced is ignored.
- **A reopened round** (the owner appends to an Ask after its Reply) extends that Ask only if the new text appears in the Ask body. Otherwise the new work belongs to the next Ask.

## Attribution

**Per turn, never per session.** A long host session is split at window boundaries; a resumed subagent's turns follow the Ask whose window contains them.

**Host turns** belong to a notebook when both hold:

1. The turn's cwd is the root of the checkout the notebook lives in: the worktree for a stream, the repository or folder otherwise.
2. The session shows evidence of working on this notebook: a user message matching one of its Asks, or a tool call whose arguments mention the notebook path (relative or absolute), `agf`, or the notebook's workspace directory. Bash command text counts.

Sessions in the same directory without such evidence are excluded. If evidence cannot be read (transcript gone, arguments unavailable), fall back to cwd plus window and mark the Ask `partial`.

Both conditions are tested on merged rows. **Proxy-only host requests** (prompt suggestions, title generation) belong to the host session they carry, so they join the host row even though no transcript mentions them.

**Internal workers.** Subagent turns follow their parent session through the #637 parent link and are assigned per turn by time.

**External workers.** Joined in this order:

1. **Dispatch records.** The directory `A-NNN-slug` gives the Ask; `stage` gives the role; `model`/`effort` give the requested values; `started`/`finished` and `clone` give the run. Worker turns are those whose cwd equals `clone` and whose time falls in `[started, finished]`. The time bound matters because clone paths can be reused or caller-chosen. Requested and actual effort are compared, and a mismatch is flagged.

   Verified on 18 real records (ccxray A-001…A-003, all Claude workers):
   - each matched exactly one session
   - every turn fell 1–2 s inside the time bound
   - requested and actual model and effort agreed
   - no clone path was reused

   Match on the recorded `cwd`, not on a transcript directory name derived from the path: Claude replaces every non-alphanumeric character, including `_`, with `-`. Actual effort comes from the transcript's top-level `effort`; `perTurnEffort` was always null. Token totals from raw Claude transcripts must count each `message.id` once, because a turn's usage is repeated on every content-block line. ccxray's importer already does this.
2. **No dispatch record.** Turns whose cwd matches `*/agentflow-external-runner-*/clone` inside a window. If exactly one notebook has a window open at that time they go to it, role `unknown`, Ask marked `partial`. Otherwise they are listed as `ambiguous` under each candidate and counted once in the grand total.

**Codex background agents** (for example `thread_source: memory_consolidation`) carry a cwd and their own session id, so they can land in an open window. They are listed as a separate `background` executor row, not merged into the host.

## Report

**Location.** A1a prints to the terminal only. From A1b, `--write` stores reports in ccxray's data directory, outside the project: `<CCXRAY_HOME>/agentflow/<project-id>/<notebook-id>.usage.md`, plus a snapshot store. `project-id` is derived from the resolved checkout root; `notebook-id` from the notebook's path relative to it. This keeps the project tree untouched, so agentflow's stream cleanup, which refuses unknown ignored files, is never affected.

**Optional side file (`--beside`)** writes `<notebook-dir>/<notebook-stem>.usage.md` next to the notebook:

- It is excluded through `$(git rev-parse --git-common-dir)/info/exclude`, the repository-wide exclude that linked worktrees share. The literal `.git/info/exclude` is wrong in a worktree.
- It is refused inside stream worktrees, and in plain folders without `--force`, until agentflow recognises the file (a small upstream request, listed under Phase B).
- The side file is a local, rebuildable view. Sharing cost with teammates is Phase B2's job.
- ccxray never writes to the notebook itself.

**Format.** Two levels: the Ask summary, then one row per executor.

```markdown
## A-012 · complete · 14m32s · $0.184 · 42 calls · in 12.3k · out 3.1k · cache read 210k / write 8.1k (read share 94%)
- host · claude-opus-5-5 · effort high · 9m10s · $0.121 · 30 calls
  - subagent general-purpose · claude-sonnet-5 · effort high · 1m02s · $0.018 · 4 calls
- external cross-check · codex gpt-5.6-sol · effort low (requested low) · 5m22s · $0.063 · 12 calls
- background · codex gpt-5.6-terra · effort low · $0.004 · 2 calls
```

- **Ask time** is `end − start`. **Executor time** is the sum of `turnDurationMs` where present; otherwise first-to-last turn, marked `duration estimated`. Until the importer upserts late fields (A1b), already-imported turns may lack `turnDurationMs`.
- **"read share"** is cache-read tokens ÷ (input + cache-read + cache-write) tokens.
- **Effort** is the value actually sent; if an executor used several levels, each is listed with its call count.
- **Unpriced turns** follow ADR 0017: the total is rendered with its confidence (for example a `+` lower bound).
- **Completeness** (`complete`, `partial proxy coverage`, `transcripts only`) heads every Ask; see Completeness.
- **Other labels:**
  - `partial`: some expected attribution evidence is missing
  - `duration estimated`: executor time is first-to-last, not measured
  - `estimated start`: see Ask windows
  - `ambiguous`: see Attribution
  - `unmeasured`: no turns found
  - `revised`: a frozen snapshot was recomputed and changed
  - a `setup` row: turns before the first Ask's start
- **The footer** states the sources per provider, the generation time, and snapshot status. In A1a, which has no snapshots, it also says the figures are recomputed from data still on disk and may change after proxy pruning (14 days), transcript deletion (30 days) or a price-table update.
- **Tool statistics** stay in the dashboard.

**Privacy.** Reports and `--json` contain only the fields shown above: Ask id, executor kind, role, model, effort, durations, token counts, costs, call counts and labels. They never contain prompts, Ask text, tool arguments or transcript content. Absolute paths are omitted: clones appear as their role, checkouts as their notebook path. Files are written with owner-only permissions (0600, directories 0700). Matching Ask text against transcripts happens in memory only.

## Freezing

Snapshots keep history stable against transcript deletion, proxy pruning and price-table changes. They ship in A1b; a snapshot also freezes the Ask's completeness label.

**Settled** is decided from on-disk data only; the CLI never needs a running server. An Ask is settled when all of these hold:

- it has a Reply stamp
- `now ≥ end + grace` (default 30 minutes)
- no index line falls inside its window that is newer than `end + grace`
- every transcript file that contributed to the window is unchanged in size and mtime for at least the grace period

A snapshot stores the aggregate plus what it was computed from:

- the notebook identity: path, Ask id, and a hash of the Ask heading and Reply stamp
- a fingerprint of each contributing transcript: path, size, mtime
- the importer/parser revision and the pricing revision

On each run the adapter compares these fingerprints:

- **A changed Reply or Ask identity** invalidates the snapshot.
- **A newer parser or pricing revision** makes it recomputable. `--rebuild` recomputes, and a change is shown as `revised`.
- **A transcript that has since been deleted** keeps the snapshot as is; that is the point of freezing.

Late transcript fields such as `turn_duration` are covered by the grace and size/mtime checks. Import must upsert missing fields for already-imported turns rather than skip them by responseId (today `isAlreadyImported` skips them, and `turn_duration` is attached only within one parse); otherwise a re-import cannot repair them. This importer change ships in A1b.

## CLI

```
A1a:    ccxray agentflow report [--notebook <path>] [--ask A-012] [--json]
A1b:    … [--write] [--rebuild]
later:  … [--beside] [--all]
```

- **Defaults:** without `--notebook`, it uses the notebook for the current directory: `ag.json` `target-doc` within `workspace-dir`, else `.agentflow/devlog.md`.
- **Output:** stdout by default. `--write` updates the report store (plus the side file with `--beside`). `--json` emits the aggregate.
- **`--all`:** covers every notebook of the project, including feature streams, archives and notebook-only streams. Archived rounds are deduplicated against the live notebook by Ask id and Reply stamp, and a notebook copied by stream merge-back is counted once.
- **No side effects unless asked:** like every ccxray subcommand, it must not boot a server or prune. It does not import implicitly; freshness comes from an explicit `ccxray import --once` or the running hub. The report says when the newest imported turn is older than the window end.

## Phases

**A0 — prerequisites (done).** PR #637:

- subagent import
- millisecond import ids
- Claude 2.1.283 and Codex proxy cwd on stored bodies
- 1-hour cache-write pricing
- indexed `effort`, `thinkingTokens` and `turnDurationMs`

PR #639 stopped unknown CLI flags from booting a server. PR #640 fixed cwd on live Claude Code 2.1.283 proxy traffic (#637's fix had worked only on stored bodies). PR #641 is a dashboard security fix, unrelated to this integration.

**Prerequisite — one pricing source.** The proxy, CLI import and server reload paths must price a turn identically, including models missing from the built-in rates (see Known gaps). Handled separately, before A1a; without it, the two copies of a merged turn can disagree on cost.

**A1a — terminal report on merged data (MVP).**

- **Scope:** `ccxray agentflow report [--ask A-NNN] [--json]` for one notebook, stdout only. This includes:
  - reading merged data (Claude responseId merge through the server's merge function; Codex one source per session), merged before filtering
  - the completeness label per Ask
  - Ask windows: start by first-bullet match, end at Reply stamp plus tail, and the `setup` row
  - attribution: host (prompt suggestions and title generation included), internal subagents, and external workers joined by dispatch record
  - the A1a footer: recomputed from data on disk, may drift
- **Acceptance:** this repository's own notebook, A-001 to A-007, reading `.agentflow/devlog.md` and `.agentflow/devlog.archive.md` as explicit inputs, plus the dispatch records under `.agentflow/artifacts/`. Cross-check against Claude Code's own totals where available. Run it while those Asks are within the 14-day proxy retention (A-001’s Reply is stamped 2026-09-27, so its proxy rows age out around 2026-10-11), or the proxy-only rows will already be pruned. General archive discovery is not part of A1a.
- **Test fixtures:** anonymised from the 2026-09-26 experiment sessions, plus a notebook with an empty scaffold, a retried close, two overlapping windows, a window with partial proxy coverage, a pre-#640 proxy row with `cwd: null`, and a pruned proxy turn.

**A1b — persistence.** `--write` into the report store, snapshot freezing (including the completeness label), `--rebuild`, and the importer upsert for late fields such as `turn_duration`.

**Later.**

- a separate display category for prompt-suggestion and title-generation requests (they stay in the host row until then)
- attribution for external workers without dispatch records
- background-agent rows
- `--beside` with the Git-common-dir exclude
- feature streams, archives in general and notebook-only streams (`--all`)
- opt-in auto-watch, off by default: discovers projects from recorded cwds whose checkout contains an agentflow workspace, and refreshes reports when a new Reply appears
- a real `codex exec` worker verified end to end

**Related, not blocking.** The stored `_req.json` format work (a ccxray-internal design of 2026-09-27, stage "B1" there; not this spec's Phase B1): a shared rebuild module, `ccxray show-request <id>`, and a format marker. It is deferred. A1 reads the index, not stored request bodies, so it does not depend on it. Anyone checking wire-level facts for this integration, such as whether a request carries `system`, must use a rebuilt request rather than raw `_req.json`: that mistake caused #637's live-cwd miss.

**Dogfood.** Use the report daily in at least two repositories and collect five or more reports before Phase B. Record every row that looked untrustworthy and why.

## Phase B — proposals to agentflow upstream

All proposals are framed as generic observability extension points with ccxray as one reference implementation. None mentions ccxray in agentflow's code, and each does nothing unless enabled. agentflow removed its earlier metrics helper because it was unfinished, not because it opposed the idea.

**B1 — make the dispatch record a contract.** agentflow already writes dispatch records by convention. The proposal is to have a script write the stable subset, so that it no longer depends on the coordinator's diligence. When the caller passes `--record <path>` with `ask` and `stage`, `external-runner.js` appends crash-safe start and end events carrying:

- a run id
- `ask` and `stage`
- repository, worktree and notebook identity
- the host session id
- executable, requested model and effort
- clone path, start/end times and exit status

The runner does not know the Ask or stage today, so the caller supplies them; this is a small change to the documented dispatch step, not a new concept. Value to agentflow itself: auditable, machine-readable run history. Propose this early; it is independent of the report format.

**B2 — writer-owned usage block at close.** An opt-in `usage-reporter` command whose output agentflow places in the Reply as a **writer-owned block**, treated like the stamp:

- **Placement and retries:** the block is fenced, placed right after the stamp, and stripped before the retry comparison in `match_closed_close`.
- **Generation:** generated once per close attempt, persisted with that attempt, and reused byte for byte on retry.
- **Validation:** output is size-capped and rejected if it contains fences, headings or `* _` stamp lines.
- **Invocation:** the command receives the notebook path, Ask id and cutoff time. It is resolved from `PATH` only, and is called with `--contract 1`. It has a 3-second timeout, after which its process group is killed. It fails open, writing `usage: unavailable` only when explicitly enabled and it failed.
- **Cut-off:** the closing turn's own usage does not exist yet at close, so the block covers the Ask up to the close request and says so.

Propose this after the report format is stable.

**B-minor — recognise the side file.** Add `*.usage.md` beside notebooks to agentflow's list of recognised ignored files, so `--beside` works in stream worktrees.

**Out of scope:** agentflow's Reply identity stamp. ccxray can see the actual Claude model and effort that the stamp shows as `unknown`. The proposal may mention this, but changing the stamp is the upstream author's call.

## Known gaps and risks

- **Proxy rows recorded before #640 have `cwd: null`** on live Claude Code 2.1.283 traffic (#640 fixed the live path; existing lines were not rewritten). Attribution merges first, so such a row takes cwd from its imported twin, or from its session when it has none.
- **Pricing differs by path for models missing from the built-in rates.** For `gpt-6-astra`, with identical tokens:
  - the proxy priced $0.1861 (`exact`)
  - the CLI targeted import priced $0.0558 (`fallback`, apparently without the pricing cache)
  - the server's reload repriced the same rows to a third figure

  One rate source for every path is a prerequisite before A1a (see Phases).
- **Prompt-suggestion requests are classified as main (`Orchestrator`) turns** in the proxy. The MVP counts them as host cost, which is correct; a separate display category is deferred.
- **Proxy index lines are pruned after 14 days, together with their imported twins** (see Retention). A1a figures for older Asks drop proxy-only rows and fall to `transcripts only`; A1b snapshots are the fix.
- **Codex reconciliation.** Proxy and import cannot be merged per turn yet (one source per session). Children merge into the parent.
- **Ask-start matching** fails when the owner edits the notebook directly instead of prompting, or when the hook did not run. Those Asks fall back to `estimated start`.
- **Dispatch records are conventions.** They may be missing, late or hand-edited; the join validates cwd and time and degrades to `partial`.
- **Transcript retention** (30 days by default) limits recomputation; frozen snapshots (A1b) are the durable record after that.
- **Several checkouts of one repository** are distinguished by resolved checkout root; symlinked paths are resolved before comparison.
- **The dashboard hides imported turns by default** (since `8e846c2`), because imported turns have no request/response files to open. The adapter reads merged index data itself, and A1a points report users to `/?imported`.
- **Grok is untested:** recorded Grok turns carry no cwd.

## Non-goals

- Changing agentflow's notebook, its prompts, or its Reply identity stamp.
- Rewriting worker base URLs or injecting headers. This was tried on the abandoned `feat/ccxray-telemetry` branch of the agentflow fork, now frozen as tag `archive/ccxray-telemetry` in `lis186/agentflow`.
- Estimating tokens inside agentflow.
- Putting prompts, tool arguments or transcript content into any report.
- A dedicated agentflow dashboard page, at least until after dogfooding.

## Evidence (2026-09-26)

Two Claude Code 2.1.283 sessions were run through an isolated proxy (`CCXRAY_HOME` temp dir, port 5599, export and import disabled) and also imported from their transcripts:

- a `claude -p --model claude-sonnet-5 --effort low` worker with one Task subagent
- an interactive `--effort medium` host with one subagent

| | Proxy (pre-#637) | Import before #637 | Import and proxy after #637 | Claude Code's own total |
|---|---|---|---|---|
| Worker session cost | $0.3230 (5-minute rate for all cache writes) | $0.2043 (no subagents) | $0.4030201 | $0.4030201 |
| Worker session turns | 12 requests | 7 | 11 (7 main + 4 subagent) | — |

- **Before #637, every proxied Claude request had `cwd: null`.** The Codex `exec` probe had the same defect: its cwd was present only inside `input[]` `<environment_context>`.
- **Effort was present on every request** (`output_config.effort` for Claude). Codex carried it as prewarm `metadata.reasoning_effort`.

The adversarial review (2026-09-27) checked the agentflow facts above against `agfnow/agentflow` `upstream/main` 738d0b3.

### Re-verification on merged `main` (2026-09-27)

**Setup:**
- A fresh worktree at `e1b882c` (after #637 and #639). The listening process was confirmed to run from that worktree.
- One isolated home received both the proxy capture and a later targeted import.
- Sessions:
  - a `claude -p --effort low` worker with a Task subagent
  - an interactive `--effort medium` host (two prompts, one subagent)
  - `codex exec -m gpt-6-astra -c model_reasoning_effort=low`

| Session | Proxy | Import | Read path (both sources) | Tool's own figure |
|---|---|---|---|---|
| `claude -p` worker | 8 rows, $0.3473501 | 7 rows (3 subagent), $0.3470001 | 8 rows, $0.3473501 | $0.3473501 |
| Interactive host | 15 rows, $0.7334 | 9 rows (3 subagent), $0.6477 | 15 rows, $0.7334 | not available (`/cost` shows plan usage only) |
| Codex worker | 2 rows, $0.2132 (`exact`) | 2 rows, $0.0639 (`fallback`) | 4 rows (double-counted) | 17,967 tokens, matching both sources |

- **Interactive host gap:** the 6 proxy-only rows are 2 title generations and 4 prompt suggestions, about $0.08, or 11.7%.
- **Proxy cwd was null** for all 23 Claude rows (see Known gaps).
- **Effort was recorded on both paths:** `low` and `medium` as sent; `high` on title generation.

Core assumptions checked against real data, read-only:
- **Dispatch join:** 18 of 18 ccxray dispatch records matched exactly one worker session within their time bounds, with matching model and effort.
- **Ask start:** A-001…A-004 each matched a host user message by first bullet, in the only session in that checkout active during the windows.
  - 992 of 1,033 host turns fell inside windows.
  - 13 were a pre-Ask `godev` bootstrap.
  - 28 were wrap-up turns 0–35 s after a Reply stamp. This led to the `tail` rule.
- **No close commits:** the ccxray repository has no `Agentflow-Close-Id` commits, confirming that the Reply stamp, not a close commit, must be the primary boundary.
