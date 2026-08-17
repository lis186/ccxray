## ccxray Herdr plugin

A Herdr plugin that launches agents through the ccxray proxy and reports their live
context, cost, and failure signals into the Herdr sidebar, plus a Mission Control view
across every agent pane in the workspace.

### Second review

grok reviewed the PR in six batches — server side, the shared library, the launch and
refresh lifecycle, install/remove, onboarding, Mission Control/TUI, and docs/manifest.
Full per-finding verdicts, including the ones rejected and why, are in
`.scratch/REVIEW-531-LEDGER.md`.

Fixes landed from the review, each with a test that fails on its parent commit and
passes on the commit itself; guards that pass on both sides are labelled as guards.

| | |
|---|---|
| the sidebar badge showed whichever conversation finished last | context% and cache% now anchor on the main agent — a live session oscillated 32% ↔ 13% with no compaction |
| a subagent's own session displaced the pane's session in the badge | the pane's root session is reported — a child at 95% made the pane look nearly full while its own conversation sat at 30% |
| the badge reported `fail 6x` where nothing had failed | per-turn tool failures only; the cumulative flag no longer marks every later turn |
| Mission Control could hang the pane | `wrapText` looped forever on a glyph wider than the column budget — `wrapText('中', 1)` threw, `wrapText('a 中 b', 1)` never returned |
| a rejected install left the user's herdr config broken | install now restores its backup on `herdr config check` failure, as remove always did |
| a commented-out example row dead-ended the install | row detection ignores line-leading comments |
| a double tap on Sidebar installed then removed | a 250ms deadzone after each blocking action |
| a slow launch was reported as a failure and forgotten | a timeout is an unknown outcome; the pane stays routed |
| a failed metadata write was counted as a refresh | the badge refresh exits non-zero when a write it was asked to make did not happen |
| an outdated mise Node took the process down with it | the launcher probes before handing over, and falls through to the other candidates |
| unrouted hub traffic attributed to the wrong pane | removed the agentType identity fallback — plugin launches always take the routed PID path |
| Mission Control attention filter excluded ready agents | widened filter to `severity !== 'green'`, matching the header count |
| all-unknown-cost row rendered a confident `$0.00` | renders `—` when no turn had a priced cost |
| config writes could truncate on crash | install and remove now write-temp-then-rename |

### Also fixed here: #538

`test/index-fields.e2e.test.js` was failing locally on unmodified main. It is a
load-sensitive timeout, not a logic bug: the guarded wait allowed 8s for "server boots,
restores, warms pricing, then scans and imports". Instrumented with all 14 cores
saturated, the first index line appears after 31s; unloaded, ~1s. Budget raised to 45s —
a passing run returns as soon as the line appears, so it costs nothing except on a
genuine failure.

### What is still open

Recorded, not silently dropped — all in the ledger with reasoning:

- **Install/remove edge cases** still unfixed: a `$summary` row living in a non-sidebar
  section, a rows array the parser cannot find, a user's last row silently gaining a
  trailing comma. This is the pair where a bug damages a file the user owns, so these
  are the highest-value remaining items.
- **Import freshness** (#532 follow-up): sessions not launched through ccxray are only
  seen by an importer that runs at server startup, so the badge can pair a live-ticking
  age with numbers hours old.
- **Full ADR 0017 confidence fold** in the plugin (follow-up): the plugin reimplements
  cost rendering instead of sharing core's fold. The `—` for all-unknown is the minimal
  fix; the full `~`/`+`/threshold machinery is deferred.
- **Launcher test failures** reproduced on one machine but not another (#542).
- **Refresh fan-out timeout mismatch** (#543): 10s child cap vs ~27s internal budget.

### Suite

2162 pass / 0 fail against an empty `CCXRAY_HOME` (run in batches on 2026-08-17).
The three launcher failures reported from a previous machine (#542) do not reproduce
on this machine — environmental, not a regression.

The plugin's own test file is 118/118.

grok gate clean
