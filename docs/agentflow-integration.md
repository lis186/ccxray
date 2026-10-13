# ccxray × agentflow integration

- Status: Draft (revised after adversarial review by GPT-6 Astra and Fable 5.1; revised again 2026-09-27 to put the proxy in the MVP, after a threeways review; completeness, `complete` judgement and A1a duration decided by the owner the same day; revised 2026-10-06 after experiments on concurrent coordinators, Ask windows and a Codex worker, and two further adversarial reviews by GPT-6 Astra and Fable 5.1; revised 2026-10-07 for projects developed on several machines, after a third pair of reviews and a survey of existing multi-machine usage tools; revised 2026-10-09 to settle the external-worker rules the implementation exposed, after a fourth pair of reviews)
- Date: 2026-10-06
- Related: PR #637 (subagent import, proxy cwd, 1-hour cache pricing, indexed effort), #639 (CLI flags), #640 (live proxy cwd), #641, ADR 0012 (responseId read-time merge), ADR 0017 (aggregate cost confidence)

## Goal

[agentflow](https://github.com/agfnow/agentflow) keeps an AI-assisted project's history in a notebook (`.agentflow/devlog.md`). This integration answers one question for every step recorded there: **how many tokens it used, which models, at what reasoning effort, how long it took, and what it cost.**

Both tools must keep working on their own:

- **ccxray without agentflow** behaves exactly as today. The integration is an adapter; nothing in core depends on it.
- **agentflow without ccxray** behaves exactly as today. Phase A requires no change to agentflow at all. Phase B separates documentation proposals from opt-in, tool-neutral runtime extensions, each subject to upstream acceptance; the runtime extensions do nothing unless enabled.

ccxray's maintainer does not maintain agentflow. Anything that needs agentflow to change is a proposal to its author, never a fork we carry.

**Why this is ccxray's job.** Any tool can read transcripts. Only a proxy sees the requests that never reach a transcript, and for an interactive host those are real spend (see Data sources). So the report works without the proxy, labelled as a lower bound, and becomes complete when the proxy was running. The MVP reads both.

## agentflow concepts this spec relies on

Paths below are relative to the notebook's workspace directory: `ag.json` `workspace-dir`, `.agentflow` by default.

| Term | Meaning |
|---|---|
| Notebook | A Markdown file, by default `.agentflow/devlog.md` (`ag.json` `target-doc`). Feature streams usually live in their own worktree at `.agentflow/features/<key>/<key>.devlog.md`; notebook-only streams may share a checkout. Compaction moves old rounds into an archive: `devlog.md` → `devlog.archive.md`, `<topic>.devlog.md` → `<topic>.archive.md`. |
| Ask | The request of one round, under `# → Ask / A-012`. The heading has **no timestamp**. The body is the owner's prompt, captured verbatim by agentflow's `UserPromptSubmit` hook or typed into the notebook. While an Ask is open, the hook appends every captured prompt to it as another bullet, chat included. A close ends the notebook with the next Ask as an exact empty `+` scaffold, so the next captured prompt becomes that Ask's first bullet. Some prompts are not captured: a `no-ag` opt-out, no open Ask, an ownership refusal, a bare `godev`, or a failing hook. |
| Reply | The answer, under `# ← Reply / A-012`. It opens with a stamp line `* _YYYY-MM-DD HH:MM:SS ±HHMM (<identity>)_`. The identity is `model/effort` when agentflow could read it (Codex) and `<host>/unknown` otherwise; today that means always for Claude. Every closed round has a Reply stamp, whatever the delivery mode. |
| RUN / WIP | Progress records. Their timestamps are **not** progress times: RUN bodies submitted with a close manifest are stamped at close. |
| `agf close` | Publishes the Reply, re-verifying the notebook hash inside a lock, and then, as a separate step that can fail on its own, commits with an `Agentflow-Close-Id: <64 hex>` trailer. Delivery affects the commit:<br>• `local` inside a Git repository still commits.<br>• A plain folder never commits.<br>• A stream's closing commits are fast-forwarded on merge-back, so their timestamps survive.<br>Owners may also close rounds without `agf close` (the ccxray repo does, to keep its notebook uncommitted). Closed rounds are byte-verified again only on compaction and ownership adoption. |
| Host | The interactive session (Claude Code or Codex) the owner talks to; the coordinator. |
| Internal worker | A native subagent of the host, for example a Claude Code Task agent. Its transcript sits under the host session. A resumed subagent may serve a later Ask. |
| External worker | A separate `claude -p`, `codex exec` or `grok` process run by `external-runner.js`. Its clone is a fresh `$TMPDIR/agentflow-external-runner-XXXXXX/clone` by default, but a caller-chosen `clone_directory` is also allowed and may be reused. The runner does not delete the clone. Its result includes `working_directory` and `clone.root` (the resolved clone path); the coordinator sees it only through whatever wrapper it writes, since the runner has no command-line entry point. The runner itself records nothing about the Ask or role. |
| Dispatch record | For each external run, the coordinator writes `<workspace>/artifacts/<A-NNN-slug>/dispatch/<stage>-dispatch.json` or `<workspace>/artifacts/<A-NNN-slug>/<stage>-dispatch.json`, following `references/delegation.md` ("record profile, model, effort, … facts"). Observed fields vary by coordinator. This repository's records carried `stage`, `model`, `effort`, `started`, `finished`, `clone`, and the runner's `result` (command, exit code, clone identity); 25 records of other projects sat directly in the Ask directory and were the runner result itself or a summary of it (`clone.root`, `clone_root`, `working_directory`, `command`, `result_file_path`), with no stage field and no times. The runner may truncate the worker's report text captured inside `result`; that does not affect the fields attribution needs (`stage`, `model`, `effort`, `started`, `finished`, `clone`). It is **host-authored**: the format is a convention, not a script-enforced contract, and it may be missing or incomplete. |
| Completion record | `<workspace>/.tmp/<namespace>/<A-NNN>/completion.json`, written at close. The namespace is empty only when the notebook is exactly `<workspace>/devlog.md`, `features/<stream>` for `<workspace>/features/<stream>/<stream>.devlog.md`, and `notebooks/<first 16 hex of sha256(notebook path)>` otherwise, so it identifies the notebook even when notebooks share a workspace. The JSON's top level holds `ask`, `created_at`, `metadata_text`, `notebook` and `version`; an external review's record inside the metadata must carry `transport.clone` (`completion-record.js`); only external reviews are required to carry it. `completion.ref.json` beside it holds the record's and the Reply's digests. Completion cleanup is off by default; when enabled, a record becomes eligible only after 30 days, subject to further retention conditions. |
| Input receipt | One file per notebook and hook host identifier (`claude` or `codex`, not session) under `<workspace>/.tmp/`. When the hook has a `turn_id`, each captured prompt adds an entry `sha256(message_id + "\0" + text)` with `message_id = (session_id or "") + ":" + turn_id`; captures without it add none. The file describes that host identifier's last scoped Ask: close keeps the entries, adds a `scope.close` block when a scope exists, and writes a separate entry-free marker for a valid close id; the file is replaced when scope is captured for another Ask, including during `agf start`. Receipts are opportunistic evidence, not a history. |

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
      adapters/agentflow: notebooks + dispatch/completion records + transcript evidence
                          → Ask windows → attribution → report
                                            │
                                            ▼
             report store under the ccxray data dir  ·  terminal / JSON
```

- **Core** gets one reusable capability, a usage query: `query({ roots, from, to, sessions? }) → aggregate`. It reads **merged data**, never raw index lines (see Deduplication), and **merges before it filters**: selection by session and cwd uses the merged row, because a proxy row recorded before #640 has `cwd: null` and only its merged twin carries the path. A proxy-only row with no twin (a prompt suggestion, say) takes its session's cwd. It selects turns by working-directory root, time range and optionally session. It aggregates exactly the turns it is asked for, folding in subagent turns only through native lineage (see Attribution), and aggregates tokens, cost (with ADR 0017 confidence), models, effort and duration per executor. The next workflow tool integration reuses it unchanged.
- **The agentflow adapter stays thin.** It reads notebooks, dispatch and completion records, and transcript evidence; builds Ask windows; resolves attribution before asking the core to aggregate; and renders the report. It compares owner-submission text verbatim and inspects tool inputs and results for runner launches, in memory, but never interprets the intent of prompts or worker briefs.

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

**Several machines.** The notebook travels with the repository, but transcripts and ccxray data stay on the machine that produced them, so a report sees every Ask and only this machine's usage. A1a reports this machine only and says so: an Ask with no owner submission of this machine inside its bounds is `no local evidence` (W6) and takes none of this machine's host turns, and the footer counts such Asks. Combining machines is under Later. It must union per-machine evidence before computing anything, not add per-machine totals: two machines can hold overlapping copies of the same transcripts (a synced `~/.claude`), and summed aggregates then count the overlap twice. That failure has been observed in another tool that uploads daily totals per machine.

### Completeness

Every Ask carries one completeness label, derived from the data at report time (never stored in A1a). The three labels and the per-turn-twin rule for `complete` are owner decisions (2026-09-27); no separate coverage record is kept.

| Label | Meaning |
|---|---|
| `complete` | Every host transcript turn in the window has a proxy twin (same responseId), so the host's traffic went through the proxy, including requests that never reach a transcript. |
| `partial proxy coverage` | Some host turns in the window have a proxy twin and some do not. |
| `transcripts only` | No proxy twin in the window. The host total is a lower bound: in one measured interactive session it was 11.7% low. |

Why per-turn twins are enough evidence: a Claude Code session's base URL is fixed at launch, so its requests all go through the proxy or none do, and a stopped hub makes requests fail rather than bypass it (inferred from launch behaviour, not separately measured). A request that failed while the hub was down was not billed. Workers are labelled the same way but a transcript-only worker is not flagged as low, since `claude -p` was measured complete within 0.1%.

A host transcript turn that no imported line carries yet still counts, including turns in native Claude subagent transcripts under that host's session directory: a proxy line with its message id is its twin, and with no index line at all the proxy never saw it, so a host whose transcript was never imported is not `complete` unless the proxy logged every turn.

**Several host sessions in one Ask** are labelled per host first. The Ask is `complete` only when every host is, `transcripts only` only when every host is, and `partial proxy coverage` otherwise. A host whose matched transcript turns no index line carries yet has no host row but is still labelled, from those turns, and folded in. An Ask with **no host on this machine**, such as one that ran on another machine, is `unknown`: nothing was observed here, so neither `complete` nor `transcripts only` would be true.

**Codex** has no responseId, so completeness follows the one-source rule: a session read from the proxy is `complete`; one read from import, or found in a transcript with no index row yet, is `transcripts only`.

This replaces the earlier "no separate measured vs estimated label" rule, which assumed the proxy added only about 1%. The 2026-09-27 re-verification disproved that for interactive hosts.

Because proxy lines are pruned after 14 days (see Retention), a recomputed Ask can move from `complete` to `transcripts only`. That downgrade is honest, never a false `complete`; freezing in A1b keeps the original figure.

## Ask windows

A window is the half-open time range `[start, end)` whose turns belong to one Ask.

**End.** The Ask's Reply stamp. It is always present and parsed with agentflow's local-time format. When the round has a matching close commit (`Agentflow-Close-Id`, touching this notebook, whose tree contains this Reply), its committer time is a cross-check only: if the two disagree by more than a minute, keep the stamp and flag the Ask. An Ask with no Reply is **open**: its window ends now and it is never frozen. A Reply whose stamp line is not in agentflow's format (early notebooks have hand-written stamps without seconds or offset) is **closed with no window**: labelled `stamp unreadable`, it matches no submission and gives no lower bound to the next Ask, and the footer counts it. It is never treated as open, which would stretch its window to now over every later round.

**Tail.** Wrap-up turns (the host telling the owner it is done) follow the Reply stamp by seconds. The window therefore ends at `stamp + tail` (default 2 minutes). Only the tail is capped, and only at the next Ask's **matched** start; the window never ends before its own Reply stamp. An estimated start begins after this tail instead (W6), since capping at a start that is this very stamp would hand this Ask's wrap-up turns to the next one. Observed tails were 0–35 s.

**Start.** The time of the owner submission matched to the Ask's first matched bullet. agentflow's hook captures the owner's prompt verbatim, so this is the moment the owner asked. Bullets are matched to submissions by **ordered alignment**, in numbered steps that the fixtures under Phases refer to:

- **W1 — bullets.** List every bullet of every Ask in notebook order. Normalise each: strip `<pasted_content>` tags, collapse whitespace. Skip a bullet that is empty after normalisation, such as the bare `+` scaffold or a bullet holding only the tag.
- **W2 — submissions.** List the owner submissions (see Transcript evidence) of every host session in the checkout, ordered by `(timestamp, session id, event uuid)`, and split each into paragraphs at blank lines, normalised the same way and ordered by index. agentflow writes one bullet per paragraph (`format_owner_input`).
- **W3 — bounds.** A bullet of Ask N matches only a submission earlier than Ask N's Reply stamp (now, for an open Ask) and later than the latest Reply stamp of an Ask before N in notebook order. The first Ask, or an Ask with no earlier Reply stamp, has no lower bound. The lower bound holds even when the previous Ask matched nothing.
- **W4 — match.** Walk the bullets in order. A bullet matches when its text **equals** a paragraph of a submission within its bounds, taking the earliest such paragraph strictly after the previously consumed paragraph; no paragraph is consumed twice. Consecutive bullets of one Ask may consume successive paragraphs of one submission; a submission consumed by one Ask is never consumed by another. A bullet with no equal paragraph is unmatched and the next bullet is tried, so hand-written text needs no special rule unless it happens to equal a submission paragraph. Each notebook is aligned on its own.
- **W5 — ties.** If another eligible submission, not yet consumed, could have supplied the Ask's first match, the earliest is kept and the Ask header shows `start tie`.
- **W6 — start.** The Ask starts at the submission of its first matched bullet. With no matched bullet:
  - if some owner submission of this machine falls inside its W3 bounds, it starts where the previous Ask's window ends (that Ask's Reply stamp plus its tail) and is labelled `estimated start`, because idle time and unrelated work in that gap may be included;
  - if none does, it is labelled `no local evidence`: the round was most likely worked on another machine, or its transcripts are gone. Its window exists only for `dispatch` and `completion` evidence. It is never a candidate in W7 per-turn resolution or at the E3 `window` level, and never caps another Ask's tail. This machine's host turns inside it stay notebook-level `unassigned`, and the Ask discloses `local host turns inside bounds: n`;
  - with no earlier Reply stamp it has no window and is reported `unmeasured`.

  **Empty Asks** (scaffolds with no body) have no window. The label asserts only that evidence is absent here, not where the work ran; a clock difference between machines can also produce it.
- **W7 — host rows.** W7 establishes host membership, not attribution. Every session with a submission matched to the Ask is a host row of that Ask, with evidence `prompt-match` (two coordinators in one worktree can share one Ask). A host session with notebook evidence (see Attribution) but no matched submission is a host row with evidence `window`. Each host or internal-subagent turn is then resolved by time across the eligible notebooks: within one notebook, overlapping windows go to the Ask with the latest start; windows of several notebooks that all contain the turn make it `ambiguous`.

The Reply stamp cannot identify the host session, since it reads `host/unknown` for Claude; the matched submission does. Turns before the first Ask's start, such as a bare `godev` bootstrap, form a `setup` row rather than disappearing.

**Disclosure, not judgement.** For each host row of an Ask, the report lists:
- `unmatched owner submissions: k`: that host's submissions inside the window that matched no bullet. They may be prompts the hook did not capture, which then stay in whichever window they fall in (inside the tail, the previous Ask), or text the notebook renders differently.
- the count and cost of that host's submissions after its first matched one. A submission's cost is that host's turns, proxy-only requests included, from the submission to the host's next submission, capped at the window's end. Owners use this to judge how much of an Ask was chat or later follow-ups, which the notebook itself files under that Ask.

Edge cases:

- **Idle time** between a Reply and the next Ask's start belongs to no Ask.
- **Several Asks closed together** each keep their own start. Where two windows overlap, turns are assigned to the Ask whose start is the most recent before the turn, and the overlap is flagged.
- **A retried or failed close** uses the stamp that finally stands in the notebook; a Reply that was replaced is ignored.
- **A reopened round** (a bullet whose only equal submission is later than the Ask's Reply stamp) is not supported in A1a: by W3 the bullet stays unmatched, the window is not extended, and the Ask discloses `unmatched bullets: k`. Reopening is not inferred from equal text: on several machines a short generic command typed later on one machine equals a bullet of a round worked on another (8 false hits in one real notebook, none true).

## Attribution

**What is attributed.** Each turn is attributed to a `(notebook, Ask)` target. The row also records the host session and, for external workers, the worker run; the host session is `unknown` when the evidence does not name one. A session is not an Ask (two coordinators in one worktree share one), and a session is not a run (a clone or worker session can be reused). Host and internal-subagent turns are assigned **per turn** by window, so a long host session is split at window boundaries and a resumed subagent's turns follow the Ask whose window contains them. An external worker run is assigned **as a whole** (step E7).

**Scope of candidates.** A1a reports one notebook, but it evaluates candidates across every notebook of the same workspace (the root `devlog.md`, `features/*/*.devlog.md` and other `*.devlog.md` notebooks there) and the checkout's default notebook (`ag.json` `target-doc`, whatever its name) before keeping its own rows, so that a cross-notebook conflict shows as `ambiguous` rather than disappearing: a run whose candidates span several notebooks is listed as `ambiguous` in the report of each notebook among them. Notebooks of other checkouts are not enumerated; step E4 keeps their workers out.

**Host turns** belong to a notebook when both hold:

1. The turn's cwd is the root of the checkout the notebook lives in: the worktree for a stream, the repository or folder otherwise.
2. The session shows evidence of working on this notebook: a user message matching one of its Asks, or a tool call whose arguments mention the notebook path (relative or absolute). Bash command text counts. Generic evidence, `agf` or the workspace directory without a notebook path, counts only for the checkout's default notebook (`ag.json` `target-doc`, else `.agentflow/devlog.md`), the one a bare `agf` command targets. A stream notebook merged back into the main checkout is a copy; generic commands in the main checkout do not make its sessions hosts of that copy (on one real project they made a stream's worker run `ambiguous` between the two notebooks).

Sessions in the same directory without such evidence are excluded. If evidence cannot be read (transcript gone, arguments unavailable), fall back to cwd plus window and label the row `evidence unreadable`.

Both conditions are tested on merged rows. A host session is found from the index and from the transcripts themselves, so one not yet imported still contributes its owner submissions; when its transcript records the checkout root, that cwd is also the session's cwd for index rows that have none. **Proxy-only host requests** (prompt suggestions, title generation) belong to the host session they carry, so they join the host row even though no transcript mentions them.

**Transcript evidence.** The index keeps tool call ids, names and failure flags, not tool arguments or results (`server/importer.js`). Ask matching and launch evidence therefore read transcripts directly, in memory only:
- **Claude:** `type: user` lines with string content or `text` blocks; `tool_use`/`tool_result` blocks paired by `tool_use_id`; each line's `timestamp`. An oversized result is persisted to a side file whose absolute path the transcript's preview records (it may sit under a different Claude config directory than the transcript): read that file, and if it is gone use the preview and label the evidence `truncated`.
- **Codex:** `function_call` and `custom_tool_call` with their `*_output`, paired by `call_id`; output may be a string or an `input_text` array. A spawned subagent thread (`thread_source: subagent`) records its parent, usually as `session_id` (the id the importer files its turns under), else as `parent_thread_id`; its tool evidence belongs to the parent session.
- **Owner submissions** exclude, for Claude, `isMeta` lines, lines holding only tool results, slash-command and skill expansions, `<task-notification>` and lines holding only system reminders or hook context; for Codex, the blocks Codex injects as user messages and background threads such as `memory_consolidation`. Codex wraps injected content in tags (environment context, plugin recommendations, skills, notifications, an aborted turn, an attached image, the desktop app's browser context) and sends `AGENTS.md` as its own message; leading blocks with those tag names are stripped, the desktop app's `## My request:` heading is dropped, and what remains, if anything, is the owner's text, even when it starts with a tag. Rejecting every message that starts with `<` lost owner prompts after an attached image or browser context (109 of about 11,000 Codex user messages on one machine).
- Matching is on text keys and values, not parsed JSON, because previews can be truncated.
- **Deduplication:** usage counts each `message.id` once (a Claude turn repeats its usage on every content-block line), but evidence keeps every distinct content block: events are deduplicated by event uuid, and repeated tool blocks are merged by call id without dropping other blocks of the same message. Across files only an identical uuid makes two events one; neither time nor text is taken as proof that one transcript copies another.

**Lineage.** Native lineage is kept: a Claude subagent file's parent session id (the importer groups by it) and a Codex child's `session_id = parent_thread_id` (merged into the parent, as under Data sources). Internal subagent turns follow their host through it. Native descendants of an external worker belong to that worker's run and are never discovered as runs of their own. The proxy's `parentSessionId` inferred from overlapping activity (`server/store.js`) is ignored for any session identified as an external worker run; it was observed to file a Codex worker under a sibling Claude worker. Attribution is resolved before aggregation, so an inferred parent never folds a worker's turns into another row; each merged turn counts once, and the footer reports `heuristic parent ignored: n`.

**External workers.** In numbered steps:

- **E1 — discover.** Worker sessions are found as the union of: sessions whose cwd matches `*/agentflow-external-runner-*/clone`; the `clone` of a dispatch or completion record; and, by reverse discovery, a `working_directory` or `clone.root` value in a runner-shaped tool result in the workspace's host sessions, subagents included. Reverse discovery finds caller-chosen clones that have no record. A result is runner-shaped when the path sits in the runner's result structure (`clone` with `root`, or `working_directory` beside the runner's other result keys), not merely anywhere in a tool's output; a discovered path that equals a checkout root is never a clone, or every host turn there would become a worker turn. Every record's `clone` is discovered whether or not the record later validates; validation belongs to E3, so a clone named only by an invalid record still forms a run that falls to the lower levels.
- **E2 — runs.** Runs are formed in this order, without circular dependence:
  1. **Strong chains** (E5) define intervals `[(a), (b)]` directly from their tool events; the clone's turns inside belong to that run.
  2. **Dispatch intervals** `[started, finished]` do the same; a record without `finished` spans to report time and is labelled incomplete. A dispatch interval and a strong chain that overlap in one clone and name the same worker session describe the same run: both become evidence for it, reconciled by E3.
  3. **Residual runs:** the clone's turns outside every interval form one run per worker session, with its observed first and last turns. Weak chains (E5) are then evaluated against these runs.

  Two intervals **of the same level** that overlap in one clone and disagree on the target, the full `(notebook, Ask)` pair that level yields (Ask ids restart in every notebook), make the shared turns `ambiguous`; those turns are removed from both runs before E3–E7 and counted once in an `ambiguous` subtotal. A notebook report includes that subtotal only when its notebook is among the conflicting intervals' candidates; a weaker overlapping interval does not widen the candidate scope. Two same-level intervals that overlap and agree on the target are one run. A turn belongs to at most one run.
- **E3 — resolve, strongest level first.** The levels, from strongest, are `dispatch`, `completion`, `launch-chain`, `window`. Each level yields candidate `(notebook, Ask)` pairs, possibly with one dimension open:
  - **`dispatch`.** Ask: the record's directory `A-NNN-slug`, only when that Ask exists in a candidate notebook; otherwise the notebook remains known and the Ask dimension stays open for weaker evidence to fill. If no later level resolves the Ask, E6 files the run as notebook-level `unassigned`. Notebook: the notebook whose workspace holds the record; when several notebooks share that workspace (notebook-only streams), the record is no notebook evidence and that dimension passes down. A feature stream keeps its records under its own `features/<key>/artifacts/`, so only the notebooks directly in `<workspace>` share `<workspace>/artifacts/`. The record also gives `stage` as the role (the field, else the file name before `-dispatch.json`) and `model`/`effort` as the requested values (the fields, else parsed from the recorded command's arguments); requested and actual effort are compared, and a mismatch is flagged. The clone is `clone` when it is a path, else `clone.root`, `clone_root` or `working_directory`, else the runner clone directory that contains `result_file_path`. Worker turns are those whose cwd equals the clone and whose time falls in `[started, finished]`; the time bound matters because clone paths can be reused or caller-chosen. A record with no times defines no interval: it is dispatch evidence for its clone's run only when that clone holds exactly one run, and no evidence when the clone was reused.

    Verified on 18 real records (ccxray A-001…A-003, all Claude workers):
    - each matched exactly one session
    - every turn fell 1–2 s inside the time bound
    - requested and actual model and effort agreed
    - no clone path was reused

    Match on the recorded `cwd`, not on a transcript directory name derived from the path: Claude replaces every non-alphanumeric character, including `_`, with `-`. Actual effort comes from the transcript's top-level `effort`; `perTurnEffort` was always null.
  - **`completion`.** An external review's `transport.clone` in a completion record's metadata. The pair comes from the record, whose `notebook` and `ask` must match its location. Validate `sha256` against the exact `completion.json` bytes and `reply_sha256` with upstream's `reply_digest` (which normalises the Reply), both from `completion.ref.json`; the namespace hashes the repository-relative POSIX notebook path. The run's turns must fall inside that Ask's window. Only external reviews are required to carry `transport.clone`, and upstream requires only non-empty text there: in one real project's 58 completion records it was an absolute clone path in 8, free text in 7 and absent in 43, so this level binds few runs, and text that is not an absolute path is no evidence. Known limit: E7 lets a run extend past its window, but this level's whole-run containment does not, so a review run that outlasts its window is not bound by `completion`; left as specified until real data shows the case.
  - **`launch-chain`** (E5). The window that holds session S at (a), as W7 resolves it, so a `no local evidence` window never holds it. If no window holds (a), the level yields each notebook S is a host row of, with the Ask dimension open. Host session: S.
  - **`window`.** Only after E4 binds the run to this checkout: every window open in the workspace at the run's first turn is a candidate, except a `no local evidence` window.

  Pairs stay together: a weaker level may fill a dimension left open only with a pair that agrees with every dimension already fixed and exists among its own candidates. Once the notebook is fixed, the resolved Ask must exist in that notebook; if it does not, the Ask stays open and the row is labelled `evidence conflict`, so E6 leaves the run notebook-level `unassigned`. A weaker candidate that disagrees with a fixed dimension changes nothing and labels the row `evidence conflict`. A level with several candidates for a dimension makes it `ambiguous`, and no weaker level is tried for it; a dimension on which all of that level's candidates agree is still fixed. A level with no evidence passes the dimension down. A dispatch whose feature notebook does not exist has no notebook candidate; it falls to weaker evidence or the `matched no notebook` footer instead of creating an unreportable notebook row.
- **E4 — checkout binding** (for `window` only). The run is bound to a checkout only by surviving clone-origin evidence that names that checkout's root: the clone's `clone: from <source>` reflog entry, looked up among its entries rather than assumed to be the first one shown. `HEAD` reachability is diagnostic only, since several checkouts of one repository can hold the same commits. Reflog cannot separate sessions within one worktree, since their entries are identical, but it does separate checkouts. A deleted clone, an expired reflog, or a reused caller-chosen clone that was not cloned for this run leaves the checkout unknown, and the run is not attributed by `window`. The `clone: from` entry survives reuse, so only the earliest run in a clone (by first turn, across all runs formed in E2) can be bound by it; every later run in that clone is `checkout unknown` at this level.
- **E5 — launch chains.** Tool events are paired within their original transcript session; a subagent maps to its host through native lineage only after pairing.
  - **(b) result:** a tool result in session S containing `working_directory` or `clone.root` equal to the clone path, in the runner's result structure whether printed as JSON or as a Python dict, or a wrapper's summary whose `clone` key holds the clone path as an absolute path (never a checkout root). On one real project, accepting the summary key raised strong chains from 2 to 7.
  - **(a) launch:** a tool use in S whose input names the runner (`external-runner` or `run_external_command`). A launch through a wrapper whose command line does not name the runner is not an (a).
  - **Strong:** (a) and (b) are the same tool call, or (b)'s tool use references the handle returned in (a)'s immediate result (a `backgroundTaskId` or an output-file path for Claude; for Codex, the session id of a command still running, read later by `write_stdin` with that `session_id`), matched as a whole token. Strong chains need no run boundaries (E2 step 1) and are all resolved before any weak chain; a strong chain's launch is bound and never serves a weak chain.
  - **Weak:** for a residual run, a (b) in S no earlier than the run's last turn, together with the launches in S that are earlier than the run's first turn and not yet bound. A launch counts only if the run's first turn follows it within 2 minutes: a runner starts its worker within seconds (6–8 s from launch to first turn on every strong chain of one real project), while the nearest earlier launch of every residual run there was 50 s to 82 minutes old, a launch of another worker. One such launch, or several that all fall in one Ask, binds the run and consumes only the latest of them, so earlier ones stay available to other runs; launches in different Asks make the Ask `ambiguous`, and an ambiguous binding consumes no launch. Residual runs of all clones are processed together in time order of their first turn, so the result does not depend on which clone is examined first. Weak chains are labelled `weak`; a chain always requires a (b).
  - A session with (b) and no (a), such as one that read a saved runner result, is never a candidate.
- **E6 — outcome.** Applied in this order, so that every run lands in exactly one outcome:
  1. no notebook candidate: excluded from the report; the footer counts it as `checkout unknown` if only the `window` level remained and E4 could not bind it, otherwise as `matched no notebook`. A `checkout unknown` run cannot be claimed for any notebook, so the footer counts it as this machine's, any checkout's, and only when it started while the reported notebook's hosts were active (between their first and last turn): counting every such run put 27 in one real project's footer, 25 of which started while none of its hosts were active, and neither a window test (an open Ask's window reaches the present) nor a host-turn-just-before test (a host blocked in one long tool call launches several workers) can tell whose a run is;
  2. several notebook candidates: `ambiguous`;
  3. one notebook, several Ask candidates: `ambiguous`;
  4. one notebook, no Ask candidate (for example a launch chain whose (a) falls outside every window): notebook-level `unassigned`;
  5. one notebook, one Ask: `unique`.
- **E7 — whole run.** A run attributed to an Ask keeps all its turns there, including turns after the next Ask starts: the worker serves the Ask that dispatched it.

**Codex background agents** (for example `thread_source: memory_consolidation`) carry a cwd and their own session id, so they can land in an open window. A1a leaves them out of every total and counts them in the footer; a separate `background` executor row is listed under Later.

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
attribution: unique $0.184 · ambiguous $0.012 (1 run)
- host · prompt-match · unique · claude-opus-5-5 · effort high · 9m10s · $0.121 · 30 calls
  - subagent general-purpose · claude-sonnet-5 · effort high · 1m02s · $0.018 · 4 calls
- external cross-check · dispatch · unique · codex gpt-5.6-sol · effort low (requested low) · 5m22s · $0.063 · 12 calls
- external unknown · window · ambiguous · claude-sonnet-5 · effort low · $0.012 · 3 calls
```

The header total is the `unique` cost: the host row, which includes its indented subagents ($0.121, 30 calls), plus the external row ($0.063, 12 calls). The `ambiguous` run is listed and subtotalled but not added.

- **Ask time** is `end − start`. **Executor time** is the sum of `turnDurationMs` where present; otherwise first-to-last turn, marked `duration estimated`. Until the importer upserts late fields (A1b), already-imported turns may lack `turnDurationMs`. A1a does not require exact executor time (owner decision, 2026-09-27).
- **"read share"** is cache-read tokens ÷ (input + cache-read + cache-write) tokens.
- **Effort** is the value actually sent; if an executor used several levels, each is listed with its call count.
- **Unpriced turns** follow ADR 0017: the total is rendered with its confidence (for example a `+` lower bound).
- **Completeness** (`complete`, `partial proxy coverage`, `transcripts only`) heads every Ask; see Completeness.
- **Other labels:**
  - `evidence unreadable`: host-membership evidence could not be read, so cwd plus window was used
  - `duration estimated`: executor time is first-to-last, not measured
  - `estimated start`: see Ask windows
  - `ambiguous`, `unassigned`, `weak`, `truncated`, `evidence conflict`: see Attribution and Attribution status
  - `start tie`, `no local evidence`, `stamp unreadable`, and the `unmatched bullets` disclosure: see Ask windows
  - `unknown` completeness: no host on this machine (see Completeness)
  - `not yet imported: n turns`: transcript turns inside the window whose message id no index line carries; for Codex, which has no message id, the usage turns (`token_count` events the importer turns into index lines) in the window beyond the session's imported lines there, unless the proxy is that session's one source (import lags per turn, since a session spans days); the footer counts such Asks and points to `ccxray import --once`
  - `unmeasured`: no turns found
  - `revised`: a frozen snapshot was recomputed and changed
  - a `setup` row: turns before the first Ask's start
- **The footer** states the sources per provider, the generation time, and snapshot status. In A1a, which has no snapshots, it also says the figures are recomputed from data still on disk and may change after proxy pruning (14 days), transcript deletion (30 days) or a price-table update. It states that the report covers this machine's data only, and counts the Asks with `no local evidence` and with `stamp unreadable`, and the host turns not attributed because a shell `cd` left their cwd below the checkout root (condition 1).
- **Tool statistics** stay in the dashboard.

**Attribution status.** Completeness says whether usage was captured; attribution says whether it was filed under the right Ask. Even fully proxied traffic can be misfiled, so every row carries both an `evidence` and a `status`:

| Executor | Evidence | `unique` when |
|---|---|---|
| host | `prompt-match` | each turn resolves to one `(notebook, Ask)` under W7; every matched session is its own row |
| host without a matched submission | `window` | as above |
| host with `estimated start` | `window` | as above |
| Ask with `no local evidence` | none | no host row; only `dispatch` and `completion` evidence can attribute to it |
| internal subagent | follows its host through native lineage | each subagent turn resolves to one `(notebook, Ask)` under W7, after native lineage identifies its host |
| external worker run | `dispatch`, `completion`, `launch-chain` or `window` (E3) | notebook and Ask each resolve to one candidate (E6) |
| `setup` | `window` | as before |

The other statuses are `ambiguous` (several candidates) and notebook-level `unassigned` (notebook known, Ask not). **Only `unique` cost enters the notebook's attributed total.** `ambiguous` and `unassigned` are listed as separate subtotals and never added, so no cost is counted twice across reports. Each Ask's header lists every status that occurs, with its cost. Runs that matched no notebook, runs with an unknown checkout and background agents are not part of the report; the footer gives their counts, without paths.

**Privacy.** Reports and `--json` contain only the fields shown above: Ask id, executor kind, role, model, effort, durations, token counts, costs, call counts and labels. They never contain prompts, Ask text, tool arguments or transcript content. Absolute paths are omitted: clones appear as their role, checkouts as their notebook path. Role, model and effort taken from a dispatch record pass only when identifier-shaped (a stage name, a model id with at most one provider prefix, an effort word); anything else is dropped, so a hand-edited record cannot carry text into the report. Files are written with owner-only permissions (0600, directories 0700). Matching Ask text against transcripts happens in memory only.

## Freezing

Snapshots keep history stable against transcript deletion, proxy pruning and price-table changes. They describe one machine's view and are not added across machines (see Several machines). They ship in A1b; a snapshot also freezes the Ask's completeness label, every row's evidence and status, and the attributed, ambiguous and unassigned subtotals.

**Settled** is decided from on-disk data only; the CLI never needs a running server. An Ask is settled when all of these hold:

- it has a Reply stamp
- `now ≥ end + grace` (default 30 minutes)
- no index line falls inside its window that is newer than `end + grace`
- every transcript file and every attribution input (dispatch and completion records, persisted tool results) that contributed is unchanged in size and mtime for at least the grace period

A snapshot stores the aggregate plus what it was computed from:

- the notebook identity: path, Ask id, and a hash of the Ask heading, the normalised Ask body and the Reply stamp
- a fingerprint of each contributing transcript and attribution input (dispatch record, completion record and its reference, persisted tool result): path, size, mtime
- the importer/parser revision, the attribution-rules revision and the pricing revision

On each run the adapter compares these fingerprints:

- **A changed Reply or Ask identity** invalidates the snapshot.
- **A newer parser, attribution-rules or pricing revision, or an attribution input that was added or changed,** makes it recomputable. `--rebuild` recomputes, and a change is shown as `revised`.
- **A transcript or attribution input that has since been deleted** keeps the snapshot as is; that is the point of freezing.

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
  - Ask windows: start by ordered alignment of bullets to owner submissions, end at Reply stamp plus tail, the `setup` row, and the unmatched-submission disclosure
  - attribution: host (prompt suggestions and title generation included), internal subagents through native lineage, and external worker runs through the four evidence levels, with the transcript evidence reader and the attribution status
  - the A1a footer: recomputed from data on disk, may drift
- **Acceptance:** one of the owner's own projects, run on two machines and proxied on the development machine. Its root notebook's archive holds about 150 Asks (2026-09-28 to 2026-10-06), with completion records but no dispatch records, a feature-stream notebook in the same workspace, and a second checkout. This replaces the earlier choice of this repository's A-001 to A-008: that notebook, its archive and its dispatch records no longer exist on the development machine. Acceptance is read-only, against a copy of the owner's index under an isolated `CCXRAY_HOME`, and nothing from it enters the repository. Before the report runs, about five Asks are hand-derived to expected results:
  - one with a completion record
  - one in the feature stream
  - one with no matched bullet
  - one run on the other machine (no transcript here, so `no local evidence`, taking no host turn)
  - one inside the proxied period, which must come out `complete` or `partial proxy coverage` according to its per-turn twins
- **Archive input:** the notebook's archive is read when it exists at the name agentflow's compaction gives it (`devlog.md` → `devlog.archive.md`, `<topic>.devlog.md` → `<topic>.archive.md`), and its rounds are deduplicated against the live notebook by Ask id. Deriving that one path is not discovery; general archive discovery stays out of A1a.
- **Acceptance of `complete` and `partial proxy coverage`:** the proxied period of the project above exercises both on real data; fixtures cover them as well.
- **Second real acceptance set:** the 2026-10-05 experiment repository's A-002 to A-004, whose host must come out `prompt-match`, `unique`. They were proxied, but that proxy's data may have been cleaned up with the environment: `complete` if it survives, `transcripts only` if not.
- **Test fixtures:** anonymised from the 2026-09-26 experiment sessions, plus a notebook with an empty scaffold, a retried close, two overlapping windows, a window with partial proxy coverage, a pre-#640 proxy row with `cwd: null`, and a pruned proxy turn.
- **Attribution fixtures:** captures from the 2026-10-05 harness (a real upstream runner, real clones and a proxy with fake workers) together with synthetic provider transcripts and notebooks carrying explicit event timestamps and identities. Each fixture declares which evidence exists, and its expected result follows from the numbered steps in Ask windows (W) and Attribution (E). **Unless a row says otherwise:** there is one eligible notebook; every Ask before the one under test has a Reply stamp; there is no competing evidence at any level; every claimed launch chain has a launch whose command line names the runner, a result naming the clone path, and timestamps enclosing the worker's turns; every launch falls inside exactly one window; every worker's cwd matches the E1 clone pattern (a caller-chosen clone does not) and, when the row gives it a launch, its first turn falls inside the window that holds that launch; a strong chain's launch and result share one tool call id unless a handle is stated; the launching session, or its host through native lineage, is a host session of the notebook; every dispatch interval encloses its worker's turns; every stated submission satisfies its W3 bounds and comes, in bullet order, after every previously consumed paragraph; and every host turn of the fixture falls inside the window of the Ask its row expects it to resolve to.

  | # | Fixture and available evidence | Expected |
  |---|---|---|
  | F1 | Two coordinators in one worktree, concurrently; the second session's start prompt, with different text, was not recorded (agentflow reported it already present), so A-001 holds only the first's; the second session ran `agf start`, which is notebook evidence. Each launch is a synchronous call printing the full runner result; both launches fall in A-001; no dispatch records; session 2's start prompt falls inside A-001's window and is its only unmatched owner submission there; session 2 has no submission matched to any A-001 bullet | W7: session 1 is a `prompt-match` host row; session 2 is a `window` host row whose turns resolve to A-001 and whose different-text prompt counts as one unmatched owner submission. E5: each worker has a strong chain from its own session; E6: all `unique` |
  | F2 | F1, but every wrapper prints a summary without the clone path; no completion records; each clone was freshly cloned for its run and keeps a `clone: from` entry naming this checkout | E5: no (b). E4 binds each clone to the checkout; `window` resolves notebook and A-001; E6: `unique`, evidence `window` |
  | F3 | One submission in two transcripts: (a) same uuids, (b) rewritten uuids, distinct timestamps, both within the same Ask's bounds and not consumed by a later bullet, (c) original deleted; the bullet supplies the Ask's first match and both copies' sessions are host rows of the Ask; in every variant the submission is one paragraph equal to the Ask's sole matching bullet | (a) deduplicated, one match. (b) W4 matches the earlier copy, W5 shows `start tie`, the other copy is an unmatched submission. (c) one match |
  | F4 | A session reads a saved runner result: (b) with no (a) in that session | E5: not a candidate; the run falls to lower levels |
  | F5 | A Task subagent launches and reads the runner synchronously; no dispatch or completion evidence exists, and the launch and its clone-path result share one tool call id in the subagent's original transcript | E5: strong chain in the subagent, resolved to the host through lineage; `launch-chain`, `unique` |
  | F6 | A Codex worker inferred as child of a sibling Claude worker | Lineage: inferred parent ignored; each turn counted once; footer `heuristic parent ignored: 1` |
  | F7 | Text `continue` as A-001's follow-up (before A-001's stamp) and as A-002's opening (after it) | W3 bounds each bullet to its own round; each matches its own submission |
  | F8 | A prompt whose `<pasted_content>` tag line is a paragraph of its own; a prompt of three distinct paragraphs matching three bullets | W1 skips the tag-only bullet; W4 matches the three bullets to three paragraphs of one submission |
  | F9 | `no-ag`, no-open-Ask, ownership-refused and bare `godev` prompts inside A-001's tail, from a host row of A-001; none is recorded as a bullet, and A-002 is empty; these four match no notebook bullet and are the only unmatched owner submissions across A-001's host rows within its window | Not bullets; their turns stay in A-001 by window; A-001 shows `unmatched owner submissions: 4` |
  | F10 | A-002 holds `+` then a hand-written line equal to no submission, then the owner's prompt | W4: hand line unmatched, the owner's bullet matches; with no owner bullet but an owner submission in bounds, W6 gives `estimated start` |
  | F11 | One caller-chosen clone reused for A-001 and A-002, each with a dispatch record; the two intervals are disjoint and cover all the clone's turns | E2: two runs by dispatch interval; E3: each `dispatch`, `unique` |
  | F12 | A caller-chosen clone, no record, wrapper prints the full result; the runner-naming wrapper invocation and its clone-path result share one tool call id in the same original session | E1 reverse discovery; E5 strong chain; `unique` |
  | F13 | A background launch; the result is later read through its `backgroundTaskId` | E5: strong chain; `unique` |
  | F14 | A wrapper that prints only `clone.root` | E5: accepted as (b) |
  | F15 | A persisted result whose side file is gone, with a qualifying launch: (a) the preview still holds the clone key and path, (b) it does not; in (a) the preview is the immediate result of that launch in the same original session | (a) E5 chain, labelled `truncated`. (b) no result evidence; lower levels decide |
  | F16 | Two notebooks share one workspace; a review worker has a dispatch record and a valid completion record naming the same Ask, whose window contains the whole run | E3: `dispatch` fixes the Ask, not the notebook; `completion` fixes the notebook by namespace and agrees on the Ask; `unique` |
  | F17 | An A-001 bullet whose only equal submission is after A-001's stamp | W3: unmatched; `unmatched bullets: 1`; no reopening label, window not extended |
  | F18 | A clone-pattern worker with no record, no chain, clone deleted | E6 step 1: not reported; footer `checkout unknown: 1` only |
  | F19 | One session launches workers in A-001 and in A-002, weak chains only; the workers have distinct sessions, the second launch comes after the first run's first turn, and each run has one matching result | E5 weak: run 1 sees only launch 1 and binds it; run 2 sees launch 2 (launch 1 is bound); both `unique` |
  | F20 | One Claude message written as three lines (same `message.id`, different uuids), two holding different tool calls | Deduplication: usage once; both tool calls kept as evidence |
  | F21 | A dispatch record naming A-001 whose `finished` comes after the worker's last turn, which is after A-002 starts | E7: all turns stay in A-001 |
  | F22 | Two checkouts each with an open window; a recordless worker whose clone was freshly cloned from checkout X and keeps its `clone: from` entry; its first turn falls inside X's window; the worker has no launch-chain evidence in either checkout | E4 binds it to X; reported only under X's notebook |
  | F23 | A dispatch record says A-002; a strong launch chain for the same worker session, overlapping it in the same clone, says A-003 | E2: one run with two pieces of evidence; E3: `dispatch` fixes A-002, the chain disagrees; row labelled `evidence conflict`, `unique` |
  | F24 | A-002 ran on another machine: no owner submission of this machine falls in its bounds; this machine has a host session with notebook evidence and turns inside A-002's bounds, including wrap-up turns within 2 minutes of A-001's stamp | W6: `no local evidence`, completeness `unknown`; A-001's tail is not capped and keeps the wrap-up turns; the other turns are notebook-level `unassigned` and disclosed as `local host turns inside bounds` |
  | F25 | A host tool result reports `working_directory` equal to the checkout root, outside any runner result structure | E1: not runner-shaped, and a checkout root is never a clone; host turns stay host turns |
  | F26 | A clone reused for two runs, no records and no chains; it keeps one `clone: from` entry naming this checkout; each run's first turn falls in an open window | E4: the earlier run is bound and attributed by `window`; the later run is `checkout unknown` |
  | F27 | Session S strongly launches worker 1 (A-001), then launches worker 2 (A-002) through a wrapper that does not name the runner but prints the full result | E5: launch 1 is bound by its strong chain; worker 2 has no launch, no chain; it falls to `window` |
  | F28 | Two weak launches of S both in A-001 precede residual run 1; residual run 2 starts later with a result after it | E5: run 1 binds and consumes the later launch only; run 2 can still bind the earlier one; both `unique` in A-001 |
  | F29 | A launch chain whose (a) falls inside a `no local evidence` window of A-002 | E3: no window holds (a); the level yields the notebook with the Ask open; with no weaker evidence the run is notebook-level `unassigned` |
  | F30 | A wrapper prints a summary whose `clone` key holds the clone path, in the same tool call that names the runner | E5: accepted as (b); strong chain; `unique` |
  | F31 | Dispatch records with no `started`/`finished`, directly in the Ask directory, the clone path under `clone_root`: (a) a fresh clone with one run, (b) a clone reused for two runs | (a) `dispatch` evidence, role from the file name; (b) no dispatch evidence; lower levels decide |
  | F32 | Session S launches the runner in A-001 and that launch produces no worker turns; 10 minutes later, in A-002, S starts a worker through a wrapper that does not name the runner, and later reads a result naming its clone | E5: the A-001 launch is not within 2 minutes of the run's first turn, so no chain; the run falls to `window` and resolves to A-002 |
  | F33 | A host session in the main checkout runs `agf` commands; the workspace also holds a stream notebook merged back from its worktree | Host turns: the session is a host of the default notebook only; a turn inside a stream-notebook window is not `ambiguous` |

**A1b — persistence.** `--write` into the report store, snapshot freezing (including the completeness label), `--rebuild`, and the importer upsert for late fields such as `turn_duration`.

**Later.**

- a separate display category for prompt-suggestion and title-generation requests (they stay in the host row until then)
- background-agent rows
- `--beside` with the Git-common-dir exclude
- feature streams, archives in general and notebook-only streams (`--all`)
- **combining machines.** Each machine exports an evidence bundle; a combined report unions the bundles before W2 and runs W1–W7 and attribution once. A bundle holds:
  - index lines, which carry no prompt text;
  - owner submissions as the sha256 of each normalised paragraph, with time, session and Claude `promptId`, so bullets are matched by hash and no prompt text leaves the machine;
  - the clone-related fields of tool evidence;
  - a machine identifier hashed from Claude Code's per-install `userID`.

  Union is by globally unique keys (index ids, then responseId through ADR 0012; event uuids; Codex one source per logical session across machines), which is order-independent and idempotent. Wall clocks differ between machines, so host turns should be attributed through Claude's causal links (`promptId`, `parentUuid`) to the submission that started them, with windows as the fallback, rather than by comparing timestamps across machines. Snapshots (A1b) freeze history and are not additive across machines. Transport is out of scope.
- **causal host attribution.** Assigning each host turn to the owner submission that started it, through `promptId`/`parentUuid`, instead of by window overlap. Measured on one real notebook (2026-10-08, one machine): of 1,039 turns both methods could place, none differed; causal links would recover 2 turns past a window's end, cannot place the 582 turns started by prompts that match no bullet (the notebook files those follow-ups under the open Ask, as windows do), and cannot place proxy-only rows (472), which carry no `promptId`. Not adopted for one machine; its value is avoiding cross-machine clock comparison when machines are combined.
- opt-in auto-watch, off by default: discovers projects from recorded cwds whose checkout contains an agentflow workspace, and refreshes reports when a new Reply appears
- a worker-only route for Codex workers to reach the proxy. The zero-change route through the owner's Codex configuration was verified once (see Evidence), but it redirects every Codex process and appeared to break ChatGPT connector MCP calls; candidates to test are the runner's `env`, a `-p` profile and `-c model_provider`
- reading input receipts while they last (they cover only the current or most recently closed Ask), or capturing them live by auto-watch, to bind bullets to submissions exactly

**Related, not blocking.** The stored `_req.json` format work (a ccxray-internal design of 2026-09-27, stage "B1" there; not this spec's Phase B1): a shared rebuild module, `ccxray show-request <id>`, and a format marker. It is deferred. A1 reads the index, not stored request bodies, so it does not depend on it. Anyone checking wire-level facts for this integration, such as whether a request carries `system`, must use a rebuilt request rather than raw `_req.json`: that mistake caused #637's live-cwd miss.

**Dogfood.** Use the report daily in at least two repositories, on a current agentflow release, over a fixed observation period (two weeks by default), and record every row that looked untrustworthy and why. Phase B is decided on these numbers (owner decision, 2026-10-06):
- **Run inventory:** worker runs are deduplicated across reports; re-running a report over the same history adds no sample.
- **D:** the deduplicated, priced cost of external runs whose notebook resolved to one of the sampled notebooks: `unique`, `ambiguous` within those notebooks, or notebook-level `unassigned`.
- **G:** the part of D that is `ambiguous`, `unassigned`, or `unique` on `window` evidence only.
- Runs that matched no notebook, runs with an unknown checkout and unpriced runs are excluded from both and reported as counts. Workers whose transcripts are gone and that never went through the proxy are invisible and are not estimated. If D is zero the ratio is undefined.
- Phase B is considered when G exceeds 10% of D, choosing B0 or B1 by the dominant reason.

## Phase B — proposals to agentflow upstream

Proposals come in two kinds. **Documentation proposals** (B0) change no code path; they do change the guidance a coordinator follows, so they are presented as such, not as switches. **Runtime extensions** (B1, B2, B-minor) are generic, opt-in observability extension points with ccxray as one reference implementation: none mentions ccxray in agentflow's code, and each does nothing unless enabled. agentflow removed its earlier metrics helper because it was unfinished, not because it opposed the idea.

**Entry condition.** Nothing in Phase B is proposed before dogfooding produces numbers on a current agentflow release, measured as defined under Dogfood: a fixed observation period, a deduplicated run inventory, and external-worker cost by attribution status, with the reason for every row that is not `unique` on `dispatch`, `completion` or `launch-chain` evidence. A proposal cites those numbers and picks B0 or B1 by the dominant reason.

**Not proposed.** A launch hook that rewrites worker base URLs or arguments (`worker-launch-command`), and a close-time cost hook (`cost-command`). Workers can reach the proxy without them: Claude workers inherit the host's `ANTHROPIC_BASE_URL` unless the caller passes its own `env`, and Codex workers follow their own configuration (see Evidence; a worker-only route that leaves the owner's global Codex configuration alone is still to be chosen, see Later).

**B0 — document the clone path the runner already returns (documentation only).** `run_external_command` returns `working_directory` and `clone.root`. A1a's `launch-chain` evidence reads them from the coordinator's tool result, and they are lost when a coordinator's wrapper prints only a summary. The proposal:

- list `working_directory` and `clone.root` among the runner's documented result fields in `scripts/README.md`;
- in `references/delegation.md`'s launch step, name the clone path among the facts to record, and give one wrapper example that prints the result fields it needs, the clone path included.

This raises traceability; it does not guarantee that a coordinator keeps the value, nor that the clone or transcript still exists later. Existing coverage to compare against: completion records already require `transport.clone` for external reviews, so B0 matters mainly for implementation and other non-review workers. Value to agentflow itself: a reviewer can be pointed at the exact clone a worker ran in.

**B1 — make the dispatch record a contract (runtime extension).** Proposed only if B0 is in place and dogfooding still shows a material gap, for example from coordinators that skip the record or from caller-chosen clone directories that are reused. The runner has no command-line entry point, so the extension is an option of `run_external_command`: when the caller passes `record: { path, notebook, ask, stage, host_session }`, the runner appends one `start` event before launching and one `end` event after the child settles. Both events carry a run id, plus:

- `ask` and `stage`
- repository, worktree and notebook identity
- the host session id
- executable, requested model and effort
- the clone path, the event time, and on `end` the exit status

Writes are append-only with one JSON object per line; a failed write is reported in the result and never fails the run. A1a reads these events like a dispatch record. A run with a `start` and no `end` has a provisional upper bound: the earlier of the next validated launch or dispatch in the same clone and the end of its Ask's window. It stays labelled incomplete and never absorbs a later run. The caller supplies `ask` and `stage`, so an omitted or wrong value still degrades attribution: B1 improves coverage, and A1a's validation (cwd, time, notebook) stays in force. Value to agentflow itself: auditable, machine-readable run history.

**B2 — writer-owned usage block at close (runtime extension).** An opt-in `usage-reporter` command whose output agentflow places in the Reply as a **writer-owned block**, treated like the stamp:

- **Placement and retries:** the block is fenced, placed right after the stamp, and stripped before the retry comparison in `match_closed_close`.
- **Generation:** generated once per close attempt, persisted with that attempt, and reused byte for byte on retry.
- **Validation:** output is size-capped and rejected if it contains fences, headings or `* _` stamp lines.
- **Invocation:** the command receives the notebook path, Ask id and cutoff time. It is resolved from `PATH` only, and is called with `--contract 1`. It has a 3-second timeout, after which its process group is killed. It fails open, writing `usage: unavailable` only when explicitly enabled and it failed.
- **Cut-off:** the closing turn's own usage does not exist yet at close, so the block covers the Ask up to the close request and says so.

B2 changes closeout. It is proposed last, after the report format is stable and B0/B1 have settled.

**B-minor — recognise the side file (runtime extension).** Add `*.usage.md` beside notebooks to agentflow's list of recognised ignored files, so `--beside` works in stream worktrees.

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
- **Ask-start matching** fails when the owner edits the notebook directly instead of prompting, or when the hook did not capture the prompt (`no-ag`, no open Ask, ownership refusal, bare `godev`, hook failure). Unmatched Asks fall back to `estimated start`, or to `no local evidence` when this machine has no owner submission in their bounds; uncaptured prompts stay in whichever window they fall in and are only disclosed as unmatched submissions. Chat and later follow-ups that the hook does capture are filed by the notebook itself under the open Ask; the report agrees with the notebook and discloses them rather than judging intent.
- **Input receipts are not a history.** They describe only each host identifier's last scoped Ask and are replaced when scope is captured for another, so most closed Asks have none left (see Later).
- **Dispatch records are conventions.** They may be missing, late or hand-edited; the join validates cwd, time and notebook, then falls back to completion records, launch chains and finally windows, each with its own status. A local scan on 2026-10-05 (one machine, mixed releases, path hits rather than verified attribution) found the clone path in a coordinator tool result for 77% of worker clones, 85% with hand-written dispatch records; a coordinator wrapper that printed only a summary was one cause of the rest.
- **The proxy's inferred parent link** (overlapping activity) can file a worker under a sibling worker; it is ignored for external worker runs (see Lineage).
- **Transcript retention** (30 days by default) limits recomputation; frozen snapshots (A1b) are the durable record after that.
- **Several checkouts of one repository** are distinguished by resolved checkout root; symlinked paths are resolved before comparison.
- **The dashboard hides imported turns by default** (since `8e846c2`), because imported turns have no request/response files to open. The adapter reads merged index data itself, and A1a points report users to `/?imported`.
- **An ephemeral Codex worker that bypasses the proxy is invisible.** Upstream's looper starts Codex workers with `codex exec --ephemeral`, which writes no transcript; unless the worker's requests reach the proxy, neither source records its turns, so the report cannot count it and nothing flags the gap. Routing Codex workers through the proxy is still to be chosen (see Later).
- **Effort of turns imported before #637 is `unknown`.** The importer has written effort since 2026-09-27, but already-imported lines are not rewritten; `ccxray rebuild-index --reimport` backfills them.
- **The report holds every index line of the notebook's span in memory.** It streams the index but keeps each line from a day before the notebook's earliest window (its first Reply stamp, or an earlier matched start) to now, across all projects on the machine, before selecting this checkout's. Baseline (2026-10-12, Apple M4 Pro, Node 22, 3 runs): the acceptance project's 154-Ask notebook against a 385,691-line index, 31,847 lines in its span, took a median 3.2 s and peaked at 411–482 MB RSS. A notebook that lives for months on a busy machine pays for all of that machine's traffic.
- **A first round whose sessions all went quiet early can be missed.** To find a start earlier than a day before the earliest Reply stamp (an open-only notebook, a first round worked for days), the report aligns only the checkout's transcripts written to since that point. If every session of the first Ask was last written before it, the first Ask has no matched start and, with no earlier Reply stamp, is reported `unmeasured` without its calls. Later Asks are not affected: their submissions follow the earliest stamp. Aligning every transcript of the checkout whatever its age closes this, at a measured +2.5 s on the acceptance machine, mostly spent reading the heads of unrelated Codex rollouts; left open until a real notebook shows the case.
- **Upstream records task notifications as bullets.** agentflow's prompt hook writes Claude Code's `<task-notification>` messages (background-task completion notices injected as user messages) into the notebook as owner bullets. They are not owner submissions (Transcript evidence), so they match nothing and raise `unmatched bullets`: on the acceptance project one Ask showed 2 of its 3 bullets unmatched for this reason alone. The count is honest about the notebook, but it does not mean an owner prompt went uncaptured.
- **Grok is untested:** recorded Grok turns carry no cwd.
- **Only an experiment repository's Asks have gone through the proxy.** The `complete` and `partial proxy coverage` paths, the per-turn-twin rule and proxy-only host rows are so far checked only by isolated experiments (2026-09-26/27 and 2026-10-05); they need a real proxied Ask or fixtures (see A1a acceptance).

## Non-goals

- Changing agentflow's notebook, its prompts, or its Reply identity stamp in Phase A. (B2 proposes an opt-in, writer-owned block in the Reply.)
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

### Concurrency, Ask windows and a Codex worker (2026-10-05)

Against unmodified agentflow 8.4.14 (`d0a6dd0`), with an isolated proxy and no hooks:

- **Concurrent coordinators.** Two coordinator sessions in one worktree dispatched six workers through the real runner with the default clone location; the coordinators were simulated, and the workers were fakes that send their cwd as the real CLIs do.
  - The proxy's worker cwd equalled the runner's reported clone path in 6 of 6; the runner resolves it with `realpath`, as worker `getcwd` does, and a real `claude -p` worker showed the same `/private/var/...` form.
  - The clone path in coordinator tool results identified the right session in 6 of 6, but only because the simulated coordinators passed the runner result through verbatim. Reflog was ambiguous in 6 of 6 (identical source); path pattern plus window was ambiguous in 5 of 6.
  - The second session's `agf start` recorded nothing and reported the same `A-001`: concurrent coordinators in one worktree share an Ask.
  - The proxy's inferred parent filed both Codex workers under a sibling Claude worker.
- **Ask windows.** One real experiment session (A-002 to A-004): all 14 assistant messages fell inside windows; the largest tail after a Reply stamp was 6 s. Simulated chat showed the notebook semantics in the Ask row of agentflow concepts: chat after a Reply starts the next Ask early rather than extending the previous tail. A close never leaves anything but an empty `+` in the next Ask.
- **Codex worker.** One `codex exec --ephemeral` (codex-cli 0.159.3, ChatGPT subscription) launched by the unmodified runner, with no injected arguments and `openai_base_url`/`chatgpt_base_url` temporarily set at the top of `~/.codex/config.toml`: the request reached the proxy, its session id equalled the thread id, and its cwd equalled the clone. stderr held three HTTP 451 responses from Codex's MCP transport, probably connector calls redirected to the proxy. The configuration file was restored byte for byte.
- Two adversarial reviews (GPT-6 Astra and Fable 5.1) of the conclusions and of the resulting design led to the ordered alignment, the `launch-chain` evidence, the attribution status, and the withdrawal of two claims: that a close can leave pending questions in the next Ask, and that resumed sessions copy history into new transcripts.
