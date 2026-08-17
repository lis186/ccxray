# PR #531 — grok second review ledger

Every finding, its verdict, and the evidence. Rejecting a finding is fine; the reason
is written down. Started 2026-08-17 by the session that took over from the w4:p1 handoff.

## How the review was run

`grok --prompt-file <p> --output-format json --json-schema <s> --max-turns 60 --cwd <repo>`

Three things mattered:

1. **`--prompt-file`, not `-p "$(cat …)"`.** A 62 KB prompt passed as an argv string is
   truncated; grok noticed the truncation, went to read the files itself, and burned its
   whole turn budget (`stopReason: cancelled`, 0 findings). With `--prompt-file` the
   whole package arrives intact.
2. **Full file bodies + an explicit "ground truth" section**, per the handoff's lesson.
   The ground-truth list (the exact `INDEX_FIELDS`, `parentSessionId` IS assigned, the
   `turnToolCalls` null-vs-`{}` contract, loopback is trusted) is what lets a finding be
   rejected with a citation instead of an argument.
3. **`--json-schema`** to force the finding shape. Note the `text` field then contains
   one JSON object *per turn* concatenated; `review/parse.js` extracts the richest one.

Batches: **2a** `lib/ccxray.js` · **2b** launch/refresh lifecycle · **2c** install/remove/
onboarding · **2d** readers/TUI/diagnostics. Batch 1 (server-side) was done by the
previous session.

**A fourth thing, and it is the one that nearly lost half the review**: when grok is
cancelled mid-turn, **its findings are in the `thought` field, not `text`.** Batches 2c,
2c1 and 2d all reported `stopReason: cancelled` and an empty or near-empty `text`, and
were initially recorded as "0 findings". They were not: re-parsing `thought` recovered
**16 findings from 2c1 and 15 from 2d**, including the two worst defects in the whole
review (a `wrapText` infinite loop, and install leaving the user's herdr config broken).
`review/parse.js` now scans `text` + `thought` and salvages loose finding objects from a
truncated array.

Two corollaries: `--json-schema` was never the problem (dropping it changed nothing —
2c1 was still cancelled, at 3 turns instead of 5), and neither was prompt size (2c1 is
20 KB). A cancelled run is worth parsing, not re-running.

## Verdicts

Legend: **REAL** = confirmed, fix it · **FALSE** = disproved, reason recorded ·
**HALF** = mechanism real, stated scenario wrong · **DEFERRED** = real but already an
accepted, documented limit · **OPEN** = not yet adjudicated.

### Batch 2a — `plugins/herdr/bin/lib/ccxray.js`

| # | Sev | Claim | Verdict |
|---|-----|-------|---------|
| 1 | high | agentId-matched pane picks the session with the latest `receivedAt`, so a child session displaces the pane's main session | **REAL — FIXED** `8df9e44` |
| 2 | high | ctx% comes from the latest turn in the sessionId group, subagent turns included | **REAL — FIXED** `1700eda` (live data, see below) |
| 3 | med | `toolFailureCount` uses `turnToolFail \|\| toolFail`; a historical cumulative `toolFail` marks every later turn as failed | **REAL — FIXED** `c61a27e` |
| 4 | med | a native session id with no index lines yet falls through to older agentId traces → previous session's cost shown | **OPEN** |
| 5 | med | `recoverWorkspaceCwd` reads only `data.result.panes`, so a flat `{panes:[…]}` payload returns null | **OPEN** |
| 6 | med | OpenAI turns take the per-tool-max branch and undercount repeats | **DEFERRED** |
| 7 | low | `missionControlSnapshot` defaults `opts.env` to `process.env`, so an in-process call scopes through ambient `HERDR_WORKSPACE_ID` | **OPEN** |

#### 2a-#2 — confirmed against real data (this is also what the owner reported)

The owner independently observed the sidebar context% falling without any compaction.
Real index, session `7baf1fc0-cf42-48b9-b0a6-bb9c961261f1`, 224 turns: **two
conversations share one `sessionId`.**

| | main | background |
|---|---|---|
| model | claude-opus-5 | claude-sonnet-5 |
| agentKey | `orchestrator` | `agent` |
| isSubagent | false | **false** |
| convId | 5e666e0a | 5abe96ae |
| coreHash | d03b6d2c | **empty** |
| msgCount | 245 | 2 |
| ctxUsed | ~319,000 (31.9%) | ~126,000 (12.6%) |

Observed tail, alternating: `30.2 → 12.3 → 30.5 → 12.5 → 31.5 → 12.5 → 31.7 → 12.6`.

`sessionSummaryDetails` groups by `sessionId` alone, then `summarizeTurnGroup` takes
`sorted.at(-1)`, so whichever conversation finished last sets the number.

**Correction to grok's own framing**: it attributes this to `isSubagent` turns. On the
real data the offending turns have `isSubagent: false` and the *unreliable* catch-all
`agentKey: 'agent'` (ADR 0005), with an **empty** coreHash — so an `!isSubagent` filter
alone does not fix it, and neither does ADR 0010's coreHash routing as written. Also
77 of the 224 turns carry **no agentKey at all** (imported turns).

**Owner decision (2026-08-17): the sidebar shows only the MAIN agent's context% and
cache%.** So `sessionCachePercent` / `cacheHitText` need the same turn selection — this
is two call sites, not one. Exact predicate + where it lives is out with fable.

#### 2a-#3 — verified numerically

Predicate in `toolFailureCount` vs `turnFailed` in the same file, on
`[{turnToolFail:true,toolFail:true}, ×5 {turnToolFail:false,toolFail:true}]`:
`toolFailureCount → 6`, `turnFailed → 1`. Same file, two predicates, disagreeing.

#### 2a-#6 — deferred with a citation, not ignored

`docs/decisions/0018-turn-tool-calls-null-vs-empty.md` already records this exact
behaviour as an accepted limit: *"OpenAI/Codex undercount: OpenAI entries carry per-turn
`toolCalls` … so the current fallback sites apply per-tool max instead of sum. This
undercounts repeated same-tool calls across turns. … Tracked as a follow-up, not solved
here."* The plugin inherits core's documented position. Not a #531 blocker.

### Batch 2b — launch / refresh lifecycle

| # | Sev | Claim | Verdict |
|---|-----|-------|---------|
| 1 | high | no SIGINT handler in `run-agent.js`, so Ctrl+C leaves the spawned ccxray running | **HALF — see below** |
| 2 | med | `recordRoutedPane` runs before `herdr pane run`; an ETIMEDOUT that still started the command forgets the record and reports failure | **OPEN** |
| 3 | med | a launched pane reads `not linked` unless the hub is already up and the routed record is < 5 min old | **OPEN** |
| 4 | med | children are killed at 10 s but `refresh-badges` allows `ccxray usage` 12 s alone | **REAL — needs a decision, see below** |
| 5 | med | badge publishes importer-sourced numbers as `xray=ok` with a live-ticking age and no stale marker | **REAL — this is the owner's import-freshness item** |
| 6 | low | `refresh-badges` exits 0 even when the metadata write failed, so the fan-out counts it refreshed | **REAL — FIXED** `efb2aa7` |
| 7 | low | `run-node.sh` execs mise unconditionally once it prints a version, never falling back | **OPEN** |

#### 2b-#1 — measured, not argued

Stub agent that logs the signals it receives, `run-agent.js` in its own process group:

| signal sent | child received SIGINT? |
|---|---|
| `kill -INT -<PGID>` (what Ctrl+C actually does) | **yes** |
| `kill -INT <supervisor pid only>` | no |

Ctrl+C is delivered to the whole foreground process group, so the child gets SIGINT
directly and grok's stated scenario does not occur. The residual — a supervisor that
signals *only* the command pid — is real but narrow, and herdr would use SIGTERM/SIGHUP
for that, both of which the code already forwards. Same shape as batch-1 #2.

#### 2b-#4 — real, but the fix is a tradeoff someone has to pick

Confirmed by reading: `refresh-all-badges.js:35` gives each child `timeout: 10000`,
while `refresh-badges.js` alone budgets `statusReport` 5 s + `usageReport` 12 s +
`herdrAgentReport` 1.5 s + `contextSidebarColumns` 1.2 s + two `report-metadata` calls
2 s each + notification 3 s ≈ **26.7 s worst case**. On a large index a *working*
refresh is killed and (after `efb2aa7`) correctly counted as failed — the badge simply
never updates at startup.

Both obvious fixes are bad in different ways, which is why this is not just committed:

- raise the child timeout to ~20–30 s → the fan-out is a **serial** `for` loop, so ten
  panes become a 200–300 s startup sync;
- lower the child's own budget → a slow `ccxray usage` then fails inside the child
  instead of outside it, which changes nothing the user sees.

The real answer is probably to stop paying `ccxray usage` once per pane (it is the
dominant term and its result is largely pane-independent) — but that is a restructure,
not a timeout tweak. Deferred deliberately, not forgotten.

#### 2b-#1, #3, #5 — remaining

- **#1 HALF** (see the measurement above) — no change made.
- **#3 OPEN**: `routed` requires the hub to be up *and* the routed record to be under
  5 minutes old, so a pane launched and left alone for six minutes flips from
  `ccxray: ready · send prompt` to `ccxray: not linked`. Narrow (any trace at all makes
  `routed` true regardless), real, unfixed.
- **#5 REAL** — the owner's import-freshness item, handoff task 2. Deliberately left for
  that task rather than folded in here.

### Batch 2c1 — install / remove sidebar (16 findings recovered from `thought`)

| Sev | Claim | Verdict |
|-----|-------|---------|
| high | install does not restore the backup when `herdr config check` rejects the merge | **REAL — FIXED** `4740a08` |
| high | remove *does* restore on the same failure | correct, and it is what made the asymmetry obvious |
| med | `hasToken` matches `$summary` inside a comment, blocking install | **REAL — FIXED** `9ed7b89` (line-leading comments; a token in a trailing comment is still seen, documented in the code) |
| med | `addRowsToExistingSection` inserts DEFAULT_ROWS into a section that has no `rows` array | **OPEN** |
| med | `writeFileSync` is not atomic | **OPEN** (bounded by the backup, which now restores) |
| med | `tokenRowRegex` removes a `$summary` row from a non-sidebar section | **OPEN** |
| med | CRLF configs fail the `summaryRow` regex | **OPEN** |
| med | a user's last row silently gains a trailing comma | **OPEN** |
| low | malformed `rows` array → manual-add message | **OPEN**, correct degradation |

The install/remove pair is where a bug damages a file the user owns and hand-edits, so
the remaining OPEN rows here are the highest-value thing left in this review.

### Batch 2d — mission control / TUI (15 findings recovered from `thought`)

| Sev | Claim | Verdict |
|-----|-------|---------|
| high | `wrapText` loops forever on a glyph wider than the column budget | **REAL — FIXED** `a84a8ab`. Worse than claimed: `wrapText('中',1)` throws RangeError, `wrapText('a 中 b',1)` never returns |
| high | Mission Control mutates state — `reportPaneTokens` on every render | **PARTLY REAL, BY DESIGN**: grok put it in `rowMetrics` (which is pure); the call is at `mission-control.js:299` inside `render()`, and it writes to *its own* pane (`HERDR_PANE_ID`), which is a dedicated pane under the manifest. Running `--once` inside an agent's pane would clobber that pane's `xray` token until the TTL expires. Low impact; not fixed |
| high | header `attention` count disagrees with the `attention` filter | **REAL, BUT NEEDS AN OWNER DECISION** — see below |
| high | `rowCost` renders `$0.00` without `~` when cost is 0 but `exactCost` is false | **REAL** — belongs with the provenance task (handoff #4), not an ad-hoc patch; see below |
| high | `compactTokens(0)` yields `NaN K` | **FALSE** — `compactTokens(0)` returns `'0'` (the `< 1000` branch) |
| med | `fitColumns` can `' '.repeat(negative)` and throw | **FALSE** — the `gap >= 2` guard means a negative gap never reaches `repeat` |
| med | `notifications.writeState` throws on an unwritable state dir | **OPEN** |

#### 2d attention count — I started to fix this and stopped

`missionControlSnapshot` counts `severity !== 'green'` (so `ready` is included);
`filteredMissionRows(rows, 'attention')` returns only `red|yellow`. The header can
therefore promise rows the filter will not show. That much is fact.

But changing the count broke an existing test named *"mission-control distinguishes
review-ready agents from yellow risk"*, which asserts `1 active panes · 1 attention` for
a single READY pane. The author deliberately pinned "a finished agent wanting review
counts as attention". So the fix could equally be to widen the filter, and choosing
between them is a product decision about what the word means, not a defect I should flip
unilaterally. Reverted; recorded here for the owner.

#### 2d `rowCost` cost-confidence — real, but not a one-line patch

`rowCost` (`mission-control.js:89`) is `row.exactCost || row.cost === 0 ? cost : '~'+cost`,
so a row whose turns all had *unknown* cost sums to 0 and renders a confident `$0.00` —
"this cost nothing" where the truth is "we do not know". `confidenceCost` has the same
shape. ADR 0017 is explicit that a site rendering a bare total "silently reverts to
unmarked fabrication", and its convention for no-priced-data is `—`, not `$0.00`. The
honest fix is to give the plugin the same fold (`fallbackCost`/`unknownCount`/`count`),
which is exactly what handoff task 4 sets up. Folding a half-version in here would make
the later extraction harder, so it is recorded, not patched.

### Batch 2c2 — onboarding / Quick Start (14 findings, `end_turn`)

| Sev | Claim | Verdict |
|-----|-------|---------|
| med | a second keypress queued during a blocking action runs against the refreshed state — `s` installs, the queued `s` removes | **REAL — FIXED** `6f4288d` |
| high | `closeMenu` never exits the process, leaving Quick Start inert on screen | **NOT REPRODUCED — see below** |
| high | a lone ESC byte is treated as close, so a split arrow-key CSI sequence dismisses the menu | **OPEN — plausible, unverified** |
| med | Doctor's real report is discarded; failure shows the banner line, success shows "Doctor passed." even when the report said "Hub: not running" | **OPEN** |
| med | the same queue re-runs launch, starting two traced agents | **OPEN** (same root cause as the fixed one; the deadzone should cover it, unverified) |
| low | a spawn timeout/ENOENT with empty stdio reports "unknown error" because `result.error` is never read | **OPEN** |
| low | a signal during first-run leaves the lock file, so the next `--first-run` within 30s opens nothing | **OPEN** |

#### 2c2 double keypress — the codebase already knew

`backupConfigFile`'s comment in `lib/ccxray.js` reads: *"an install followed
immediately by a remove (two keypresses in Quick Start) collided and COPYFILE_EXCL
threw an unhandled EEXIST"*. So the scenario was known and the **symptom** (EEXIST) was
fixed; the **cause** — the second keypress running the opposite action — was not.

Reproducing it needs a genuinely blocking action: with an instant herdr stub the install
finishes before the second key and there is nothing queued. With a stub whose config
calls take a second, a double tap at 0.4s leaves 0 summary rows and **2 backups** (both
scripts ran) against a single tap's 1 backup.

Draining stdin does not work — by the time the handler returns the keypress is already a
queued `data` callback, so neither pausing nor reading takes it back. A 250ms deadzone
after each action does.

#### 2c2 closeMenu — I recorded this as confirmed, then disproved my own measurement

First observation: three seconds after `q`, `pgrep` still found the process. That
measurement was **contaminated** — I ran it from inside a Herdr pane without clearing
`HERDR_PANE_ID`, so `closeMenu` really did call `herdr plugin pane close w4:p9` against
my own live pane. (It survived; Herdr evidently refuses a pane it does not own. Worth
knowing before anyone repeats this.)

Re-run with `HERDR_PANE_ID` explicitly empty: the process exits. The finding does not
reproduce. What remains true is the asymmetry — `mission-control.js` and
`capability-review.js` both `process.exit(0)` after the identical sequence and
`onboarding.js` does not — which is fragile rather than broken: the day someone adds a
timer or an open handle to that file, `q` silently stops working. A labelled guard test
pins the observable behaviour so that day fails a test instead of a user. No behaviour
was changed.

## #538 — resolved (handoff task 3)

`test/index-fields.e2e.test.js` "imports a claude-code transcript…" is a **load-sensitive
timeout**, not a logic bug. `waitForIndexLines` allowed 8s for what is really "server
boots, restores, warms pricing, then scans and imports" — the importer is deliberately
non-blocking and runs last.

Evidence chain: the file passes twice on an idle machine; the single test passes in
isolation; a hand-spawned isolated server imports the fixture correctly; with all 14
cores saturated it fails every time with the reported error; instrumented under that
load the first index line appears after **31,097 ms**, roughly 4x the budget. Raised to
45s (`83204be`) — a passing run returns as soon as the line appears, so the larger budget
costs nothing except on a genuine failure. Verified 7/7 under the same saturation that
reproduced the failure.

This also explains the handoff's "reproduces on main, green on CI": the machine that
reproduced it was running background review jobs.

## Fixes landed

| Commit | What |
|--------|------|
| `1700eda` | badge context% and cache% anchor on the main agent (2a-#2) |
| `c61a27e` | badge counts only per-turn tool failures (2a-#3) |
| `8df9e44` | badge reports the pane's root session, not a child (2a-#1) |
| `efb2aa7` | badge refresh fails when the metadata write failed (2b-#6) |
| `eb889c5` | run-node.sh probes the mise Node before exec'ing it (2b-#7) |
| `d57cf1f` | an unconfirmed launch stays routed (2b-#2) |
| `a84a8ab` | wrapText no longer hangs on a wide glyph (2d) |
| `4740a08` | install restores the config when herdr rejects it (2c1) |
| `6f4288d` | a double keypress no longer undoes its own action (2c2) |
| `9ed7b89` | a commented-out row is not mistaken for an installed sidebar (2c1) |
| `83204be` | #538 importer wait budget |

Every one carries a fail-on-old / pass-on-new assertion; guards that pass on both sides
are labelled as guards in the test bodies.

### Two claims tested and disproved rather than fixed

- **CRLF configs break the install's row regexes** (2c1) — false. A CRLF config installs
  cleanly: exit 0, all four colour rows added.
- **`compactTokens(0)` yields `NaN K`** and **`fitColumns` can `repeat(negative)`** (2d) —
  false; the `< 1000` branch and the `gap >= 2` guard respectively.

### One test written, measured, and then deliberately removed

The pty reproduction of the double-keypress bug was automated first. It passed alone and
failed under full-suite load — reporting 0 backups because the *first* install had not
finished either, not because the bug had returned. A flaky test in a suite whose green is
a pre-push gate is worse than no test (see #538 immediately above for what that costs).
It was replaced by a deterministic unit test of the extracted `createActionGate` with a
fake clock; the behavioural differential lives in the commit message and in this file.

## Suite state

Full suite against an empty `CCXRAY_HOME`: **2151 pass / 3 fail**.

The three failures are **pre-existing and unrelated** — `claude launcher mode` (two
subtests) and `codex desktop app launcher mode`. Verified by checking out the merge base
`5833300` into a throwaway worktree and running the same pattern: identical three
failures there. They also fail when run alone, so they are not the parallel-load flakes
the handoff warned about; something environmental about spawning the agent binaries on
this machine. Not in scope for #531, but worth an issue — the handoff did not mention
them, so they may be recent.

Plugin file alone: **116/116**, including under full CPU saturation.

## Carried over from batch 1 (previous session)

| # | Verdict | Reason |
|---|---------|--------|
| 9 | FALSE | `parentSessionId` IS assigned — `store.js:735` `linkParentSession`, and it is in `INDEX_FIELDS` (`server/entry.js:53`) |
| 8 | FALSE | the two merge sites without a session check move `sessionId` in the same atomic unit |
| 2 | HALF | `child.kill()` on a dead child returns `false`, verified empirically — it does not throw |
| 4, 5 | REJECTED | loopback-spoofing claims inside the documented threat model (CLAUDE.md: loopback is trusted by default) |
| 1 | OPEN | SIGHUP vs identity-resolution race |
| 6, 7 | **IN SCOPE — mechanism established** | see below |

### 6/7 — unrouted traffic attributed to the only client of that agentType

Not a pre-existing behaviour to wave away: `lookupClientIdentityForAgent` and
`lookupClientIdentityForRequest` **do not exist on `origin/main`** — both are new in
this PR (`git show origin/main:server/hub.js | grep -c` → 0).

Mechanism (`server/hub.js:504-527`, `server/forward.js:130-140`):

1. request arrived on `/_ccxray/client/<pid>/…` → that client's identity, exact;
2. otherwise `lookupClientIdentityForAgent(agentType)` — attributes **only when exactly
   one** connected client has that agentType (`matches.length !== 1 → null`);
3. otherwise env identity, gated on `!routedClient && !identity && (!hasClients() || envMatchesAgent)`.

The plugin's own launches always take path 1: `run-agent.js` spawns `ccxray <agent>`,
which sets `CCXRAY_HUB_CLIENT_PID`, and `providers.js:19-25 proxyBaseUrl` puts
`/_ccxray/client/<pid>` in the base URL. So path 2 is reached only by traffic that
bypassed `ccxray <agent>` — e.g. a hand-exported `ANTHROPIC_BASE_URL`. In that case its
turns are stamped with the one registered pane's `agentId` and land on that pane's badge.

Narrow today (the PATH shim that would create such traffic is explicitly de-scoped), but
real, and it is new code. **REAL — FIXED** by removing `lookupClientIdentityForAgent`
entirely. Unrouted traffic now returns null (differential test: fail-on-old confirmed).

### Batch 3 — docs, READMEs, and manifest (2026-08-17, this session)

Files: `plugins/herdr/herdr-plugin.toml`, `plugins/herdr/README.md`, `README.md`,
`docs/data-model.md`, `docs/herdr-ccxray-plugin-research.md`, `docs/normalization-map.md`,
`docs/provider-modules.md`, `docs/testing.md`, `docs/war-stories.md`,
`docs/wire-protocol-reference.md`.

| # | Sev | Claim | Verdict |
|---|-----|-------|---------|
| 1 | low | `docs/herdr-ccxray-plugin-research.md:10,38` references `reference/herdr` directory that does not exist in the repo | **DEFERRED** — archival research doc, not user instructions; harmless dead path |

All other claims verified correct: manifest commands resolve to existing scripts,
README env vars exist in code, data-model `parentSessionId` field exists, provider and
testing doc additions are accurate. No REAL findings.
