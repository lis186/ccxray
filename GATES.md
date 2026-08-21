# Gates: Herdr sidebar three-row layout — live verification

Scope: prove the three-row layout works on real traffic from all three providers (claude/codex/grok), end-to-end through the actual Herdr sidebar rendering path.

## Pre-conditions

- [x] G0: plugin root switched to this worktree
  EVIDENCE: `herdr plugin link` output confirmed `plugin_root: herdr-sidebar-ux/plugins/herdr`

## Row 3 token production (badge path, all providers)

- [x] G1: claude pane renders $facts when healthy
  EVIDENCE: real index session d30c3337 → `facts: $53.47 · 2.8h`, model opus-4-6, band green

- [x] G2: codex pane renders $facts when healthy (WS status 101 does NOT trigger alert)
  EVIDENCE: real index session 01a022ed → `facts: $0.25+ · 43m`, model gpt-5.6-sol, no false alert

- [x] G3: grok pane renders $facts
  EVIDENCE: real index session 01a022e9 → `facts: $0.33 · 47m`, model grok-4.6-build

- [x] G4: alert token produced when a tool failure exists
  EVIDENCE: smoke test `codex with fail` → `alert: fail 1x`, `facts: undefined`

## Row 1 state_labels

- [x] G5: located pane clears state_labels; unlocated pane sets them
  EVIDENCE: `herdr pane get wY:p35` shows `state_labels: {blocked/done/idle/unknown/working: "ccxray: not linked"}` (correct for unlocated); located pane test → `--clear-state-labels` in args

## Row 2 context-only tail

- [x] G6: ctx_bar tail shows cache%, not 'full'/'stale'/alert text
  EVIDENCE: smoke test `claude near-full` (85%) → `facts: $5.00 · 60m`, NO `full` in ctx_bar; `ctx_bar_red` contains sparkline + pct + cache, not `near full`

## Installer migration

- [x] G7: running install on user's actual config produces exactly 7 config rows / 3 visible lines
  EVIDENCE: real config migrated: 3 superseded rows removed ($ctx $model $cost, $tg $ty $tr, $summary), result has 7 rows (state_icon/agent/state_text + 4 ctx_bar colours + facts + alert). `herdr config check` passed, `reload-config` applied.

## Token budget

- [x] G7.1: badge refresh stays within Herdr's 16-token pane metadata cap
  EVIDENCE: pane report-metadata returns `ok` (not `invalid_metadata_token`). Worst case: 3 set + 7 clear = 10 unique names. Discovered during live verification — unit tests could not catch this because `reportPaneTokens` is mocked.

## Visual verification

- [x] G8: pane tokens on real herdr pane contain only the whitelisted set
  EVIDENCE: `herdr pane get wY:p35` after fix shows 10 tokens (xray, agent, age, cache, cost, ctx, ctx_bar_unknown, fail, model, turns). summary/ctx_band/ctx_bar cleared. facts/alert correctly absent (unlocated pane).

## Dashboard deep-link

- [x] G9: open-dashboard passes --session to ccxray open
  EVIDENCE: unit test with recording mock: `open --session sess-abc-123` in args log. Live verification deferred — standalone ccxray on this pane has no hub to serve the dashboard.
  NOTE: MC's `d` → dashboard (already shipped) covers the same path via `resolvePaneSessionId`.

## Full test suite

- [x] G10: npm test 2302 pass, 0 fail
  EVIDENCE: `# tests 2302 / # pass 2302 / # fail 0` (CCXRAY_HOME=$(mktemp -d), env scrubbed)

## Discovered issues fixed during verification

- Token budget overflow (G7.1) — herdr 16-token cap breached. Fixed by whitelisting only config-rendered tokens in `report-metadata`. Committed as a separate fix.
