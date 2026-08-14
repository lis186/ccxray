# ccxray for Herdr

This Herdr plugin exposes ccxray diagnostics inside Herdr:

- `ccxray doctor` checks the Herdr runtime context, ccxray command resolution, hub status, and recent usage.
- `Launch Claude/Codex/Grok via ccxray` opens a Herdr split pane and starts the selected agent through ccxray with Herdr identity exported.
- `ccxray usage summary` prints a compact cost/session/tool summary.
- `Refresh ccxray badges` writes short `summary`, `ctx_bar`, `ctx_bar_green`, `ctx_bar_yellow`, `ctx_bar_red`, `ctx_band`, `ctx`, `age`, `cost`, `model`, `xray`, `turns`, `cache`, and `fail` tokens to the focused pane and workspace.
- `Install ccxray sidebar summary row` appends Herdr sidebar layout rows that render `$summary` and the active color-specific context bar under each agent.
- `Open ccxray dashboard` delegates to `ccxray open`.
- `ccxray Mission Control` opens a live terminal pane and reports pane metadata when Herdr provides `HERDR_PANE_ID`.

## Local Development

```bash
herdr plugin link /path/to/ccxray/plugins/herdr --enabled
herdr plugin action list --plugin ccxray.herdr
herdr plugin action invoke ccxray.herdr.doctor
herdr plugin pane open --plugin ccxray.herdr --entrypoint mission-control --placement split
```

To show the compact two-line ccxray session summary under agents in the expanded sidebar:

```bash
herdr plugin action invoke ccxray.herdr.install-sidebar-summary
herdr plugin action invoke ccxray.herdr.refresh-badges
```

The second row is width-aware. `refresh-badges` first honors
`CCXRAY_HERDR_SIDEBAR_COLS`, then Herdr plugin context sidebar fields if they
exist, then falls back to `herdr pane layout` and uses `layout.area.x` as the
sidebar width estimate. Wider sidebars show more recent turns in `$ctx_bar` and
may append one compact signal such as `near full`, `fail 2x`, or `cache 92%`.
The installed sidebar uses mutually exclusive colored rows: `ctx <= 40%` is
green, `40% < ctx <= 80%` is yellow, and `ctx > 80%` is red. The plain
`$ctx_bar` token is still emitted for compatibility and debugging.

When the plugin is developed inside the ccxray repository it uses the local `server/index.js` CLI. In installed checkouts, set `CCXRAY_BIN` to a `ccxray` executable or ensure `ccxray` is on `PATH`.

For noninteractive validation:

```bash
CCXRAY_MISSION_ONCE=1 node bin/mission-control.js
CCXRAY_HERDR_NO_BROWSER=1 node bin/open-dashboard.js
```
