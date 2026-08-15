# ccxray for Herdr

Mission control and capability diagnostics for Claude, Codex, and Grok sessions running in Herdr.

## Install

Requirements: Herdr 0.8.0 or newer, Node.js 18 or newer, and at least one supported agent CLI.

```bash
herdr plugin install lis186/ccxray/plugins/herdr
herdr plugin action invoke ccxray.herdr.quick-start
```

The GitHub checkout contains ccxray, so a separate global ccxray installation is not required. The plugin remains disabled if its platform or minimum Herdr version is incompatible.

## First run

The install command does not run startup hooks in an already-running Herdr process, so the second command opens **ccxray Quick Start** immediately. If onboarding has not been completed, the plugin also opens it once on the next full Herdr startup. Quick Start checks ccxray, detects the installed Claude, Codex, and Grok CLIs, and offers one-key launch actions. It does not install the optional sidebar or change Herdr configuration without an explicit `S` keypress.

Quick Start is a keyboard menu. Use `Up`/`Down` or `j`/`k` to move, `Enter` to run the highlighted action, and `q`, `Esc`, or `Ctrl+C` to close it. Number and letter shortcuts remain available. Unavailable providers and analysis panes stay visible with their requirement, but cursor movement skips them. `--once` keeps a plain, noninteractive rendering for logs and diagnostics.

Quick Start progressively reveals the rest of the product:

- Before the first traced session, it focuses on launching an available provider.
- After one session, it offers Mission Control.
- After five sessions, it offers Capability Review.

Reopen it at any time with the action below. To suppress only the automatic first-run pane, set `CCXRAY_HERDR_SKIP_ONBOARDING=1` in the environment that starts Herdr.

```bash
herdr plugin action invoke ccxray.herdr.quick-start
```

## What it adds

- `Open ccxray Quick Start` reports setup progress, launches installed providers, installs the optional sidebar with consent, and reveals analysis panes as their data becomes useful.
- `ccxray doctor` checks the Herdr runtime context, ccxray command resolution, hub status, and recent usage.
- `Launch Claude/Codex/Grok via ccxray` opens a Herdr split pane and starts the selected agent through ccxray with Herdr identity exported.
- `ccxray usage summary` prints a compact cost/session/tool summary.
- `Refresh ccxray badges` writes short `summary`, context, cost, model, cache, and failure tokens to the focused pane and workspace.
- Sidebar badges refresh when Herdr detects an agent or its state changes, and once after restored agents start.
- `Install ccxray sidebar summary rows` renders a two-line model/age/cost and width-aware context summary under each agent.
- `Open ccxray dashboard` delegates to `ccxray open`.
- `Focus highest-priority ccxray agent` jumps to the first actionable Mission Control row.
- `ccxray Mission Control` joins active Herdr agents to exact ccxray pane identities, ranks red/yellow/ready/green attention, and shows context velocity, main and child cost scopes, tool failures, cache health, freshness, and the next action.
- `ccxray Capability Review` aggregates seven-day MCP adoption, estimated schema tokens, and observed skill usage. It requires at least five eligible sessions before suggesting changes.
Task outcomes and cross-session value comparison deliberately remain ccxray core concerns. The plugin does not infer success from process exit, cost, context, or model behavior. Provider-neutral outcome capture is tracked in [ccxray issue #532](https://github.com/lis186/ccxray/issues/532).

## Common operations

```bash
# Update the Herdr-managed GitHub checkout
herdr plugin install lis186/ccxray/plugins/herdr

# Temporarily stop or resume hooks and actions
herdr plugin disable ccxray.herdr
herdr plugin enable ccxray.herdr

# Remove the sidebar rows before uninstalling the plugin
herdr plugin action invoke ccxray.herdr.remove-sidebar-summary
herdr plugin uninstall ccxray.herdr
```

Reinstalling replaces Herdr's managed checkout. Removing the sidebar rows creates a timestamped configuration backup and validates the resulting Herdr configuration before reloading it.

## Local data and trust

The plugin reads ccxray session metadata from `~/.ccxray/logs`, keeps only onboarding state under `HERDR_PLUGIN_STATE_DIR`, and talks to the local Herdr socket/CLI. It does not upload analytics. Agent requests still pass through ccxray to the provider selected by the user, as they do outside Herdr.

## Use

```bash
herdr plugin action list --plugin ccxray.herdr
herdr plugin action invoke ccxray.herdr.quick-start
herdr plugin action invoke ccxray.herdr.focus-attention
herdr plugin pane open --plugin ccxray.herdr --entrypoint mission-control --placement split
herdr plugin pane open --plugin ccxray.herdr --entrypoint onboarding --placement tab
herdr plugin pane open --plugin ccxray.herdr --entrypoint capability-review --placement tab
```

The context row is width-aware. `refresh-badges` first honors `CCXRAY_HERDR_SIDEBAR_COLS`, then Herdr plugin context sidebar fields, then uses `herdr pane layout` as a width estimate. Wider sidebars show more recent turns and may append one compact signal such as `near full`, `fail 2x`, or `cache 92%`.

Context colors are mutually exclusive: unknown is neutral gray, `ctx <= 40%` is green, `40% < ctx <= 80%` is yellow, and `ctx > 80%` is red. A pane without exact ccxray identity remains unknown; the plugin never borrows telemetry from another session in the project.

Mission Control adapts at 32 columns. `CCXRAY_MISSION_MAX_ROWS` limits visible agents and `CCXRAY_MISSION_COLS` overrides terminal width for diagnostics. Single-session capability observations are hidden by default; pass `--capabilities` only for diagnostics or use Capability Review.

## Local development

```bash
herdr plugin link /path/to/ccxray/plugins/herdr --enabled
herdr plugin action invoke ccxray.herdr.doctor
CCXRAY_MISSION_ONCE=1 node bin/mission-control.js
CCXRAY_HERDR_NO_BROWSER=1 node bin/open-dashboard.js
```

Inside the ccxray repository, the plugin resolves the local `server/index.js` CLI. `CCXRAY_BIN` or `CCXRAY_BIN_JSON` can override command resolution for diagnostics.
