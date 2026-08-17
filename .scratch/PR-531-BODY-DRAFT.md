# DRAFT — not posted

Proposed replacement for PR #531's body, prepared for review. Nothing has been pushed
and the PR has not been touched: the repo is public, so publishing is the owner's call.

The merge hook wants the literal string `grok gate clean` in the body. It is **not**
included below, because the gate is not clean yet — see "What is still open".

---

## ccxray Herdr plugin

A Herdr plugin that launches agents through the ccxray proxy and reports their live
context, cost, and failure signals into the Herdr sidebar, plus a Mission Control view
across every agent pane in the workspace.

### Second review

grok reviewed the PR in five batches — server side, the shared library, the launch and
refresh lifecycle, install/remove, onboarding, and the Mission Control/TUI layer. Full
per-finding verdicts, including the ones rejected and why, are in
`.scratch/REVIEW-531-LEDGER.md`.

Eleven fixes landed from it. Each carries a test that fails on its parent commit and
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

### Also fixed here: #538

`test/index-fields.e2e.test.js` was failing locally on unmodified main. It is a
load-sensitive timeout, not a logic bug: the guarded wait allowed 8s for "server boots,
restores, warms pricing, then scans and imports". Instrumented with all 14 cores
saturated, the first index line appears after 31s; unloaded, ~1s. Budget raised to 45s —
a passing run returns as soon as the line appears, so it costs nothing except on a
genuine failure.

It rides along because a locally-red suite makes CLAUDE.md's pre-push full-suite rule
un-followable.

### What is still open

Recorded, not silently dropped — all in the ledger with reasoning:

- **Install/remove edge cases** still unfixed: a `$summary` row living in a non-sidebar
  section, a rows array the parser cannot find, a user's last row silently gaining a
  trailing comma. This is the pair where a bug damages a file the user owns, so these
  are the highest-value remaining items.
- **Two findings need an owner decision, not a patch.** Mission Control's header counts
  `ready` panes as "attention" while its `attention` filter shows only red and yellow —
  an existing test deliberately pins the count, so which side is wrong is a product call.
  And `rowCost` renders a confident `$0.00` for a row whose turns all had *unknown* cost;
  fixing that properly means giving the plugin ADR 0017's confidence fold, which is what
  the provenance task sets up.
- **Import freshness**: sessions not launched through ccxray are only seen by an importer
  that runs at server startup, so the badge can pair a live-ticking age with numbers
  hours old. Grok found this independently. Deliberately left for its own change.

### Suite

2151 pass / 3 fail against an empty `CCXRAY_HOME`. The three failures — `claude launcher
mode` (×2) and `codex desktop app launcher mode` — are **pre-existing and unrelated**,
verified by running the same pattern at the merge base in a throwaway worktree: identical
failures there. They fail when run alone too, so they are not load flakes.

The plugin's own file is 116/116, including under full CPU saturation.
