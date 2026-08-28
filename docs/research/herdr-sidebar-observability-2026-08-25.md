# Herdr sidebar observability — primary-source findings

Date: 2026-08-25
Scope: repository source/config/tests plus safe read-only `herdr` CLI inspection. No production code or tests changed.

## Limits and layout

- The installed CLI is `herdr 0.8.2`. `herdr --default-config` reports the expanded sidebar defaults as 26 columns, with min 18 and max 36. The plugin’s width probe accepts an explicit/env/context/layout width, clamps it to 8–96 columns, and falls back to 18: `plugins/herdr/bin/lib/ccxray.js:1833-1860`. Therefore 18 is the plugin fallback, not the normal Herdr default.
- `pane.report_metadata` accepts at most 16 token properties; token names are 1–32 ASCII letters/digits/`_`/`-` characters. The current bundled schema showed this at `herdr api schema --json` (`PaneReportMetadataParams`, generated output lines 2954–2965). Stored pane state exposes up to 32 tokens (`herdr api schema --json`, lines 856–864); the write/request limit is the relevant one.
- The installer emits `row_gap = 0`, native row 1 (`state_icon`, `agent`, `state_text`), four mutually exclusive context-color rows, and two row-3 rows (`facts`, `alert`): `plugins/herdr/bin/install-sidebar-summary.js:22-29,52-68`. The plugin deliberately sends only the seven row-reachable token names (`xray`, four context colors, `facts`, `alert`) and clears legacy/internal names: `plugins/herdr/bin/refresh-badges.js:273-301`.
- Herdr skips a row whose tokens are all empty. Thus seven config rows render three visible lines: native state, one active context row, and one active row-3 fact/alert. This is an intentional empty-row mechanism, not a missing-row bug: `plugins/herdr/bin/install-sidebar-summary.js:22-26`; guarded by `test/herdr-plugin.test.js:1346-1367,1400-1424`.

## Empty, unlinked, and linked states

- A located, healthy pane fills `$facts` with `cost · age`; a ranked non-owned concern fills `$alert`; exactly one is populated and the other is explicitly cleared: `plugins/herdr/bin/refresh-badges.js:93-124`. Row 3 does not repeat context pressure, blocked state, or no-telemetry because rows 2/1 own those meanings (`plugins/herdr/bin/lib/ccxray.js:403-415,489-513`).
- An unlocated pane fills neither row-3 token. Row 1 instead receives `ccxray: not linked`, `ccxray: no hub`, or, for a recently routed pane with no turn yet, `ccxray: ready · send prompt`: `plugins/herdr/bin/refresh-badges.js:258-270`; `plugins/herdr/bin/lib/ccxray.js:1050-1100`. The tests pin no row-3 duplication for unlinked/no-hub states: `test/herdr-plugin.test.js:1214-1234`.
- Matching is conservative. The badge first uses Herdr’s native session id, then exact pane/launch attribution, then selected root-session/cwd fallbacks; it does not borrow an unrelated pane’s telemetry: `plugins/herdr/bin/lib/ccxray.js:1050-1134,1258-1285`; `test/herdr-plugin.test.js:3688-3785`. The support contract defines `not linked` as insufficient pane/session evidence: `docs/herdr-support.md:189-201`.

## Context history: computation and rendering

- Per-turn context used is `ctxUsed` when present, otherwise input + cache-creation + cache-read tokens: `plugins/herdr/bin/lib/ccxray.js:602-608`. The session denominator is 1M if any turn has `beta1m`, otherwise the largest observed `maxContext`, otherwise 200K; provenance is `declared`, `observed`, `default`, or `contradicted`: `plugins/herdr/bin/lib/ccxray.js:610-629`. The sidebar history fold holds an unmarked decrease of at most 15 percentage points to suppress prompt/cache-count jitter, while preserving explicit `isCompacted` or larger reset drops.
- The badge’s display fold selects positively identified main-agent turns, falls back to `!isSubagent`, then all turns: `plugins/herdr/bin/lib/ccxray.js:632-743`. `summarizeTurnGroup` anchors ctx%, cache%, model, and the history to that set, using the latest anchored turn for the scalar percentage: `plugins/herdr/bin/lib/ccxray.js:919-1021`. This is deliberately different from core’s main/subagent classifier; the plugin’s two surfaces must still agree on comparable figures: `CLAUDE.md:25-33`; `docs/decisions/0005-agent-key-unreliable-shared-contract.md:53-114`.
- `contextSparkline` keeps only recent finite percentages. It uses 3–32 bars, defaults to 4, shows all history only when it fits the selected bar cap, otherwise the last bars, and left-pads with empty `▁` blocks: `plugins/herdr/bin/lib/ccxray.js:328-362`.
- `formatContextBar` budgets against the measured sidebar width (8–96, fallback 18). It reserves the percentage text, includes ` · cache N%` only when width is at least 22 and at least six bars remain, then clips the complete string to the width: `plugins/herdr/bin/lib/ccxray.js:516-533`. The width tests demonstrate 10 columns → six bars and 36 columns → twelve bars plus cache text: `test/herdr-plugin.test.js:3841-3874`. Context bands are green ≤40%, yellow ≤80%, red >80%; stale/unknown/provenance-doubt withdraws the confident band: `plugins/herdr/bin/lib/ccxray.js:337-342,963-1022`; `test/herdr-plugin.test.js:2037-2098`.

## Constraints on any change

- Preserve colocation, one semantic per visual channel, stable row height, rendering budget, attention-following, and structured emptiness: `docs/design-principles.md:32-40,42-69,71-98,112-129`.
- Do not add a new context/model/cost encoding beside the existing rows without deciding ownership. The signed-off concern order is quota refusal > stale > multi-failure > cache drop after row-owned tiers are removed: `plugins/herdr/bin/lib/ccxray.js:416-487`; `test/herdr-plugin.test.js:1065-1158`.
- Keep the installer conservative and reversible: remove only complete superseded token sets, preserve user-extended rows, and retain native/user rows: `plugins/herdr/bin/install-sidebar-summary.js:115-179`; `test/herdr-plugin.test.js:1298-1424,4423-4500`.
- If adding a figure to both the sidebar badge and Mission Control, place it in the shared contract. Model, context window/ctx%, cache%, failures, prompt-change, and same-session freshness must agree; cost, turn count, and the two time quantities intentionally do not: `CLAUDE.md:33`; `docs/decisions/0005-agent-key-unreliable-shared-contract.md:90-150`.
- The repository’s verification policy requires UI changes to receive real-browser smoke verification, and the known render ceiling is 471 turns / 32 lanes: `CLAUDE.md:48-62`; `docs/design-principles.md:71-81`.

## CLI check boundary

Safe commands run: `herdr --version`, `herdr --help`, `herdr --default-config`, `herdr api --help`, `herdr api schema --json`, and read-only `herdr pane/agent` help. Live socket reads (`herdr agent list`, `herdr pane current --current`, `herdr api snapshot`) returned `PermissionDenied` in this environment, so no live workspace/pane geometry was inferred. No mutating Herdr command was run.
