# Gates: Herdr sidebar three-row layout — live verification

Scope: prove the three-row layout works on real traffic from all three providers (claude/codex/grok), end-to-end through the actual Herdr sidebar rendering path.

## Pre-conditions

- [ ] G0: plugin root switched to this worktree
  EVIDENCE: pending
  NOTE: requires user approval — affects the live sidebar

## Row 3 token production (badge path, all providers)

- [ ] G1: claude pane renders $facts when healthy
  CHECK: HERDR_PANE_ID=<claude-pane> node plugins/herdr/bin/refresh-badges.js 2>&1 | grep -oE 'facts=[^ ]+'
  EXPECT: facts=$
  EVIDENCE: pending

- [ ] G2: codex pane renders $facts when healthy (WS status 101 does NOT trigger alert)
  CHECK: HERDR_PANE_ID=<codex-pane> node plugins/herdr/bin/refresh-badges.js 2>&1 | grep -oE 'facts=[^ ]+'
  EXPECT: facts=$
  EVIDENCE: pending

- [ ] G3: grok pane renders $facts (with ~ if fallback-priced)
  CHECK: HERDR_PANE_ID=<grok-pane> node plugins/herdr/bin/refresh-badges.js 2>&1 | grep -oE 'facts=[^ ]+'
  EXPECT: facts=
  EVIDENCE: pending

- [ ] G4: alert token produced when a tool failure exists
  EVIDENCE: pending

## Row 1 state_labels

- [ ] G5: located pane shows Herdr-native state text, NOT ccxray summary
  CHECK: herdr pane get <pane-id> 2>/dev/null | node -e "process.stdin.on('data',d=>{const p=JSON.parse(d).result.pane;console.log('state_labels:',JSON.stringify(p.state_labels))})"
  EXPECT: state_labels: {}
  EVIDENCE: pending

## Row 2 context-only tail

- [ ] G6: ctx_bar tail shows cache%, not 'full'/'stale'/alert text
  EVIDENCE: pending

## Installer migration

- [ ] G7: running install on user's actual config produces exactly 7 config rows / 3 visible lines
  CHECK: CCXRAY_HERDR_SKIP_RELOAD=1 node plugins/herdr/bin/install-sidebar-summary.js 2>&1
  EXPECT: migrated
  EVIDENCE: pending

## Visual verification (actual sidebar rendering)

- [ ] G8: herdr sidebar renders exactly 3 lines per agent (visual confirmation via cmux or herdr pane get)
  EVIDENCE: pending

## Dashboard deep-link

- [ ] G9: open-dashboard action opens the correct session in the browser
  EVIDENCE: pending

## Full test suite

- [ ] G10: npm test 2302+ pass, 0 fail (already verified but re-run after plugin root switch)
  CHECK: env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS CCXRAY_HOME=$(mktemp -d) npm test 2>&1 | grep -E '^# (tests|pass|fail)'
  EXPECT: # fail 0
  EVIDENCE: pending
