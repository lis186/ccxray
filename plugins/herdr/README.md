# ccxray for Herdr

Live session triage for Claude, Codex, and Grok in Herdr: see what needs attention, why, what to do next, and how certain the evidence is.

## Install

Requirements: Herdr 0.8.0 or newer, Node.js 18 or newer, and at least one supported agent CLI. The plugin accepts `CCXRAY_NODE=/absolute/path/to/node`; if `node` is a nonfunctional mise shim, it automatically uses the newest installed mise Node version.

```bash
herdr plugin install lis186/ccxray/plugins/herdr
herdr plugin action invoke ccxray.herdr.quick-start
```

The GitHub checkout contains ccxray, and Herdr runs the plugin's production dependency build before registration, so a separate global ccxray installation is not required. If that build fails, installation aborts instead of registering a broken plugin. The plugin remains disabled if its platform or minimum Herdr version is incompatible.

Herdr installs from the repository's default branch and prints nothing while it clones, checks out, and builds; expect 30 to 120 seconds of silence. Add `--ref <branch-or-tag>` to install a branch that has not been merged yet; without it, a repository whose default branch has no `plugins/herdr` directory fails with `No such file or directory (os error 2)`.

## First run

The install command does not run startup hooks in an already-running Herdr process, so the second command opens **ccxray Quick Start** immediately. If onboarding has not been completed, the plugin also opens it once on the next full Herdr startup. Quick Start checks ccxray, detects the installed Claude, Codex, and Grok CLIs, and offers one-key launch actions. It does not install the optional sidebar or change Herdr configuration without an explicit `S` keypress.

Quick Start is a keyboard menu. Use `Up`/`Down` or `j`/`k` to move, `Enter` to run the highlighted action, and `q`, `Esc`, or `Ctrl+C` to close it. Number and letter shortcuts remain available. Unavailable providers and analysis panes stay visible with their requirement, but cursor movement skips them. The `directory` status row names the project directory a launch would start in, resolved from the current Herdr workspace and never from the plugin's own checkout. The sidebar action is reversible: the same row installs it when absent and removes it when present, including when Herdr already has a `[ui.sidebar.agents]` table — installing then adds the ccxray rows to it and leaves the other rows untouched. A table this plugin created is removed whole; a table the user wrote or extended keeps everything except the ccxray rows. `--once` keeps a plain, noninteractive rendering for logs and diagnostics.

Immediately after a provider starts, the sidebar may show `ccxray: ready · send prompt`: the pane has reached ccxray but no conversation turn exists yet. It changes to model, age, cost, and context after the first response. `ccxray: not linked` is reserved for a pane with no routed ccxray telemetry. When Herdr exposes a native session id, the plugin also uses it to recover safely from older misattributed hub history without borrowing another pane's session.

Quick Start progressively reveals the rest of the product:

- Before the first traced session, it focuses on launching an available provider.
- After one session, it offers Mission Control.
- After five sessions, it offers the experimental Capability Footprint. Mission Control remains the recommended next step.

Reopen it at any time with the action below. To suppress only the automatic first-run pane, set `CCXRAY_HERDR_SKIP_ONBOARDING=1` in the environment that starts Herdr.

```bash
herdr plugin action invoke ccxray.herdr.quick-start
```

## What it adds

- `Open ccxray Quick Start` reports setup progress, launches installed providers, installs the optional sidebar with consent, and reveals analysis panes as their data becomes useful.
- `ccxray doctor` checks the Herdr runtime context, ccxray command resolution, hub status, and recent usage.
- `Launch Claude/Codex/Grok via ccxray` opens a stable new Herdr tab and starts the selected agent through ccxray with Herdr identity exported. Set `CCXRAY_HERDR_LAUNCH_PLACEMENT=split` only when a split is intentional.
- The launch actions honour `PROXY_PORT` (set it in the environment Herdr runs in): it moves the shared ccxray hub — discovery, the forked hub, and its dashboard — to that port, without switching to the standalone `--port` mode. Use it when the default port 5577 is held by something you want to keep running.
- `ccxray usage summary` prints a compact cost/session/tool summary.
- `Refresh ccxray badges` writes short `summary`, context, cost, model, cache, and failure tokens to the focused pane and workspace.
- Sidebar badges refresh when Herdr detects an agent or its state changes, and once after restored agents start.
- Background panes notify once when an agent becomes done or blocked. Done uses Herdr's done sound; blocked uses the request sound. Set `CCXRAY_HERDR_NOTIFICATIONS=blocked` to suppress completion notices or `off` to disable both.
- `Install ccxray sidebar summary rows` renders a two-line model/age/cost and width-aware context summary under each agent.
- `Open ccxray dashboard` delegates to `ccxray open`.
- `Focus highest-priority ccxray agent` jumps to the first actionable Mission Control row.
- `ccxray Mission Control` joins active Herdr agents to exact ccxray pane identities, ranks red/yellow/ready/green attention, and shows model, age, context pressure, cost, turns, tools, failures, cache health, evidence confidence, and the next action.
- `ccxray Capability Footprint (Experimental)` aggregates seven-day MCP schema estimates and observed MCP/skill usage. It requires at least five eligible sessions, keeps outcome impact explicitly unknown, and frames candidates as experiments rather than recommendations.
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

The plugin reads ccxray session metadata from `~/.ccxray/logs`, keeps onboarding and per-pane notification deduplication state under `HERDR_PLUGIN_STATE_DIR`, and talks to the local Herdr socket/CLI. It does not upload analytics. Agent requests still pass through ccxray to the provider selected by the user, as they do outside Herdr.

## Use

```bash
herdr plugin action list --plugin ccxray.herdr
herdr plugin action invoke ccxray.herdr.quick-start
herdr plugin action invoke ccxray.herdr.focus-attention
herdr plugin pane open --plugin ccxray.herdr --entrypoint mission-control --placement tab
herdr plugin pane open --plugin ccxray.herdr --entrypoint onboarding --placement tab
herdr plugin pane open --plugin ccxray.herdr --entrypoint capability-review --placement tab
```

When the badge can prove ccxray has fallen behind — a completed turn sits in the
session's Claude transcript that the index never recorded — the context row
reports `stale 11h` and drops to the neutral colour, because a confident green
would be asserting safety about a number hours out of date. The percentage
itself is still shown. Proof means a completed turn, not a newer file: Claude
Code writes `system`, `last-prompt` and `mode` records with no API request
behind them, and treating those as evidence marked 37 healthy sessions out of 41
in measurement. A session whose transcript cannot be located (codex panes, or a
cwd ccxray never recorded) is never marked. `CCXRAY_BADGE_STALE_MS` sets the
threshold (default 10 minutes).

A marked badge also fires `ccxray import --once` detached, which is the thing
that fixes it: the scan is throttled to once per 10 minutes and guarded by a
lockfile, so many panes noticing at once still produce one scan.
`CCXRAY_BADGE_IMPORT_DISABLE=1` keeps the marker but stops the rescan.

`refresh-all-badges` (the startup fan-out) runs the pane-independent `ccxray
status` and `ccxray usage` reports once and shares them with every per-pane
refresh, so each child's remaining work is its own session matching, layout
lookup, and sidebar writes. Only reports that succeeded are shared — a child
that finds its report missing recomputes its own, so a transient failure
degrades one pane instead of painting all of them. Each child is capped at 10
seconds (`CCXRAY_BADGE_CHILD_TIMEOUT_MS` overrides); a child killed at the cap
is reported as `timed out`, separately from `failed`.

The context row is width-aware. `refresh-badges` first honors `CCXRAY_HERDR_SIDEBAR_COLS`, then Herdr plugin context sidebar fields, then uses `herdr pane layout` as a width estimate. Wider sidebars show more recent turns and may append one compact signal such as `near full`, `fail 2x`, or `cache 92%`.

Context colors are mutually exclusive: unknown is neutral gray, `ctx <= 40%` is green, `40% < ctx <= 80%` is yellow, and `ctx > 80%` is red. A pane without exact ccxray identity remains unknown; the plugin never borrows telemetry from another session in the project.

Mission Control adapts from tiny panes through wide tabs. Use `Up`/`Down` or `j`/`k` to select, `Enter` to focus the exact Herdr pane, `d` to open that session in the ccxray dashboard, `f` to cycle all/attention/ready filters, `r` to refresh, `?` for help, and `q` or `Esc` to close. Selection follows pane identity across reordering and falls back to the nearest surviving row when a pane closes. A `~` prefix marks estimated cost; an unprefixed cost is exact.

`CCXRAY_MISSION_MAX_ROWS` limits visible agents and `CCXRAY_MISSION_COLS` overrides terminal width for diagnostics. Single-session capability observations are hidden by default; pass `--capabilities` only for diagnostics or use Capability Footprint. Capability Footprint uses the same movement, filter, refresh, help, and close keys; its filters are all/MCP/skills.

## Local development

```bash
herdr plugin link /path/to/ccxray/plugins/herdr --enabled
herdr plugin action invoke ccxray.herdr.doctor
CCXRAY_MISSION_ONCE=1 node bin/mission-control.js
CCXRAY_HERDR_NO_BROWSER=1 node bin/open-dashboard.js
```

Inside the ccxray repository, the plugin resolves the local `server/index.js` CLI. `CCXRAY_BIN` or `CCXRAY_BIN_JSON` can override command resolution for diagnostics.
