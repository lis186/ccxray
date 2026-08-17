# Work order: bring PR #531 (ccxray Herdr plugin) to merge-ready

You are picking up mid-stream work on a fresh machine. Everything you need is in this
document and in the repo. Do not merge anything — the owner merges. Your goal:
**finish the gate-clean batch below so the owner can mark PR #531 ready and merge it.**

## Orientation

- **ccxray** is a transparent HTTP proxy between coding agents (Claude Code, Codex,
  Grok CLI) and their APIs. It records every request/response into
  `~/.ccxray/logs/index.ndjson`, serves a dashboard, and computes cost/context.
  Read `CLAUDE.md` at the repo root — it is authoritative on invariants, testing,
  and the merge process.
- **The Herdr plugin** (PR #531, draft, repo `lis186/ccxray`, PUBLIC) integrates
  ccxray with Herdr, a third-party terminal workspace manager: it launches agents
  through the proxy, shows per-pane context%/cost/failure badges in Herdr's sidebar,
  and provides a Mission Control TUI across panes. 54 files, ~7,300 insertions;
  `plugins/herdr/bin/**` is the new runtime (19 files), plus server-side changes
  (`server/hub.js` client-identity plumbing, `agentId`/`agentType` fields).
- **Branch**: `codex/herdr-plugin-research`, pushed, 11 fix commits ahead of its merge
  with main (merge base `5833300`). Deliberately unmerged.
- The branch already absorbed a full adversarial second review (grok, six batches,
  ~60 findings). 11 fixes landed, each with a differential test:

  | commit | fix |
  |---|---|
  | `1700eda` | sidebar context%/cache% anchor on the main agent (was: whichever conversation finished last — a live session oscillated 32%↔13% with no compaction) |
  | `c61a27e` | badge counts only per-turn tool failures (cumulative `toolFail` marked every later turn) |
  | `8df9e44` | badge reports the pane's root session, not a more recent child session |
  | `efb2aa7` | badge refresh exits non-zero when its metadata write failed |
  | `eb889c5` | run-node.sh probes the mise Node before exec'ing it |
  | `d57cf1f` | an unconfirmed launch stays routed (timeout = unknown outcome, not failure) |
  | `a84a8ab` | `wrapText` no longer hangs/throws on a glyph wider than the column budget |
  | `4740a08` | install restores the config backup when `herdr config check` rejects the merge |
  | `6f4288d` | 250ms deadzone stops a double keypress in Quick Start undoing its own action |
  | `9ed7b89` | a commented-out example row is not mistaken for an installed sidebar |
  | `83204be` | #538: importer e2e wait budget raised to 45s (load-sensitive timeout, not a logic bug) |

- The review ledger is `.scratch/REVIEW-531-LEDGER.md` (committed with the branch as of
  `d1a4e84`). Everything load-bearing from it is restated inline below; treat the file
  as the fuller record and keep it updated as you adjudicate.

## Decisions already made — implement, do not re-litigate

These were decided by the owner after a full advisory review. The reasoning is included
so you can recognise if reality contradicts a premise; absent that, implement as stated.

1. **Continue on this branch; no rewrite.** The review's real findings were
   domain-born (a user-hand-maintained TOML file, ccxray's genuinely subtle session
   model, pty timing), not architectural; the fixes converged on definitions rather
   than accumulating special cases; the 116 plugin tests and the review record are the
   asset. Settled — do not propose starting over.
2. **Mission Control `attention`: widen the filter, keep the count.** The header count
   (`plugins/herdr/bin/lib/ccxray.js:1134`) is `severity !== 'green'` (includes
   `ready`); the filter (`plugins/herdr/bin/mission-control.js:161`) shows only
   `red|yellow`. An existing test named "mission-control distinguishes review-ready
   agents from yellow risk" deliberately pins "a finished agent awaiting review counts
   as attention" — that is the product intent (a done agent blocked on human review
   needs the operator most, and there is already a separate `ready` filter via
   `cycleMissionFilter` at line 307 for the narrow slice). **Fix: change the
   `attention` filter to `severity !== 'green'`.** The pinned test stays green; add a
   differential test for the filter.
3. **`rowCost`/`confidenceCost`: render `—` when no turn had a priced cost.** Currently
   (`mission-control.js:89` and `:94`) a row whose turns all have *unknown* cost sums
   to 0 and renders a confident `$0.00` — "this cost nothing" where the truth is "we
   do not know". Core's ADR 0017 (`docs/decisions/0017-aggregate-cost-confidence.md`)
   calls this unmarked fabrication and its convention for no-priced-data is `—`. This
   needs only an unknown-vs-priced turn count, NOT the full confidence fold — the
   `~`/`+`/threshold machinery is deliberately deferred to task 4 (below). Do the
   minimal `—` rule now, in this PR.
4. **Remove the hub agentType identity fallback.** `lookupClientIdentityForAgent`
   (`server/hub.js:504`, called from `lookupClientIdentityForRequest` at `:521`,
   consumed in `server/forward.js:130` `requestDeploymentFields`) is NEW in this PR:
   unrouted traffic is attributed to the sole connected client of that agentType.
   Verified: the plugin's own launches always take the routed
   `/_ccxray/client/<pid>` path (`server/providers.js` `proxyBaseUrl`), so the
   fallback's only real consumers are hand-exported `ANTHROPIC_BASE_URL` traffic —
   where attribution is a guess landing on the wrong pane's badge. **Remove it** (keep
   the routed path and the env-identity path). Escape hatch: if you find a legitimate
   consumer the analysis missed, do not silently keep it — write the acceptance and its
   reason into the review record and flag it to the owner.

## The gate-clean batch, in order

CLAUDE.md: a second review is mandatory before merge; the merge hook accepts the
literal string `grok gate clean` in the PR body. That string is currently a FALSE
statement. It becomes true when every raised finding has a written verdict (fixed,
disproved with citation, or deferred with reason), all batches have actually run, and
the decided items above are implemented. Work list:

1. **Full suite baseline on this machine** (before touching anything):
   `CCXRAY_HOME=$(mktemp -d) npm test`. Record the result — see "What is different on
   this machine" below for how to read it. Acceptance: results recorded; any failures
   classified against the known three (below) before proceeding.
2. **Implement decision 4** (remove the agentType fallback). Acceptance: fallback gone;
   a test proves unrouted traffic is no longer attributed to a registered client;
   routed-path attribution test still green; full suite no worse than baseline.
3. **Implement decision 2** (widen the attention filter). Acceptance: filter returns
   `severity !== 'green'`; the pinned review-ready test untouched and green;
   fail-on-old test for the filter.
4. **Implement decision 3** (`—` for all-unknown cost). Acceptance: a row with
   turns-all-unknown renders `—` (old code: `$0.00` — differential test); a row with
   any priced turn keeps current behavior; same for the header `confidenceCost`.
5. **Atomic config writes in install/remove**
   (`plugins/herdr/bin/install-sidebar-summary.js:205`,
   `plugins/herdr/bin/remove-sidebar-summary.js:71`): replace direct
   `fs.writeFileSync(file, next)` with write-temp-then-rename in the same directory.
   These scripts edit a config file the user hand-maintains; a crash mid-write
   currently leaves a truncated file with no auto-restore (the backup exists but
   nothing prints its path). ~5 lines + test.
6. **Run the skipped review batch** over the never-reviewed files:
   `plugins/herdr/herdr-plugin.toml`, `plugins/herdr/README.md`, `README.md`, and the
   `docs/` deltas
   (`git diff --name-only 5833300..HEAD | grep -vE '^(plugins/herdr/bin|server|test)/'`).
   How to run a grok batch correctly (hard-won, follow exactly):
   - `grok --prompt-file <file> --output-format json --json-schema <schema> --max-turns 60 --cwd <repo>` —
     **`--prompt-file`, never `-p "$(cat …)"`** (argv truncates large prompts; grok
     then burns its turn budget re-reading files).
   - The prompt must contain **full file bodies plus a ground-truth section** listing
     what already exists on main (a diff-only reviewer produces confident false
     positives about anything whose other half lives on main).
   - **Parse `text` AND `thought`.** When a run ends `stopReason: cancelled`, its
     findings are typically complete in `thought` with `text` empty. A cancelled run
     is worth parsing, not re-running — this round nearly discarded 31 findings
     (including its two worst defects) by reading only `text`.
   - Adjudicate every finding with a written verdict. Confirming a finding is a claim
     too: reproduce it in a pinned environment (see preconditions) before recording
     REAL.
   Acceptance: every finding from this batch has a verdict; real ones fixed or
   explicitly deferred with reason.
7. **File two issues** (they exist only as notes today):
   - The three pre-existing launcher test failures (below), with this machine's
     reproduce/not-reproduce datum included.
   - The refresh fan-out timeout mismatch: `refresh-all-badges.js` caps each child at
     10s while `refresh-badges.js`'s own internal budgets sum to ~27s worst case, so a
     slow-but-working refresh is killed and counted failed. Both timeout tweaks are
     bad (serial fan-out × longer timeout = minutes of startup sync; shorter inner
     budgets change nothing). The real fix is to stop running `ccxray usage` once per
     pane (dominant term, largely pane-independent) — a restructure, deliberately
     deferred.
8. **Write the PR body and hand off to the owner.** A draft is at
   `.scratch/PR-531-BODY-DRAFT.md`. Contents: what the plugin is; the 11-fix table
   above; the still-open list (next section) stated as recorded-not-dropped; a link to
   the launcher-failures issue so the suite claim is auditable; and — only once items
   1–7 are done — the literal line `grok gate clean`.
   Acceptance: full suite no worse than baseline; owner notified; **you do not merge**.

## Known-open and deliberately deferred — do not rediscover these as news

- **Install/remove edge cases** (all bounded by the backup → `herdr config check` →
  restore-on-failure envelope, on an opt-in action; deferred as follow-up):
  remove's token-row regexes are not scoped to the `[ui.sidebar.agents]` section (a
  `$summary` row elsewhere would be stripped — valid-but-wrong output, backup printed);
  install into a section with no `rows` array inserts DEFAULT_ROWS the user never had;
  a user's last row silently gains a trailing comma (legal TOML, cosmetic);
  `hasToken` still sees a token in a *trailing* comment after real content
  (line-leading comments were fixed in `9ed7b89`). Strategy decision already made:
  keep string surgery (a TOML parse/re-serialize would destroy the user's comments and
  formatting — worse); harden edges only.
- **Task 2 — import freshness** (own PR, first follow-up after merge): sessions not
  launched through ccxray are seen only by an importer that runs at server startup
  (`server/index.js:1068`), so the badge pairs a live-ticking `age` with numbers
  that can be hours stale (measured: transcript at 89% of 1M while the badge showed a
  four-hour-old 35%). Smaller piece first: mark the badge stale when the newest
  evidence is much older than the pane's activity. Then optionally
  `ccxray import --once` (lockfile + mtime gate, throttled, detached from
  refresh-badges) — do NOT gate it on "no hub running": a running hub does not
  re-import either, so that gate would leave hub users permanently stale.
- **Task 4 — provenance + cost-confidence fold in the plugin** (own PR, after task 2):
  the plugin reimplements cost rendering instead of sharing core's ADR 0017 fold, and
  sessions with an assumed 200K denominator render unmarked. First commit must extract
  the **provenance rule** (the four states in `sessionCtxWindowSource` — `declared |
  observed | contradicted | default`, ~20 subtle lines) into something the plugin can
  `require`. Do NOT extract the three-line window fold — the trade is not worth it.
  Warning from a verified dead end: core's `isMainTurnByAgentKey` returns TRUE for
  exactly the turns the badge fixes needed to exclude (real data: `agentKey:'agent'`,
  empty coreHash, `isSubagent:false`), so importing that predicate is a no-op — the
  plugin's main-turn selection needs its own predicate. Structural follow-up already
  agreed with the owner: name that predicate ONCE in `lib/ccxray.js` and move badge
  ctx%, cache%, session-pick, and attention severity onto it.
- **Three pre-existing full-suite failures** on the previous machine: `claude launcher
  mode` (2 subtests) and `codex desktop app launcher mode`. Verified pre-existing by
  running the same pattern at merge base `5833300` in a throwaway worktree (identical
  failures); they also fail when run alone, so they are not load flakes — likely
  environmental (agent-binary spawning on that machine). Not #531's problem, but file
  the issue (work item 7).
- **Smaller ledger leftovers** (recorded, unfixed, non-blocking): a pane flips to
  "not linked" when its routed record ages past 5 min without a trace; a lone ESC byte
  may dismiss Quick Start (unverified); Doctor's real report text is discarded;
  first-run lock file survives a signal; `notifications.writeState` on an unwritable
  dir; `missionControlSnapshot` defaults `opts.env` to `process.env` (ambient
  `HERDR_WORKSPACE_ID` scoping); Mission Control `--once` inside an agent's pane
  temporarily clobbers that pane's `xray` token (by-design, low impact).

## Environment preconditions — hard rules, each burned into this list by an incident

1. **Every test or probe that loads server code runs with `CCXRAY_HOME=$(mktemp -d)`**
   — otherwise it reads and can write the owner's real `~/.ccxray`.
2. **Export `CCXRAY_IMPORT_DISABLE=1` in any shell that preloads or requires server
   code ad hoc** — in the previous round, a `NODE_OPTIONS --require` probe was
   inherited by an unisolated parent process, which ran `scanAndImport()` against the
   owner's real index. Never leave `NODE_OPTIONS` set globally.
3. **`unset HERDR_PANE_ID HERDR_WORKSPACE_ID` in every measurement shell** — a probe
   run inside a Herdr pane called `herdr plugin pane close` on the operator's own live
   pane and produced a false "confirmed" verdict on a hang that does not exist.
4. **Pin `CCXRAY_PRICING_CACHE=/nonexistent/p.json` for spawned servers (or
   `pricing.__setContextTableForTests(null)` in-process)** — `pricing-cache.json` is
   package-relative, OUTSIDE `CCXRAY_HOME` isolation; without this, window-resolution
   behavior silently depends on the developer's cache. See `docs/testing.md`.
5. **Never run load-sensitive evidence concurrently with load-generating work**
   (grok batches, suite runs) — background review load is what made a 1s importer wait
   take 31s (#538) and made a cited differential test flaky. Timing-sensitive evidence
   is run twice: idle and deliberately saturated.
6. **If you must interact with a live hub, know that `rebuild-index` refuses while a
   hub is up and does NOT back up `index.ndjson`** — copy the file first.

## Verification standard (this repo enforces it)

- Every behavioral change needs a test that **fails on the old code and passes on the
  new** (`git stash push -- <paths>` then `node --test --test-name-pattern` is the
  standard way to demonstrate it). Tests that pass on both sides are fine but must be
  labelled as guards in the test body. See `docs/verification-principles.md`.
- **A red test must be red for the right reason.** Prove the harness detects a
  hand-induced positive before trusting its red — the previous round's first pty
  "reproduction" sent `printf 'ss'`, which arrives as one chunk and measured nothing.
- **Flaky evidence is worse than none.** If a differential test survives only in
  isolation, replace it with a deterministic unit test of an extracted helper and
  record the behavioral differential in the commit message.
- Claims about the corpus need real-data evidence — but see the next section: the
  previous machine's corpus is not here. Do not re-verify corpus claims on this
  machine; treat them as recorded findings.
- Before claiming done: full suite against an empty home, results compared to the
  baseline you recorded in work item 1. Rejecting or deferring a review finding is
  fine; doing it silently is not — write the reason down.

## What is different on this machine — check before trusting any comparison

1. **The corpus is different.** All of the previous round's real-data numbers (the
   32%↔13% oscillation session, duplicate-responseId counts, the 89%-vs-35% staleness
   measurement) came from the previous machine's `~/.ccxray`. They are recorded
   evidence, not reproducible here. Unit and e2e tests are the portable evidence.
2. **A hub may or may not be running.** `cat ~/.ccxray/hub.json` and check the pid
   before anything that spawns servers or rebuilds the index. Avoid port 5577 for
   smoke servers if a hub is live.
3. **The three launcher failures may not reproduce here — that is a datum, not a
   nuisance.** Previous machine: 2151 pass / 3 fail (the launcher trio), plugin file
   116/116 even under full CPU saturation. If this machine goes 2155/2155, the trio is
   environmental to the old machine — record that in the issue (work item 7). If it
   fails differently, stop and characterise before proceeding.
4. **Toolchain**: the launcher probes involve mise-managed Node
   (`plugins/herdr/bin/run-node.sh`); check `mise --version` / `node --version` before
   attributing any launcher-test delta to the code.
